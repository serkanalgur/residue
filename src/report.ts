/**
 * Reporting stripe — emits concise operational notes via synthetic messages.
 *
 * ## Design rules (CRITICAL)
 *
 * 1. **Default OFF.** The `report` config block has an `enabled` flag.
 *    It stays off unless explicitly enabled.
 *
 * 2. **Never called from the `context` or `prompt` hook.** A synthetic
 *    message is a turn. Emitting one on every model call doubles the turn
 *    count, which is the cost disaster this design avoids.
 *
 * 3. **Hard rate limit per session.** Enforced in code with a sliding
 *    window, not by convention.
 *
 * 4. **Never `resume: true`.** Resuming from a synthetic message risks
 *    an unbounded loop.
 *
 * 5. **Short and useful.** Content must be a brief operational note —
 *    never dump record contents into the transcript.
 *
 * 6. **When disabled, genuinely absent.** The code path must be absent,
 *    not merely a no-op — visible in the code as an early return.
 *
 * @module report
 */

import type { Logger } from "./log.js";
import type { ReportConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session-scoped rate limit state. */
interface SessionRateState {
  /** Timestamps of synthetic messages sent in the current window. */
  readonly timestamps: number[];
}

/** Dependencies for reporting. */
export interface ReportDeps {
  /** Session domain for calling ctx.session.synthetic(). */
  readonly session: {
    readonly synthetic: (input: {
      readonly sessionID: string;
      readonly text: string;
      readonly description?: string;
      readonly metadata?: Record<string, unknown>;
      readonly delivery?: "steer" | "queue";
      readonly resume?: boolean;
    }) => Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// registerReporting
// ---------------------------------------------------------------------------

/**
 * Create a reporting emitter for a given session.
 *
 * Returns a `report` function that enforces rate limits and never resumes.
 * When `report.enabled` is false, the returned function is a no-op
 * (the code path is genuinely absent — no synthetic call is attempted).
 *
 * @param config - Report configuration block.
 * @param sessionID - The session to report into.
 * @param deps - Dependencies (session domain).
 * @param logger - Logger instance.
 * @returns A `report` function, or `null` when reporting is disabled.
 */
export function createReporter(
  config: ReportConfig,
  sessionID: string,
  deps: ReportDeps,
  logger: Logger,
): ((message: string) => Promise<void>) | null {
  // PROOF: when disabled, the code path is genuinely absent.
  // The caller receives null and never calls session.synthetic().
  if (!config.enabled) {
    logger.debug("[residue] reporting disabled — no synthetic messages will be sent");
    return null;
  }

  const rateState: SessionRateState = { timestamps: [] };
  const maxPerWindow = config.maxPerSessionPer5min;
  const windowMs = 5 * 60 * 1000; // 5 minutes

  return async function report(message: string): Promise<void> {
    try {
      const now = Date.now();

      // Evict timestamps outside the sliding window
      while (
        rateState.timestamps.length > 0 &&
        rateState.timestamps[0]! < now - windowMs
      ) {
        rateState.timestamps.shift();
      }

      // Enforce rate limit
      if (rateState.timestamps.length >= maxPerWindow) {
        logger.debug(
          `[residue] report rate-limited for session ${sessionID.slice(0, 12)} — ` +
          `${rateState.timestamps.length}/${maxPerWindow} in window`,
        );
        return;
      }

      // Guard: message must be short (max 200 chars)
      const safeMessage = message.length > 200
        ? message.slice(0, 197) + "..."
        : message;

      // Emit synthetic message — NEVER resume
      await deps.session.synthetic({
        sessionID,
        text: safeMessage,
        description: "Residue operational note",
        metadata: { source: "residue.report" },
        delivery: "queue",
        resume: false,
      });

      rateState.timestamps.push(now);

      logger.debug(
        `[residue] report sent for session ${sessionID.slice(0, 12)}: ` +
        `${safeMessage.length} chars`,
      );
    } catch (err) {
      // Reporting failures must not break anything
      logger.debug(
        `[residue] report failed (suppressed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
