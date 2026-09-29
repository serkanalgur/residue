/**
 * Ingestion subscription — wires session events to the extraction pipeline.
 *
 * Listens for `session.idle` events (and optionally `session.compaction.ended`)
 * and triggers memory extraction from the session transcript.
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
 * @module ingest/subscribe
 */

import type { MemoryDraft, SourceRef } from "../core/types.js";
import type { Logger } from "../log.js";
import type { TurnBuffer } from "./buffer.js";
import type { IngestOptions, IngestDeps } from "./types.js";
import { extractMemories } from "./extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal plugin context shape for event subscription. */
export interface EventSubscribeCtx {
  event: {
    subscribe: (opts: { signal?: AbortSignal }) => {
      on: (eventType: string, handler: (payload: unknown) => void) => void;
    };
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
 * Subscribes to `session.idle` events and triggers memory extraction.
 * Returns a cleanup function that unsubscribes all listeners.
 *
 * @param ctx - Plugin context (for event subscription and session access).
 * @param deps - Injected dependencies (buffer, store, model, scope).
 * @param options - Ingestion configuration.
 * @param logger - Logger instance.
 * @param extractFn - Extract function (injectable for testing).
 * @param signal - Optional abort signal for cleanup.
 * @returns Cleanup function.
 */
export function registerIngestion(
  ctx: IngestionCtx,
  deps: SubscribeDeps,
  options: IngestOptions,
  logger: Logger,
  extractFn: typeof extractMemories = extractMemories,
  signal?: AbortSignal,
): () => void {
  // Anti-feedback loop state: per-session extraction tracking
  const sessionStates = new Map<string, SessionExtractionState>();

  function getState(sessionID: string): SessionExtractionState {
    let state = sessionStates.get(sessionID);
    if (state === undefined) {
      state = { extractionCount: 0, lastExtractionTimestamp: 0 };
      sessionStates.set(sessionID, state);
    }
    return state;
  }

  // Subscribe to events
  const subscription = ctx.event.subscribe({ signal });

  // Handler for session.idle events
  const handleIdle = (payload: unknown): void => {
    // Schedule on next tick — NEVER block the user
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
  };

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

      if (now - state.lastExtractionTimestamp < options.minIntervalMs) {
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
        signal,
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
        try {
          await deps.store.insert(draft);
          insertedCount++;
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

  subscription.on("session.idle", handleIdle);

  // Return cleanup function
  return () => {
    sessionStates.clear();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
