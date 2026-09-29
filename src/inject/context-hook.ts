/**
 * Context hook — injects relevant memory notes into every model call.
 *
 * This is the core of Residue's "passive memory" feature. It runs as a
 * `context` hook on the session, which fires before EVERY model request
 * in the agent loop (including tool-driven continuations).
 *
 * ## Flow
 *
 * 1. Early exit if injection is disabled.
 * 2. Agent gate: for sub-agents (agent !== "build"), remove `res_add` from
 *    the tools map to prevent sub-agents from polluting project memory.
 * 3. Memo check: if we already retrieved facts for this (session, userMessage),
 *    reuse the cached result (no redundant retrieval).
 * 4. Locate the last user message. If none exists (tool continuation with no
 *    user message), skip injection entirely — avoids wasting tokens on
 *    retrievals that can't be meaningfully scoped.
 * 5. Extract search text from the user message (truncated to ~400 chars).
 * 6. Run hybridSearch + select (within budget).
 * 7. renderBlock → push the SystemPart into `event.system`.
 * 8. Cache the result in the memo.
 *
 * ## Error handling
 *
 * The context hook NEVER throws. Memory failures must not break model calls.
 * All errors are caught, logged as warnings, and silently skipped.
 *
 * ## Security
 *
 * - Only writes to `event.system`, NEVER to `event.messages`.
 * - `res_add` is removed for non-build agents to prevent sub-agent pollution.
 * - Provenance is enforced in renderBlock (no source → no render).
 *
 * @module inject/context-hook
 */

