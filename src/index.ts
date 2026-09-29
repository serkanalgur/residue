/**
 * Residue — Persistent, local-first project memory for OpenCode.
 *
 * Phase 1: Plugin skeleton with config, logging, paths, scope, and status tool.
 * Phase 2+: Embedding, ingestion, hybrid search, context injection.
 *
 * @module index
 */

import { Plugin } from "@opencode/plugin";
import { resolveOptions } from "./config.js";
import { createLogger } from "./log.js";
import { resolveDataDir, NODE_ENV } from "./paths.js";
import { resolveScope } from "./scope.js";
import { registerTools } from "./tools/register.js";
import { registerInjection } from "./inject/index.js";
import { registerIngestion } from "./ingest/subscribe.js";
import { registerWorktreeSync } from "./worktree.js";
import { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "./ingest/buffer.js";
import { DEFAULT_INGEST_OPTIONS } from "./ingest/types.js";
import { createStore } from "./store/factory.js";
import { resolveEmbedder } from "./embed/registry.js";
import { buildScopePredicate } from "./scope.js";
import { runGlobalRetention } from "./retention.js";

/** Plugin version — kept in sync with package.json. */
const PLUGIN_VERSION = "0.1.0";

export default Plugin.define({
  id: "residue",

  async setup(ctx) {
    // Resolve plugin options with safe defaults
    const options = resolveOptions(ctx.options);

    // Create logger
    const log = createLogger(options.debug);

    log.info(`v${PLUGIN_VERSION} — initializing...`);

    // Resolve data directory using the real project directory (not process.cwd())
    let dataDir = "unknown";

    try {
      const projectID = ctx.location.project.id;
      const projectDir = ctx.location.project.directory;
      const paths = await resolveDataDir(options, projectID, projectDir, NODE_ENV, log.warn);
      dataDir = paths.base;

      // Create the real store via factory (lock, WAL, FTS5 probe, fallback chain)
      const storeResult = await createStore(paths, options, log);
      const store = storeResult.store;
      const driver = storeResult.driver;
      const storeDegraded = storeResult.degraded;

      // Resolve the embedder (auto/remote/ollama/local fallback chain)
      const resolvedEmbedder = await resolveEmbedder(options, log);

      // Resolve scope for diagnostic info and store queries
      const vcsResult = await ctx.vcs.get().catch(() => ({ data: { branch: { current: undefined, default: undefined } } }));
      const scope = await resolveScope(ctx.location, vcsResult.data);

      log.debug(`projectID=${scope.projectID} worktree=${scope.worktreeKey.slice(0, 12)}... branch=${scope.branchKey ?? "detached"}`);

      // Build scope predicates for count queries
      const projectScope = buildScopePredicate("project", scope, options);
      const globalScope = buildScopePredicate("global", scope, options);

      // Track last injection info
      const lastInjection = { factCount: 0, charCount: 0 };

      // Register all tools (res_status, res_search, res_add) via registerTools
      // This replaces the inline res_status registration that was here before.
      // schemaInfo is only on SqliteStore, not the MemoryStore interface.
      const sqliteStore = storeResult.store as import("./store/sqlite/store.js").SqliteStore | import("./store/memory-store.js").InMemoryStore;
      const fts5Available = "schemaInfo" in sqliteStore ? sqliteStore.schemaInfo.fts5 : false;

      await registerTools(
        ctx,
        {
          store,
          embedder: resolvedEmbedder.embedder,
          resolved: scope,
          driver,
          walEnabled: false, // WAL is managed by createStore
          fts5Available,
          storeDegraded,
          dataDir,
          lastInjection,
        },
        options,
        log,
      );

      log.info(
        `v${PLUGIN_VERSION} — store=${driver} ` +
        `degraded=${storeDegraded} embedder=${resolvedEmbedder.embedder?.id ?? "none"} ` +
        `embedderDegraded=${resolvedEmbedder.degraded}`,
      );

      // Register context injection (if enabled)
      const cleanupInjection = registerInjection(
        ctx,
        {
          store,
          embedder: resolvedEmbedder,
          resolved: scope,
        },
        options,
        log,
      );

      // Register worktree lifecycle sync (demotes stale worktree_key values)
      const cleanupWorktree = registerWorktreeSync(
        ctx,
        { store },
        { debounceMs: 500 },
        log,
      );

      // Enforce global row cap on startup (catches leftovers from previous sessions)
      void runGlobalRetention(store, options.retention, globalScope, log);

      // Register ingestion pipeline (session idle → extraction → store)
      const turnBuffer = createTurnBuffer(DEFAULT_BUFFER_CONFIG);
      const cleanupIngestion = registerIngestion(
        ctx,
        {
          buffer: turnBuffer,
          generateText: (opts) => ctx.generate.text(opts),
          defaultModel: async () => {
            const result = await ctx.model.default();
            const data = result?.data;
            if (!data) {
              return { id: "unknown", providerID: "unknown" };
            }
            return { id: data.modelID ?? data.id, providerID: data.providerID };
          },
          store,
          resolved: { ...scope, canonicalDir: scope.canonicalDir ?? dataDir },
          sessionGet: async ({ sessionID }: { sessionID: string }) => {
            const info = await ctx.session.get({ sessionID });
            return { projectID: info?.projectID ?? scope.projectID };
          },
        },
        DEFAULT_INGEST_OPTIONS,
        log,
      );

      // Cleanup function
      return () => {
        cleanupWorktree();
        cleanupIngestion();
        cleanupInjection();
        void store.close();
        log.info("unloaded");
      };
    } catch (err) {
      log.error(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cleanup function (fallback if initialization failed)
    return () => {
      log.info("unloaded");
    };
  },
});
