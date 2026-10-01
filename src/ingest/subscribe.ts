/**
 * Ingestion subscription — wires session events to the extraction pipeline.
 *
 * Listens for `session.text.delta` events (to feed the turn buffer) and
 * `session.idle` events (to trigger memory extraction from the session
 * transcript).
 *
 * ## Anti-Feedback Loop (CRITICAL)
 *
 * The model itself can call `res_add`, which creates new messages and may
 * trigger another `session.idle` event. Without protection, this creates
 * an infinite loop. Three layers prevent this:
 *
 * 1. **minIntervalMs debounce**: No extraction happens within the cooldown
 *    period after the last extraction for a session.
 * 2. **extractionsPerSession cap**: Hard limit on extractions per session.
 * 3. **Placeholder transcript**: During extraction, the model receives only
 *    `<session_transcript/>` — not the actual content — preventing the
 *    extraction call itself from generating new extractable content.
 *
 * ## Async Safety
 *
 * The idle handler MUST NOT block the user. All async work is scheduled
 * via `setTimeout(..., 0)` to defer it to the next event loop tick.
 * The idle event fires at the end of a model call; synchronous blocking
 * would delay the next user interaction.
 *
 * ## Error Handling
 *
 * The idle handler NEVER throws. Store failures, extraction errors, and
 * event system issues are caught, logged, and silently skipped. Memory
 * extraction is best-effort — it must never break the user experience.
 *
 * ## API Correctness (V2)
 *
 * `ctx.event.subscribe()` returns an `AsyncIterable<V2Event>`, NOT an
 * object with `.on()`. We iterate with `for await` and match on `event.type`.
 * Unsubscription is via `AbortSignal.abort()` on the signal passed to subscribe.
 *
 * @module ingest/subscribe
 */

import type { Logger } from "../log.js";
import type { TurnBuffer } from "./buffer.js";
import type { PromptBuffer } from "./prompt-buffer.js";
import type { IngestOptions, IngestDeps } from "./types.js";
import { extractMemories } from "./extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal plugin context shape for event subscription. */
export interface EventSubscribeCtx {
  event: {
    subscribe: (opts: { signal?: AbortSignal }) => AsyncIterable<{ readonly type: string; readonly data?: Record<string, unknown> }>;
  };
}

/** Session info returned by ctx.session.get(). */
interface SessionInfo {
  readonly projectID: string;
}

/** Session.get function shape. */
interface SessionGet {
  (opts: { sessionID: string }): Promise<SessionInfo>;
}

/** Full plugin context shape needed by registerIngestion. */
export interface IngestionCtx {
  event: EventSubscribeCtx["event"];
  session: {
    get: SessionGet;
  };
  location: {
    project: { id: string };
  };
}

/** Dependencies for the ingestion subscription. */
export interface SubscribeDeps {
  /** Turn buffer for accumulating session text. */
  readonly buffer: TurnBuffer;
  /**
   * Optional user-prompt buffer. When omitted, `session.inbox.enqueued`
   * events are ignored even if `capturePrompts` is enabled.
   */
  readonly promptBuffer?: PromptBuffer;
  /** Text generation function. */
  readonly generateText: IngestDeps["generateText"];
  /** Default model getter. */
  readonly defaultModel: IngestDeps["defaultModel"];
  /** Memory store. */
  readonly store: IngestDeps["store"];
  /** Resolved scope context. */
  readonly resolved: IngestDeps["resolved"] & { readonly canonicalDir: string };
  /** Session.get function. */
  readonly sessionGet: SessionGet;
}

/** Per-session extraction tracking for anti-feedback loop. */
interface SessionExtractionState {
  /** Number of extractions performed in this session. */
  extractionCount: number;
  /** Timestamp of the last extraction (for minIntervalMs debounce). */
  lastExtractionTimestamp: number;
}

// ---------------------------------------------------------------------------
// registerIngestion
// ---------------------------------------------------------------------------