import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { SystemPart } from "@opencode/ai";
import type { MemoryStore, ResolvedEmbedder, ResolvedScope } from "../core/ports.js";
import type { ResidueOptions } from "../config.js";
import type { Logger } from "../log.js";
import { hybridSearch } from "../retrieval/search.js";
import { select } from "../retrieval/select.js";
import { buildScopePredicate } from "../scope.js";
import { renderBlock } from "./render.js";
import type { Memo, MemoEntry } from "./memo.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by the context hook. */
export interface ContextHookDeps {
  /** Active memory store. */
  readonly store: MemoryStore;
  /** Resolved embedder (may be null in degraded mode). */
  readonly embedder: ResolvedEmbedder;
  /** Resolved scope (project ID, worktree key, branch). */
  readonly resolved: ResolvedScope;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters to extract from the user message for search. */
const MAX_SEARCH_TEXT = 400;

/** Channel limit multiplier for hybrid search (over-fetch for fusion). */
const CHANNEL_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// registerContextHook
// ---------------------------------------------------------------------------

/**
 * Register the `context` hook on the session.
 *
 * @param ctx - Plugin context (for ctx.session.hook).
 * @param deps - Injected dependencies (store, embedder, scope).
 * @param options - Plugin options (inject config).
 * @param logger - Logger instance.
 * @param memo - Memoisation cache instance.
 * @returns Cleanup function that disposes the hook registration.
 */
export function registerContextHook(
  ctx: Pick<Plugin.Context, "session">,
  deps: ContextHookDeps,
  options: ResidueOptions,
  logger: Logger,
  memo: Memo,
): () => void {
  let disposed = false;
  let disposeHook: (() => Promise<void>) | null = null;

  // Register the hook — the 3rd arg (ModelHookOptions) is only passed
  // when providerID is explicitly configured, per the V2 type constraint.
  const hookOptions = options.inject.providerID !== undefined
    ? { providerID: options.inject.providerID }
    : undefined;

  const hookRegistration = ctx.session.hook(
    "context",
    async (event: SessionContext): Promise<void> => {
      if (disposed) return;

      try {
        await handleContextEvent(event, deps, options, logger, memo);
      } catch (err) {
        // CRITICAL: context hook must NEVER throw — memory failures must
        // not break model calls.
        logger.warn(
          `[residue] context hook error (suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    hookOptions,
  );

  // Hold the registration promise — if cleanup runs before it resolves,
  // dispose immediately when the promise settles (race-condition guard).
  hookRegistration.then(
    (reg) => {
      if (disposed) {
        // Cleanup already ran before registration settled — dispose now
        void reg.dispose().catch(() => {});
      } else {
        disposeHook = reg.dispose;
      }
    },
    (err) => {
      logger.warn(
        `[residue] failed to register context hook: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    },
  );

  return () => {
    disposed = true;
    if (disposeHook !== null) {
      void disposeHook().catch(() => {});
    }
    // If disposeHook is still null, the then() handler above will dispose
    // when the promise settles.
  };
}

// ---------------------------------------------------------------------------
// handleContextEvent
// ---------------------------------------------------------------------------

/**
 * Process a single context hook event.
 *
 * This is the core logic extracted for testability and clarity.
 */
async function handleContextEvent(
  event: SessionContext,
  deps: ContextHookDeps,
  options: ResidueOptions,
  logger: Logger,
  memo: Memo,
): Promise<void> {
  // (a) Early exit if injection is disabled
  if (!options.inject.enabled) return;

  // (b) Agent gate: sub-agents must not pollute project memory
  const agent = String(event.agent);
  if (agent !== "build") {
    delete event.tools["res_add"];
  }

  // (c) Find the last user message
  const lastUserMsg = findLastUserMessage(event.messages);
  if (lastUserMsg === null) return; // No user message → skip injection

  // (d) Build memo key from session + user message identity
  const messageID = lastUserMsg.id ?? `idx-${event.messages.indexOf(lastUserMsg)}`;
  const memoKey = `${String(event.sessionID)}:${messageID}`;

  // (e) Memo check — reuse cached result if available
  const cached = await memo.get(memoKey, async () => {
    return await retrieveAndRender(event, deps, options, logger);
  });

  if (cached === null) return; // Nothing to inject

  // (f) Push the rendered SystemPart into event.system
  // Guard: don't inject if we already have a residue.memory entry
  // (prevents duplicate injection on tool-driven continuations)
  const alreadyInjected = event.system.some(
    (part: SystemPart) => part.metadata !== undefined && (part.metadata as Record<string, unknown>).source === "residue.memory",
  );
  if (alreadyInjected) return;

  // Ensure system array exists (defensive — it should always be present)
  if (!Array.isArray(event.system)) {
    event.system = [];
  }
  event.system.push(cached.systemPart);

  // (g) Debug logging with measurements
  logger.debug(
    `[residue] inject: facts=${cached.factCount} chars=${cached.charCount} key=${memoKey}`,
  );
}

// ---------------------------------------------------------------------------
// retrieveAndRender
// ---------------------------------------------------------------------------

/**
 * Run hybrid search + select + render for the current context.
 *
 * Called by the memo on cache miss.
 */
async function retrieveAndRender(
  event: SessionContext,
  deps: ContextHookDeps,
  options: ResidueOptions,
  logger: Logger,
): Promise<MemoEntry | null> {
  const start = Date.now();

  // Extract search text from user message
  const searchText = extractSearchText(event.messages, MAX_SEARCH_TEXT);
  if (!searchText.trim()) return null;

  // Build scope predicate
  const scopePredicate = buildScopePredicate("both", deps.resolved, options);

  // Run hybrid search
  const searchOptions = {
    channelLimit: options.inject.maxFacts * CHANNEL_MULTIPLIER,
    limit: options.inject.maxFacts,
    minScore: 0, // minScore applied in select
  };

  const { hits } = await hybridSearch(
    deps.store,
    deps.embedder.embedder,
    searchText,
    searchOptions,
    { scope: scopePredicate },
    logger,
  );

  // Select best subset (within budget)
  const selected = select(hits, {
    maxFacts: options.inject.maxFacts,
    minScore: options.inject.minScore,
    maxChars: options.inject.maxChars,
  });

  // Render to SystemPart
  const rendered = renderBlock(selected, {
    maxChars: options.inject.maxChars,
    minScore: 0, // already filtered by select
  });

  if (rendered === null) return null;

  const elapsedMs = Date.now() - start;
  logger.debug(
    `[residue] retrieval: mode=search hits=${hits.length} selected=${selected.length} ` +
    `facts=${rendered.factCount} chars=${rendered.charCount} elapsed=${elapsedMs}ms`,
  );

  return {
    systemPart: rendered.part,
    factCount: rendered.factCount,
    charCount: rendered.charCount,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the last user message in the messages array.
 *
 * Iterates backwards for O(1) average case (user messages are usually recent).
 * Returns null if no user message exists (e.g., tool continuation with only
 * assistant/tool messages).
 */
function findLastUserMessage(
  messages: SessionContext["messages"],
): SessionContext["messages"][number] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "user") {
      return msg;
    }
  }
  return null;
}

/**
 * Extract searchable text from the last user message.
 *
 * Walks the content array, extracts text parts, and concatenates them
 * up to maxLen characters. Stops at sentence boundaries when possible.
 */
function extractSearchText(
  messages: SessionContext["messages"],
  maxLen: number,
): string {
  const lastUser = findLastUserMessage(messages);
  if (lastUser === null) return "";

  const parts: string[] = [];
  let totalLen = 0;

  for (const part of lastUser.content) {
    if (part.type === "text") {
      const text = part.text;
      if (totalLen + text.length <= maxLen) {
        parts.push(text);
        totalLen += text.length;
      } else {
        // Truncate at sentence boundary
        const remaining = maxLen - totalLen;
        if (remaining > 20) {
          const truncated = text.slice(0, remaining);
          const lastSentence = Math.max(
            truncated.lastIndexOf(". "),
            truncated.lastIndexOf("! "),
            truncated.lastIndexOf("? "),
          );
          if (lastSentence > remaining * 0.3) {
            parts.push(truncated.slice(0, lastSentence + 1));
          } else {
            const lastSpace = truncated.lastIndexOf(" ");
            if (lastSpace > remaining * 0.3) {
              parts.push(truncated.slice(0, lastSpace));
            } else {
              parts.push(truncated.slice(0, remaining - 3) + "...");
            }
          }
        }
        break;
      }
    }
  }

  return parts.join(" ").trim();
}
