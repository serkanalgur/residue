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
import { STATUS_TOOL_SCHEMA } from "./tools/schemas.js";
import { buildStatusResponse } from "./tools/status.js";
import { registerInjection, type InjectionCtx } from "./inject/index.js";
import { registerIngestion, type IngestionCtx } from "./ingest/subscribe.js";
import { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "./ingest/buffer.js";
import { DEFAULT_INGEST_OPTIONS } from "./ingest/types.js";

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

    // Resolve data directory
    let dataDir = "unknown";
    let driver = "unknown";
    let walEnabled = false;
    let fts5Available = false;

    try {
      const projectID = ctx.location.project.id;
      const paths = await resolveDataDir(options, projectID, NODE_ENV, log.warn);
      dataDir = paths.base;

      // Probe SQLite capabilities (Phase 2 will use the actual store)
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(":memory:");
        driver = "bun:sqlite";

        // Test WAL mode (only works with file-backed DB; in-memory uses "memory")
        // We just check that the pragma doesn't error — actual WAL requires files.
        try {
          db.prepare("PRAGMA journal_mode").get();
          walEnabled = false; // in-memory DB can't use WAL
        } catch {
          // PRAGMA not supported — unlikely but possible
        }

        // Test FTS5 availability
        try {
          db.run('CREATE VIRTUAL TABLE _residue_fts_test USING fts5(a)');
          fts5Available = true;
          db.run("DROP TABLE _residue_fts_test");
        } catch {
          fts5Available = false;
        }

        db.close();
      } catch {
        // bun:sqlite not available — try node:sqlite
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(":memory:");
          driver = "node:sqlite";

          // Test WAL mode
          const walResult = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
          db.exec("PRAGMA journal_mode=WAL");
          const walCheck = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
          walEnabled = walCheck.journal_mode === "wal";

          // Test FTS5 availability
          try {
            db.exec('CREATE VIRTUAL TABLE _residue_fts_test USING fts5(a)');
            fts5Available = true;
            db.exec("DROP TABLE _residue_fts_test");
          } catch {
            fts5Available = false;
          }

          db.close();
        } catch {
          log.warn("No SQLite driver available — store will be unavailable");
        }
      }

      // Resolve scope for diagnostic info
      // ctx.vcs.get() returns { data: { branch: { current?, default? } } }
      const vcsResult = await ctx.vcs.get().catch(() => ({ data: { branch: { current: undefined, default: undefined } } }));
      const scope = await resolveScope(ctx.location, vcsResult.data);

      log.debug(`projectID=${scope.projectID} worktree=${scope.worktreeKey.slice(0, 12)}... branch=${scope.branchKey ?? "detached"}`);

      // Register res_status tool
      await ctx.tool.transform((editor) => {
        editor.namespace({
          name: "res",
          description: "Residue memory system status and diagnostics",
        });

        editor.add({
          name: "status",
          description:
            "Check Residue plugin health, store status, embedder state, and configuration. " +
            "Returns JSON with version info, SQLite capabilities, record counts, and data directory.",
          input: STATUS_TOOL_SCHEMA,
          options: { namespace: "res" },
          execute: async (_input, _context) => {
            const response = buildStatusResponse({
              pluginVersion: PLUGIN_VERSION,
              driver,
              walEnabled,
              fts5Available,
              projectRecordCount: 0, // Phase 2: query actual store
              globalRecordCount: 0, // Phase 2: query actual store
              embedder: {
                id: "pending",
                degraded: true,
                reason: "Embedding not yet implemented (Phase 2)",
              },
              dataDir,
              lastInjection: {
                factCount: 0,
                charCount: 0,
              },
            });

            return { content: response };
          },
        });
      });

      log.info(
        `v${PLUGIN_VERSION} — store=sqlite driver=${driver} ` +
        `wal=${walEnabled} fts5=${fts5Available} embedder=pending degraded=true`,
      );

      // Register context injection (if enabled)
      const cleanupInjection = registerInjection(
        ctx as unknown as InjectionCtx,
        {
          store: null as any, // Phase 2: will be the actual store
          embedder: { embedder: null, degraded: true, reason: "pending" },
          resolved: scope,
        },
        options,
        log,
      );

      // Register ingestion pipeline (session idle → extraction → store)
      const turnBuffer = createTurnBuffer(DEFAULT_BUFFER_CONFIG);
      const cleanupIngestion = registerIngestion(
        ctx as unknown as IngestionCtx,
        {
          buffer: turnBuffer,
          generateText: async (opts) => (ctx as any).generate.text(opts),
          defaultModel: () => (ctx as any).model.default(),
          store: { insert: async () => {} }, // Phase 2: will be the actual store
          resolved: { ...scope, canonicalDir: scope.canonicalDir ?? dataDir },
          sessionGet: async ({ sessionID }: { sessionID: string }) => {
            const info = await (ctx as any).session.get({ sessionID });
            return { projectID: info?.project?.id ?? scope.projectID };
          },
        },
        DEFAULT_INGEST_OPTIONS,
        log,
      );

      // Cleanup function
      return () => {
        cleanupIngestion();
        cleanupInjection();
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