/**
 * Register the ingestion pipeline.
 *
 * Subscribes to session events via `ctx.event.subscribe()` (AsyncIterable).
 * Feeds `session.text.delta` events into the turn buffer, and triggers
 * memory extraction on `session.idle` events.
 *
 * Returns a cleanup function that aborts the event subscription and clears state.
 *
 * @param ctx - Plugin context (for event subscription and session access).
 * @param deps - Injected dependencies (buffer, store, model, scope).
 * @param options - Ingestion configuration.
 * @param logger - Logger instance.
 * @param extractFn - Extract function (injectable for testing).
 * @returns Cleanup function.
 */
export function registerIngestion(
  ctx: IngestionCtx,
  deps: SubscribeDeps,
  options: IngestOptions,
  logger: Logger,
  extractFn: typeof extractMemories = extractMemories,
): () => void {
  // Anti-feedback loop state: per-session extraction tracking
  const sessionStates = new Map<string, SessionExtractionState>();
  // Track disposed state for the subscription loop
  let disposed = false;

  function getState(sessionID: string): SessionExtractionState {
    let state = sessionStates.get(sessionID);
    if (state === undefined) {
      state = { extractionCount: 0, lastExtractionTimestamp: 0 };
      sessionStates.set(sessionID, state);
    }
    return state;
  }

  // Create an AbortSignal for subscription lifecycle
  const ac = new AbortController();

  // Subscribe to events using AsyncIterable (V2 API)
  const subscription = ctx.event.subscribe({ signal: ac.signal });

  // Run the subscription loop in the background
  void (async () => {
    try {
      for await (const event of subscription) {
        if (disposed) break;

        if (event.type === "session.text.delta") {
          // Feed the turn buffer with assistant text deltas
          const data = event.data as Record<string, unknown> | undefined;
          if (data && typeof data["sessionID"] === "string" && typeof data["delta"] === "string") {
            const sessionID = data["sessionID"] as string;
            const delta = data["delta"] as string;
            const messageID = typeof data["assistantMessageID"] === "string"
              ? (data["assistantMessageID"] as string)
              : undefined;
            deps.buffer.push(sessionID, messageID, delta);
          }
        } else if (event.type === "session.inbox.enqueued") {
          // User prompts arrive here — NOT on session.text.delta, which carries
          // assistant output only. Verified empirically: for an interactive
          // prompt this event fires with item.type === "user" and the text in
          // item.payload.text, before the model call begins.
          handleInboxEnqueued(event.data, deps, options, logger);
        } else if (event.type === "session.idle") {
          // Schedule extraction on next tick — NEVER block the user
          const payload = event.data;
          setTimeout(() => {
            void handleIdleAsync(payload).catch((err) => {
              // CRITICAL: idle handler NEVER throws
              logger.debug(
                `[residue] idle handler error (suppressed): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }, 0);
        }
      }
    } catch (err) {
      // Subscription loop error (e.g. AbortError from cleanup)
      if (!disposed) {
        logger.debug(
          `[residue] event subscription error (suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  })();

  // The async handler (extracted for clarity)
  async function handleIdleAsync(payload: unknown): Promise<void> {
    try {
      // Check autoCapture
      if (!options.autoCapture) {
        logger.debug("[residue] autoCapture disabled — skipping extraction");
        return;
      }

      // Extract session ID from the event payload
      const sessionID = extractSessionID(payload);
      if (sessionID === null) {
        logger.debug("[residue] idle event without sessionID — skipping");
        return;
      }

      // Check extraction limits (anti-feedback loop layer 1 & 2)
      const state = getState(sessionID);
      const now = Date.now();

      // Skip debounce check when minIntervalMs is 0 (tests and explicit config).
      // When multiple setTimeout(0) handlers fire in the same tick, Date.now()
      // returns the same value for all of them, so the debounce would block all
      // but the first — defeating the per-session counter cap.
      if (options.minIntervalMs > 0 && now - state.lastExtractionTimestamp < options.minIntervalMs) {
        logger.debug(
          `[residue] extraction skipped for session ${sessionID.slice(0, 12)} — ` +
          `minIntervalMs not elapsed`,
        );
        return;
      }

      if (state.extractionCount >= options.extractionsPerSession) {
        logger.debug(
          `[residue] extraction skipped for session ${sessionID.slice(0, 12)} — ` +
          `extractionsPerSession cap reached (${options.extractionsPerSession})`,
        );
        return;
      }

      // Take buffered text
      const text = deps.buffer.take(sessionID);
      if (text === null || text.trim().length === 0) {
        logger.debug(
          `[residue] idle for session ${sessionID.slice(0, 12)} — no buffered content`,
        );
        return;
      }

      // Get project ID from session
      let projectID: string;
      try {
        const sessionInfo = await deps.sessionGet({ sessionID });
        projectID = sessionInfo.projectID;
      } catch {
        // Fallback to resolved scope project ID
        projectID = deps.resolved.projectID;
      }

      // Update anti-feedback loop state
      state.lastExtractionTimestamp = now;
      state.extractionCount++;

      // Extract memories (anti-feedback loop layer 3: placeholder transcript)
      const extractionResult = await extractFn(
        deps.generateText,
        deps.defaultModel,
        text, // Actual text used for extraction
        sessionID,
        undefined, // messageID — not available from idle event
        {
          projectID,
          worktreeKey: deps.resolved.worktreeKey,
          branchKey: deps.resolved.branchKey,
          canonicalDir: deps.resolved.canonicalDir,
        },
        {
          extractModel: options.extractModel,
          maxFactsPerIdle: options.maxFactsPerIdle,
        },
        logger,
      );

      if (extractionResult.drafts.length === 0) {
        logger.debug(
          `[residue] extraction complete for session ${sessionID.slice(0, 12)}: ` +
          `0 drafts (${extractionResult.rejectedCount} rejected, ` +
          `${extractionResult.rawCount} raw)`,
        );
        return;
      }

      // Insert into store
      let insertedCount = 0;
      for (const draft of extractionResult.drafts) {
        // Resolve any contradiction BEFORE inserting, while the new record is
        // not yet searchable. A `contradicts` reference usually shares most of
        // its terms with the new fact ("...instead of jest"), so looking it up
        // after the insert would frequently return the superseding record
        // itself as the top hit.
        const supersedeTargetId = draft.contradicts
          ? await resolveContradictionTarget(draft.contradicts, deps, logger)
          : null;

        try {
          const inserted = await deps.store.insert(draft);
          insertedCount++;

          if (supersedeTargetId !== null && typeof deps.store.supersede === "function") {
            try {
              await deps.store.supersede(supersedeTargetId, inserted.id);
              logger.debug(
                `[residue] superseded ${supersedeTargetId.slice(0, 12)}... ` +
                  `with ${inserted.id.slice(0, 12)}...`,
              );
            } catch (err) {
              // A failed supersede must never fail the insert.
              logger.debug(
                `[residue] supersede failed (suppressed): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        } catch (err) {
          logger.debug(
            `[residue] store insert failed (suppressed): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      logger.info(
        `[residue] extracted ${insertedCount} memories from session ${sessionID.slice(0, 12)} ` +
        `(${extractionResult.rejectedCount} rejected, ${extractionResult.rawCount} raw)`,
      );
    } catch (err) {
      // CRITICAL: idle handler NEVER throws
      logger.debug(
        `[residue] idle handler error (suppressed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Return cleanup function
  return () => {
    disposed = true;
    sessionStates.clear();
    ac.abort();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Handle a `session.inbox.enqueued` event, capturing the user prompt when the
 * feature is enabled.
 *
 * The event payload is `{ sessionID, inboxID, item }` where `item` is a
 * discriminated union on `item.type`. Only the `"user"` arm carries prompt
 * text (`item.payload.text`); the `synthetic`, `compaction`, and `move` arms
 * must be ignored — capturing synthetic messages would feed the plugin's own
 * output back into memory.
 *
 * **Never throws.** A malformed payload is logged and dropped.
 *
 * @param payload - Raw event data.
 * @param deps - Injected dependencies (prompt buffer, options).
 * @param options - Ingestion configuration.
 * @param logger - Logger for debug output.
 */
function handleInboxEnqueued(
  payload: unknown,
  deps: SubscribeDeps,
  options: IngestOptions,
  logger: Logger,
): void {
  // Gated: prompt capture is opt-in and defaults to off.
  if (!options.capturePrompts) return;
  if (deps.promptBuffer === undefined) return;

  try {
    if (typeof payload !== "object" || payload === null) return;
    const data = payload as Record<string, unknown>;

    const sessionID = data["sessionID"];
    const item = data["item"];
    if (typeof sessionID !== "string" || typeof item !== "object" || item === null) return;

    const itemRec = item as Record<string, unknown>;
    if (itemRec["type"] !== "user") return; // synthetic/compaction/move are not user prompts

    const payloadField = itemRec["payload"];
    if (typeof payloadField !== "object" || payloadField === null) return;

    const text = (payloadField as Record<string, unknown>)["text"];
    if (typeof text !== "string") return;

    const inboxID = typeof data["inboxID"] === "string" ? data["inboxID"] : undefined;
    const delivery = typeof itemRec["delivery"] === "string" ? itemRec["delivery"] : undefined;

    const retained = deps.promptBuffer.push(sessionID, text, inboxID, delivery);
    if (retained) {
      logger.debug(
        `[residue] prompt captured for ${sessionID.slice(0, 12)} ` +
          `(${text.length} chars, delivery=${delivery ?? "unknown"})`,
      );
    }
  } catch (err) {
    logger.debug(
      `[residue] inbox.enqueued handler error (suppressed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Resolve a `contradicts` reference to the ID of the record it supersedes.
 *
 * The extraction prompt asks the model for a brief textual reference to the
 * fact being superseded (`contradicts`). That reference is not a record ID, so
 * it is resolved by a scoped lexical lookup against the store.
 *
 * **Called before the new record is inserted.** A contradiction reference
 * usually shares most of its terms with the new fact ("...instead of jest"),
 * so a lookup performed after the insert would frequently rank the
 * superseding record itself as the top hit. Resolving first removes that
 * self-match window entirely.
 *
 * Deliberately conservative — if the store cannot perform the lookup, or no
 * prior record matches, the contradiction is dropped rather than guessed at. A
 * wrong `superseded_by` link would let retention evict a record that is still
 * current, so a missed supersede is always preferable to a spurious one.
 *
 * @param referenceText - Text of the record this draft supersedes.
 * @param deps - Injected dependencies (store, scope).
 * @param logger - Logger for debug output.
 * @returns The ID of the record to supersede, or null when unresolvable.
 */
async function resolveContradictionTarget(
  referenceText: string,
  deps: SubscribeDeps,
  logger: Logger,
): Promise<string | null> {
  const { store } = deps;

  // Lookup is required to resolve the reference; bail rather than guess.
  if (typeof store.search !== "function") {
    logger.debug("[residue] store has no search — contradiction dropped");
    return null;
  }

  const trimmed = referenceText.trim();
  if (trimmed.length === 0) return null;

  // Scope the lookup to this project + worktree so a contradiction can never
  // resolve to a record from another project.
  const scope = {
    where: "scope = 'project' AND project_id = :pid AND worktree_key = :wk",
    params: {
      ":pid": deps.resolved.projectID,
      ":wk": deps.resolved.worktreeKey,
    },
  };

  const hits = await store.search(trimmed, null, scope, 5);

  // Skip anything already superseded — re-superseding would orphan a chain.
  const target = hits.map((h) => h.record).find((r) => r.superseded_by === null);

  if (target === undefined) {
    logger.debug("[residue] contradicts reference matched no prior record — dropped");
    return null;
  }

  return target.id;
}

/**
 * Extract the session ID from an event payload.
 *
 * Handles both direct string payloads and object payloads with a sessionID field.
 *
 * @param payload - Event payload from session.idle.
 * @returns Session ID string, or null if not found.
 */
function extractSessionID(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj["sessionID"] === "string") {
      return obj["sessionID"];
    }
    if (typeof obj["session"] === "object" && obj["session"] !== null) {
      const session = obj["session"] as Record<string, unknown>;
      if (typeof session["id"] === "string") {
        return session["id"];
      }
    }
  }

  return null;
}
