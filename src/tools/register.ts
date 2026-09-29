/**
 * Tool registration for Residue V2 plugin.
 *
 * Registers res_search, res_add, and res_status tools under the "res"
 * namespace using the V2 `ctx.tool.transform` API.
 *
 * @module tools/register
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { ResolvedScope } from "../core/ports.js";
import type { ResidueOptions } from "../config.js";
import type { Logger } from "../log.js";
import { buildScopePredicate } from "../scope.js";
import { STATUS_TOOL_SCHEMA, SEARCH_TOOL_SCHEMA, ADD_TOOL_SCHEMA } from "./schemas.js";
import { buildStatusResponse } from "./status.js";
import { executeSearch, type SearchDeps } from "./search.js";
import { executeAdd, type AddDeps } from "./add.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies needed for tool registration. */
export interface RegisterDeps {
  /** Active memory store. */
  readonly store: MemoryStore;
  /** Embedding provider (null if unavailable). */
  readonly embedder: Embedder | null;
  /** Resolved scope context. */
  readonly resolved: ResolvedScope;
  /** SQLite driver name. */
  readonly driver: string;
  /** WAL mode enabled. */
  readonly walEnabled: boolean;
  /** FTS5 available. */
  readonly fts5Available: boolean;
  /** Store degradation info. */
  readonly storeDegraded: boolean;
  /** Data directory path. */
  readonly dataDir: string;
  /** Last injection info. */
  readonly lastInjection: { factCount: number; charCount: number };
}

/** Minimal ctx.tool.transform editor shape. */
interface ToolEditor {
  namespace(config: { name: string; description: string }): void;
  add(config: {
    name: string;
    description: string;
    input: unknown;
    options?: { namespace?: string };
    execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
  }): void;
}

/** Minimal ctx.tool.transform callback shape. */
type TransformCallback = (editor: ToolEditor) => void | Promise<void>;

/** Minimal plugin context shape for tool registration. */
interface ToolTransformCtx {
  tool: {
    transform(cb: TransformCallback): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a scope predicate for tool-level queries (count, etc.).
 */
function buildScopePredicateForTool(
  scope: "project" | "global",
  deps: RegisterDeps,
  options: ResidueOptions,
): ScopePredicate {
  const scopeFilter = scope === "global" ? "global" as const : "project" as const;
  return buildScopePredicate(scopeFilter, deps.resolved, options);
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

/**
 * Register all Residue tools under the "res" namespace.
 *
 * This function is called once during plugin setup. It registers:
 * - `res_search` — hybrid memory search
 * - `res_add` — manual memory insertion
 * - `res_status` — plugin health diagnostics
 *
 * @param ctx - Plugin context (for ctx.tool.transform).
 * @param deps - Injected dependencies (store, embedder, scope, etc.).
 * @param options - Plugin options.
 * @param logger - Logger instance.
 */
export async function registerTools(
  ctx: ToolTransformCtx,
  deps: RegisterDeps,
  options: ResidueOptions,
  logger: Logger,
): Promise<void> {
  const pluginVersion = "0.1.0";

  await ctx.tool.transform((editor) => {
    // Set up the "res" namespace
    editor.namespace({
      name: "res",
      description: "Kalici proje bellegi: arama, kaydetme, durum.",
    });

    // --- res_status ---
    editor.add({
      name: "status",
      description:
        "Check Residue plugin health, store status, embedder state, and configuration. " +
        "Returns JSON with version info, SQLite capabilities, record counts, and data directory.",
      input: STATUS_TOOL_SCHEMA,
      options: { namespace: "res" },
      execute: async (_input, _context) => {
        const response = buildStatusResponse({
          pluginVersion,
          driver: deps.driver,
          walEnabled: deps.walEnabled,
          fts5Available: deps.fts5Available,
          projectRecordCount: await deps.store.count(
            buildScopePredicateForTool("project", deps, options),
          ),
          globalRecordCount: await deps.store.count(
            buildScopePredicateForTool("global", deps, options),
          ),
          embedder: {
            id: deps.embedder?.id ?? "none",
            degraded: deps.embedder?.degraded ?? true,
            reason: deps.embedder?.reason ?? "No embedder configured",
          },
          dataDir: deps.dataDir,
          lastInjection: deps.lastInjection,
        });

        return { content: response };
      },
    });

    // --- res_search ---
    editor.add({
      name: "search",
      description:
        "Hybrid search across project memory. Combines lexical (FTS5) and vector similarity " +
        "search via Reciprocal Rank Fusion. Returns ranked results with relevance scores.",
      input: SEARCH_TOOL_SCHEMA,
      options: { namespace: "res" },
      execute: async (input, context) => {
        const searchDeps: SearchDeps = {
          store: deps.store,
          embedder: deps.embedder,
          resolved: deps.resolved,
          options,
          logger,
        };

        try {
          return await executeSearch(
            input as unknown as Parameters<typeof executeSearch>[0],
            context as unknown as Parameters<typeof executeSearch>[1],
            searchDeps,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`res_search failed: ${msg}`);
          return { content: `Search failed: ${msg}` };
        }
      },
    });

    // --- res_add ---
    editor.add({
      name: "add",
      description:
        "Add a memory record to the project memory. Requires provenance (source information). " +
        "Content is automatically embedded for vector search if an embedder is available.",
      input: ADD_TOOL_SCHEMA,
      options: { namespace: "res" },
      execute: async (input, context) => {
        const addDeps: AddDeps = {
          store: deps.store,
          embedder: deps.embedder,
          resolved: deps.resolved,
          options,
          logger,
          sessionID: "manual",
          messageID: undefined,
        };

        try {
          return await executeAdd(
            input as unknown as Parameters<typeof executeAdd>[0],
            context as unknown as Parameters<typeof executeAdd>[1],
            addDeps,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`res_add failed: ${msg}`);
          return { content: `Add failed: ${msg}` };
        }
      },
    });

    logger.info("[residue] tools registered: res_status, res_search, res_add");
  });
}
