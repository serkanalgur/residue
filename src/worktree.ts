/**
 * Worktree lifecycle sync — keeps store worktree keys consistent with the live worktree set.
 *
 * Subscribes to `worktree.updated` and `worktree.resolved` events from the
 * OpenCode event system. On each event, reconciles the store by demoting
 * (setting to NULL) any `worktree_key` values that are present in the store
 * but absent from the live worktree listing.
 *
 * ## Safety guarantees
 *
 * - **Never deletes**: demoting sets `worktree_key = NULL`, widening scope.
 *   The record itself is preserved.
 * - **Never mass-demotes on failure**: only a *successful* `list()` call
 *   triggers demotion. A transient API error leaves the store untouched.
 * - **Idempotent**: running the reconciler twice changes nothing the second time.
 * - **Debounced**: bursts of events are coalesced into a single reconciliation.
 * - **Scope-isolated**: only touches records matching the current project.
 *
 * ## API references
 *
 * - `ctx.event.subscribe({ signal })` → `AsyncIterable<V2Event>` (not `.on()`)
 * - `ctx.worktree.list({ projectID })` → `Promise<readonly WorktreeEntry[]>`
 * - `WorktreeEntry` has `{ directory: string; type: "root" | "worktree" }`
 * - Events: `worktree.updated` (has `data.projectID`), `worktree.resolved`
 *   (has `data.projectID` and `data.directory`)
 *
 * @module worktree
 */

import type { Logger } from "./log.js";
import type { MemoryStore } from "./core/ports.js";
import { sha256 } from "./util/hash.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal plugin context for event subscription. */
export interface WorktreeEventCtx {
  event: {
    subscribe: (opts: { signal?: AbortSignal }) => AsyncIterable<{ readonly type: string; readonly data?: Record<string, unknown> }>;
  };
}

/** Minimal worktree API shape. */
export interface WorktreeApiCtx {
  worktree: {
    list: (input: { readonly projectID: string }) => Promise<readonly { readonly directory: string }[]>;
  };
}

/** Minimal session API for resolving project IDs from events. */
export interface SessionApiCtx {
  session: {
    get: (input: { readonly sessionID: string }) => Promise<{ readonly projectID: string }>;
  };
}

/** Combined context shape needed by registerWorktreeSync. */
export interface WorktreeCtx {
  event: WorktreeEventCtx["event"];
  worktree: WorktreeApiCtx["worktree"];
  session?: SessionApiCtx["session"];
  location: {
    project: { readonly id: string };
  };
}

/** Options for the worktree sync. */
export interface WorktreeSyncOptions {
  /** Debounce interval in ms. Default: 500ms. */
  readonly debounceMs?: number;
}

// ---------------------------------------------------------------------------
// registerWorktreeSync
// ---------------------------------------------------------------------------

/**
 * Register worktree lifecycle sync.
 *
 * Subscribes to worktree events and reconciles the store on each event.
 * Returns a cleanup function that aborts the subscription.
 *
 * @param ctx - Plugin context (events, worktree API, location).
 * @param deps - Store to reconcile.
 * @param options - Sync options.
 * @param logger - Logger instance.
 * @returns Cleanup function.
 */
export function registerWorktreeSync(
  ctx: WorktreeCtx,
  deps: { readonly store: MemoryStore },
  options: WorktreeSyncOptions,
  logger: Logger,
): () => void {
  const debounceMs = options.debounceMs ?? 500;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciling = false;

  const ac = new AbortController();
  const subscription = ctx.event.subscribe({ signal: ac.signal });

  /**
   * Debounced reconciliation — coalesces rapid event bursts into a single run.
   */
  function scheduleReconcile(): void {
    if (disposed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!disposed && !reconciling) {
        reconciling = true;
        void reconcile().finally(() => {
          reconciling = false;
        });
      }
    }, debounceMs);
  }

  /**
   * Core reconciliation logic.
   *
   * 1. Call `ctx.worktree.list()` to get the live set.
   * 2. If the call throws, abort — do NOT demote anything.
   * 3. Compute worktree_keys for each live directory.
   * 4. Query the store for all distinct worktree_keys in the project.
   * 5. For each worktree_key present in the store but absent from the live set,
   *    demote records by setting worktree_key = NULL.
   */
  async function reconcile(): Promise<void> {
    try {
      const projectID = ctx.location.project.id;

      // Step 1: Get live worktree set — if this fails, we MUST NOT demote.
      let liveEntries: ReadonlyArray<{ readonly directory: string }>;
      try {
        liveEntries = await ctx.worktree.list({ projectID });
      } catch (err) {
        // Transient API failure — leave store untouched
        logger.debug(
          `[residue] worktree.list failed (suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      if (!Array.isArray(liveEntries)) {
        // Unexpected response shape — leave store untouched
        logger.debug("[residue] worktree.list returned non-array — skipping reconciliation");
        return;
      }

      // Step 2: Compute the set of live worktree_keys
      const liveWorktreeKeys = new Set<string>();
      for (const entry of liveEntries) {
        if (typeof entry?.directory === "string" && entry.directory.length > 0) {
          liveWorktreeKeys.add(sha256(entry.directory));
        }
      }

      // Step 3: Scan the store for all distinct worktree_keys in this project.
      // We scan all project records and collect unique worktree_keys.
      const projectScope = {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": projectID } as Record<string, string | null>,
      };

      const records = await deps.store.scan({ scope: projectScope, limit: 10_000 });
      const storeWorktreeKeys = new Set<string>();
      for (const record of records) {
        if (record.worktree_key && record.worktree_key.length > 0) {
          storeWorktreeKeys.add(record.worktree_key);
        }
      }

      // Step 4: Demote worktree_keys that are in the store but not in the live set
      let totalDemoted = 0;
      for (const wk of storeWorktreeKeys) {
        if (!liveWorktreeKeys.has(wk)) {
          const demoted = await deps.store.demoteWorktreeKey(projectID, wk);
          totalDemoted += demoted;
        }
      }

      if (totalDemoted > 0) {
        logger.info(
          `[residue] worktree sync: demoted ${totalDemoted} records ` +
          `(${storeWorktreeKeys.size - liveWorktreeKeys.size} orphaned worktree keys)`,
        );
      }
    } catch (err) {
      // Reconciler NEVER throws into the event loop
      logger.debug(
        `[residue] worktree reconciliation error (suppressed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Run the subscription loop
  void (async () => {
    try {
      for await (const event of subscription) {
        if (disposed) break;

        if (event.type === "worktree.updated" || event.type === "worktree.resolved") {
          scheduleReconcile();
        }
      }
    } catch (err) {
      if (!disposed) {
        logger.debug(
          `[residue] worktree subscription error (suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  })();

  // Run an initial reconciliation on startup to catch any already-stale keys
  scheduleReconcile();

  // Return cleanup function
  return () => {
    disposed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    ac.abort();
  };
}
