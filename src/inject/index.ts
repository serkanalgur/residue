/**
 * Injection module — public API surface.
 *
 * Re-exports render, memo, and context hook registration.
 * The `registerInjection` function is the single entry point called
 * from the plugin's setup to wire everything together.
 *
 * @module inject
 */

export { renderBlock } from "./render.js";
export type { RenderOptions, RenderResult } from "./render.js";

export { createMemo } from "./memo.js";
export type { Memo, MemoEntry } from "./memo.js";

export { registerContextHook } from "./context-hook.js";
export type { ContextHookDeps } from "./context-hook.js";

import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ResidueOptions } from "../config.js";
import type { Logger } from "../log.js";
import type { MemoryStore, Embedder, ResolvedEmbedder, ResolvedScope } from "../core/ports.js";
import { createMemo } from "./memo.js";
import { registerContextHook } from "./context-hook.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by registerInjection. */
export interface InjectionDeps {
  /** Active memory store. */
  readonly store: MemoryStore;
  /** Resolved embedder (may be null in degraded mode). */
  readonly embedder: ResolvedEmbedder;
  /** Resolved scope (project ID, worktree key, branch). */
  readonly resolved: ResolvedScope;
}

/** Minimal plugin context shape needed for injection registration. */
export interface InjectionCtx {
  session: {
    hook: <Name extends string>(
      name: Name,
      callback: (event: unknown) => Promise<void> | void,
      options?: { providerID?: string },
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
}

// ---------------------------------------------------------------------------
// registerInjection
// ---------------------------------------------------------------------------

/**
 * Register the context injection system.
 *
 * Creates the memo cache, registers the context hook, and returns
 * a cleanup function that disposes everything.
 *
 * @param ctx - Plugin context (for ctx.session.hook).
 * @param deps - Injected dependencies (store, embedder, scope).
 * @param options - Plugin options.
 * @param logger - Logger instance.
 * @returns Cleanup function that disposes the hook registration.
 */
export function registerInjection(
  ctx: InjectionCtx,
  deps: InjectionDeps,
  options: ResidueOptions,
  logger: Logger,
): () => void {
  if (!options.inject.enabled) {
    logger.debug("[residue] injection disabled — skipping hook registration");
    return () => {};
  }

  const memo = createMemo();

  const cleanup = registerContextHook(
    ctx as unknown as Parameters<typeof registerContextHook>[0],
    deps,
    options,
    logger,
    memo,
  );

  logger.info(
    `[residue] injection registered: enabled=true maxChars=${options.inject.maxChars} ` +
    `maxFacts=${options.inject.maxFacts} minScore=${options.inject.minScore}`,
  );

  return cleanup;
}
