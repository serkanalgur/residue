/**
 * Session digest — produces a single short summary of a whole session,
 * stored as one record of kind `digest`.
 *
 * ## When it fires
 *
 * The digest is produced on `session.compacted` events, NOT on every idle.
 * Compaction is the natural boundary where a session's material has been
 * condensed — producing the digest at that point captures the session's
 * substance without the noise of intermediate turns.
 *
 * ## Why NOT in the compaction hook
 *
 * Putting memory into a compaction summary poisons the summary for every
 * future compaction of that session. The summary is what the model reads
 * when context has already been lost — injecting memories into it would
 * create a feedback loop where the compaction summary grows with each
 * compaction, defeating its purpose as a condensed representation.
 *
 * ## Anti-feedback loop
 *
 * The digest is subject to the same protections as per-idle extraction:
 * 1. **Debounce interval**: No digest within `minIntervalMs` of the last one.
 * 2. **Per-session cap**: Hard limit on digests per session.
 * 3. **Destructive buffer**: The turn buffer is cleared after digest production.
 *
 * A digest that re-triggers itself is the same failure mode as the one
 * Phase 1 already had to fix.
 *
 * ## Cost bound
 *
 * Compaction events can be frequent on long sessions. The per-session cap
 * and debounce interval bound how often a digest is produced, preventing
 * runaway LLM costs.
 *
 * @module ingest/digest
 */

import type { Logger } from "../log.js";
import type { MemoryStore, ResolvedScope, Embedder } from "../core/ports.js";
import type { MemoryDraft, SourceRef } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for digest production. */
export interface DigestConfig {
  /** Minimum interval between digests for the same session (ms). Default: 120_000 (2 min). */
  readonly minIntervalMs: number;
  /** Maximum digests per session. Default: 5. */
  readonly maxPerSession: number;
}

/** Default digest configuration. */
export const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  minIntervalMs: 120_000,
  maxPerSession: 5,
};

/** Dependencies for digest production. */
export interface DigestDeps {
  /** Memory store for inserting the digest record. */
  readonly store: MemoryStore;
  /** Resolved scope context. */
  readonly resolved: ResolvedScope;
  /** Text generation function from plugin context. */
  readonly generateText: (opts: {
    readonly prompt: string;
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string };
  }) => Promise<{ readonly text: string }>;
  /** Default model getter. */
  readonly defaultModel: () =>
    | { readonly id: string; readonly providerID: string; readonly variant?: string }
    | Promise<{ readonly id: string; readonly providerID: string; readonly variant?: string }>;
  /** Embedder for computing the digest embedding. */
  readonly embedder: Embedder | null;
}

/** Per-session tracking for anti-feedback loop. */
interface SessionDigestState {
  digestCount: number;
  lastDigestTimestamp: number;
}

// ---------------------------------------------------------------------------
// Digest prompt
// ---------------------------------------------------------------------------

/** Build a prompt that summarises a session compaction into a short digest. */
function buildDigestPrompt(compactionSummary: string | undefined): string {
  const source = compactionSummary ?? "No compaction summary available.";
  return `You are a session summariser. Produce a SHORT summary (2-4 sentences) of what this session accomplished, decided, or learned.

<session_summary>
${source}
</session_summary>

Rules:
- Be factual and concise. No prose, no filler.
- Focus on durable outcomes: decisions made, architecture chosen, problems solved.
- Do NOT include tool calls, file listings, or transient state.
- Do NOT address anyone or use persona markers.
- Return ONLY the summary text, nothing else.`;
}

// ---------------------------------------------------------------------------
// produceDigest
// ---------------------------------------------------------------------------

/**
 * Produce a session digest record from a compaction event.
 *
 * This function is:
 * - **Bounded**: only produces a digest if the debounce and cap allow it.
 * - **Idempotent**: same sessionID + same timestamp → no duplicate digests.
 * - **Never throws**: errors are caught, logged, and silently skipped.
 *
 * @param eventSessionID - The session ID from the compacted event.
 * @param deps - Dependencies (store, generate, etc.).
 * @param config - Digest configuration.
 * @param compactionSummary - The summary from the compaction result, if available.
 * @param logger - Logger instance.
 * @returns The number of digest records inserted (0 or 1).
 */
export async function produceDigest(
  eventSessionID: string,
  deps: DigestDeps,
  config: DigestConfig,
  compactionSummary: string | undefined,
  logger: Logger,
): Promise<number> {
  try {
    const now = Date.now();

    // Check against the debounce and cap — we don't have persistent state
    // across plugin restarts, so we use the store to check existing digests
    // for this session's source.
    const sourcePrefix = `digest:${eventSessionID}`;

    // Anti-feedback loop: count existing digests for this session
    const existingDigests = await deps.store.scan({
      scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": deps.resolved.projectID } },
      kind: "digest",
      limit: 100,
    });

    // Count digests sourced from this session
    const sessionDigests = existingDigests.filter(
      (r) => r.source.sessionID === eventSessionID,
    );

    if (sessionDigests.length >= config.maxPerSession) {
      logger.debug(
        `[residue] digest skipped for session ${eventSessionID.slice(0, 12)} — ` +
        `maxPerSession cap reached (${config.maxPerSession})`,
      );
      return 0;
    }

    // Debounce: check if last digest for this session was too recent
    if (sessionDigests.length > 0) {
      const lastDigest = sessionDigests[0]!; // scan returns newest first
      if (now - lastDigest.created_at < config.minIntervalMs) {
        logger.debug(
          `[residue] digest skipped for session ${eventSessionID.slice(0, 12)} — ` +
          `minIntervalMs not elapsed`,
        );
        return 0;
      }
    }

    // Generate the digest via LLM
    const prompt = buildDigestPrompt(compactionSummary);
    const model = await deps.defaultModel();
    const response = await deps.generateText({ prompt, model });

    if (!response?.text || response.text.trim().length === 0) {
      logger.debug("[residue] digest: model returned empty response");
      return 0;
    }

    const digestText = response.text.trim();

    // Skip very short digests (likely garbage)
    if (digestText.length < 20) {
      logger.debug("[residue] digest: response too short, skipping");
      return 0;
    }

    // Compute embedding if available
    let embedding: Float32Array | null = null;
    if (deps.embedder) {
      try {
        embedding = await deps.embedder.embed(digestText);
      } catch {
        // Embedding failure is non-fatal
      }
    }

    // Build the source reference — real provenance
    const source: SourceRef = {
      sessionID: eventSessionID,
      timestamp: new Date(now).toISOString(),
    };

    const draft: MemoryDraft = {
      kind: "digest",
      scope: "project",
      project_id: deps.resolved.projectID,
      worktree_key: deps.resolved.worktreeKey,
      branch_key: deps.resolved.branchKey,
      content: digestText,
      embedding,
      source,
      tags: ["session-digest"],
    };

    await deps.store.insert(draft);

    logger.info(
      `[residue] digest produced for session ${eventSessionID.slice(0, 12)}: ` +
      `${digestText.length} chars`,
    );

    return 1;
  } catch (err) {
    // NEVER THROW — graceful degradation
    logger.debug(
      `[residue] digest production failed (suppressed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}
