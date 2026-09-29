/**
 * `res_search` tool — hybrid search across project memory.
 *
 * Combines lexical (FTS5) and vector similarity search via Reciprocal
 * Rank Fusion. Returns ranked results with metadata.
 *
 * @module tools/search
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { ResolvedScope } from "../core/ports.js";
import type { Logger } from "../log.js";
import { buildScopePredicate, type ScopeFilter } from "../scope.js";
import { hybridSearch } from "../retrieval/search.js";
import { select, type SelectOptions } from "../retrieval/select.js";
import { estimateTokens } from "../retrieval/estimate.js";
import type { AccessMeta } from "../retrieval/select.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for res_search (matches SEARCH_TOOL_SCHEMA). */
export interface SearchInput {
  readonly query: string;
  readonly scope?: "project" | "global" | "all";
  readonly kind?: "fact" | "decision" | "pattern" | "digest" | "profile" | "all";
  readonly limit?: number;
  readonly sinceDays?: number;
  readonly minScore?: number;
}

/** Dependencies injected into the search tool. */
export interface SearchDeps {
  readonly store: MemoryStore;
  readonly embedder: Embedder | null;
  readonly resolved: ResolvedScope;
  readonly options: {
    readonly inject: {
      readonly shareAcrossWorktrees: boolean;
      readonly maxChars: number;
      readonly maxFacts: number;
    };
  };
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool context type (minimal — just what we need from OpenCode)
// ---------------------------------------------------------------------------

/** Minimal ToolContext shape used by our execute function. */
interface ToolContext {
  readonly signal?: AbortSignal;
  progress?(Update: { status: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Execute the res_search tool.
 *
 * @param input - Tool input (validated against SEARCH_TOOL_SCHEMA).
 * @param context - Tool context with signal and progress.
 * @param deps - Injected dependencies (store, embedder, scope, etc.).
 * @returns Tool output with content string and metadata.
 */
export async function executeSearch(
  input: SearchInput,
  context: ToolContext,
  deps: SearchDeps,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const start = Date.now();

  // Check for cancellation
  context.signal?.throwIfAborted();

  // Report progress for potentially slow operations
  await context.progress?.({ status: "Searching memory..." });

  // Normalize inputs
  const scopeFilter: ScopeFilter = input.scope === "global" ? "global"
    : input.scope === "project" ? "project"
    : "both";

  const kind = input.kind ?? "all";
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const minScore = input.minScore ?? 0.25;
  const sinceDays = input.sinceDays ?? null;

  // Build scope predicate
  const scopePredicate = buildScopePredicate(scopeFilter, deps.resolved, deps.options);

  // Execute hybrid search
  const { hits, mode, degraded } = await hybridSearch(
    deps.store,
    deps.embedder,
    input.query,
    {
      channelLimit: limit * 3,
      limit,
      minScore: 0, // minScore applied after select
    },
    { scope: scopePredicate },
    deps.logger,
  );

  // Apply kind filter to results
  let filtered = hits;
  if (kind !== "all") {
    filtered = hits.filter((h) => h.record.kind === kind);
  }

  // Apply sinceDays filter to results
  if (sinceDays !== null && sinceDays > 0) {
    const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((h) => {
      const created = new Date(h.record.source.timestamp).getTime();
      return created >= cutoffMs;
    });
  }

  // Build access metadata map for recency decay
  const accessMap = new Map<string, AccessMeta>();
  // In-memory store doesn't track access — use defaults

  // Select best subset
  const selected = select(filtered, {
    maxFacts: deps.options.inject.maxFacts,
    minScore,
    maxChars: deps.options.inject.maxChars,
  }, accessMap);

  // Build output
  const elapsedMs = Date.now() - start;
  const count = selected.length;

  if (count === 0) {
    const output = "No matching memory records found.";
    return {
      content: output,
      metadata: { count: 0, elapsedMs, mode, degraded },
    };
  }

  // Format results
  const lines: string[] = [];
  let totalChars = 0;

  for (const hit of selected) {
    const record = hit.record;
    const tags = record.tags.length > 0 ? ` [${record.tags.join(", ")}]` : "";
    const kindLabel = record.kind.toUpperCase();
    const scoreStr = hit.score.toFixed(3);
    const est = estimateTokens(record.content);

    lines.push(
      `• [${kindLabel}] ${record.content}${tags} ` +
      `(score: ${scoreStr}, ~${est.tokens} tokens)`,
    );
    totalChars += record.content.length;
  }

  const output = lines.join("\n");

  return {
    content: output,
    metadata: {
      count,
      elapsedMs,
      mode,
      degraded,
      totalChars,
    },
  };
}
