/**
 * `res_forget` tool — preview and delete memory records.
 *
 * Provides a two-step deletion workflow:
 * 1. Preview (confirm=false): returns matching records without deleting.
 * 2. Delete (confirm=true): removes the matched records.
 *
 * Safety guarantees:
 * - No code path can truncate the store without id + query.
 * - Preview is always shown for large match sets, even when confirm=true.
 * - Scope isolation: cross-project records are never visible or deletable.
 * - FTS5 and vector rows are cleaned up alongside the memory row.
 *
 * @module tools/forget
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { MemoryKind, MemoryRecord } from "../core/types.js";
import type { ResolvedScope } from "../core/ports.js";
import type { Logger } from "../log.js";
import { buildScopePredicate } from "../scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for res_forget (matches FORGET_TOOL_SCHEMA). */
export interface ForgetInput {
  /** Delete exactly this record by ID. */
  readonly id?: string;
  /** Find matching records by text query. */
  readonly query?: string;
  /** Scope filter. Default: "all". */
  readonly scope?: "project" | "global" | "all";
  /** Kind filter. Default: "all". */
  readonly kind?: MemoryKind | "all";
  /** Only records created within the last N days. */
  readonly sinceDays?: number;
  /** Confirm deletion. Default: false (preview only). */
  readonly confirm?: boolean;
}

/** Dependencies injected into the forget tool. */
export interface ForgetDeps {
  readonly store: MemoryStore;
  readonly embedder: Embedder | null;
  readonly resolved: ResolvedScope;
  readonly options: {
    readonly inject: {
      readonly shareAcrossWorktrees: boolean;
    };
  };
  readonly logger: Logger;
}

/** Minimal ToolContext shape used by our execute function. */
interface ToolContext {
  readonly signal?: AbortSignal;
  progress?(Update: { status: string }): Promise<void>;
}

/**
 * Threshold above which preview is always shown, even when confirm=true.
 * This prevents accidental mass deletion.
 */
const LARGE_MATCH_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate forget input.
 *
 * @param input - Raw input from the tool call.
 * @returns Error message if invalid, null if valid.
 */
export function validateForgetInput(input: ForgetInput): string | null {
  // Must have either id or query
  if (!input.id && !input.query) {
    return "Either 'id' or 'query' must be provided. Providing neither would require scanning the entire store, which is not allowed.";
  }

  // Cannot specify both id and query
  if (input.id && input.query) {
    return "Provide either 'id' or 'query', not both. Use 'id' to delete a specific record, or 'query' to find and list matching records.";
  }

  // Validate sinceDays
  if (input.sinceDays !== undefined) {
    if (!Number.isInteger(input.sinceDays) || input.sinceDays < 1 || input.sinceDays > 3650) {
      return "sinceDays must be an integer between 1 and 3650.";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Execute the res_forget tool.
 *
 * @param input - Tool input (validated against FORGET_TOOL_SCHEMA).
 * @param context - Tool context with signal and progress.
 * @param deps - Injected dependencies.
 * @returns Tool output with content string and metadata.
 */
export async function executeForget(
  input: ForgetInput,
  context: ToolContext,
  deps: ForgetDeps,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const start = Date.now();

  // Check for cancellation
  context.signal?.throwIfAborted();

  // Validate input
  const validationError = validateForgetInput(input);
  if (validationError) {
    return {
      content: validationError,
      metadata: { previewed: 0, deleted: 0, elapsedMs: Date.now() - start },
    };
  }

  const confirm = input.confirm ?? false;
  const scopeFilter = input.scope ?? "all";
  const kindFilter = input.kind ?? "all";

  await context.progress?.({ status: "Finding matching records..." });

  // Build scope predicate
  const scopePredicate = buildScopePredicateForForget(scopeFilter, deps);

  // Resolve the match set
  let matches: MemoryRecord[] = [];

  if (input.id) {
    // Direct ID lookup — must respect scope
    const record = await deps.store.get(input.id);
    if (record && matchesScopeForForget(record, scopePredicate)) {
      matches = [record];
    }
  } else if (input.query) {
    // Text search with optional kind and since filters
    matches = await findMatches(
      deps.store,
      input.query,
      scopePredicate,
      kindFilter,
      input.sinceDays,
    );
  }

  const previewedCount = matches.length;

  // Safety: empty match set
  if (previewedCount === 0) {
    return {
      content: "No matching records found. Nothing to delete.",
      metadata: { previewed: 0, deleted: 0, elapsedMs: Date.now() - start },
    };
  }

  // Safety: no id and no query = cannot proceed (already validated above)

  // Build preview output
  const preview = formatPreview(matches);

  // Large match set: always show preview, even with confirm=true
  const mustShowPreview = previewedCount > LARGE_MATCH_THRESHOLD;

  if (!confirm || mustShowPreview) {
    // Preview mode
    const header = confirm
      ? `⚠️ Large match set (${previewedCount} records). Showing preview before deletion:\n\n`
      : `Preview — ${previewedCount} record(s) would be deleted:\n\n`;
    const footer = confirm
      ? `\n\nTo proceed with deletion of these ${previewedCount} records, call res_forget again with confirm: true and the same parameters.`
      : `\n\nTo delete these records, call res_forget again with confirm: true.`;

    return {
      content: header + preview + footer,
      metadata: { previewed: previewedCount, deleted: 0, elapsedMs: Date.now() - start },
    };
  }

  // Delete mode (confirm=true, small match set)
  await context.progress?.({ status: `Deleting ${previewedCount} record(s)...` });

  const ids = matches.map((r) => r.id);
  const deletedCount = await deps.store.removeMany(ids);

  const output =
    `Deleted ${deletedCount} record(s) (previewed: ${previewedCount}).\n\n` +
    `Removed records:\n` +
    preview;

  return {
    content: output,
    metadata: { previewed: previewedCount, deleted: deletedCount, elapsedMs: Date.now() - start },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a scope predicate for the forget tool.
 *
 * Unlike the standard buildScopePredicate, forget needs to handle
 * "all" scope which includes both global and project records.
 */
function buildScopePredicateForForget(
  scope: "project" | "global" | "all",
  deps: ForgetDeps,
): ScopePredicate {
  if (scope === "all") {
    return buildScopePredicate("both", deps.resolved, deps.options);
  }
  return buildScopePredicate(scope, deps.resolved, deps.options);
}

/**
 * Check if a record matches a scope predicate (simplified check).
 *
 * For the forget tool, we use a simplified check since we need to
 * verify scope isolation at the record level.
 */
function matchesScopeForForget(
  record: MemoryRecord,
  scope: ScopePredicate,
): boolean {
  const where = scope.where;

  if (where === "scope = 'global'") {
    return record.scope === "global";
  }

  if (
    where.includes("scope = 'project'") &&
    where.includes("project_id = :pid")
  ) {
    if (record.scope !== "project") return false;
    if (record.project_id !== scope.params[":pid"]) return false;
    if (where.includes("worktree_key = :wk")) {
      return record.worktree_key === scope.params[":wk"];
    }
    return true;
  }

  // "both" scope
  if (where.includes("scope = 'global'") && where.includes("project_id = :pid")) {
    if (record.scope === "global") return true;
    if (record.project_id !== scope.params[":pid"]) return false;
    if (where.includes("worktree_key = :wk")) {
      return record.worktree_key === scope.params[":wk"];
    }
    return true;
  }

  return true;
}

/**
 * Find matching records using text search, kind filter, and since filter.
 *
 * Uses the store's search method for text matching, then applies
 * kind and since filters to narrow results.
 */
async function findMatches(
  store: MemoryStore,
  query: string,
  scope: ScopePredicate,
  kind: string,
  sinceDays: number | undefined,
): Promise<MemoryRecord[]> {
  // Search for matching records (use a generous limit)
  const searchHits = await store.search(query, null, scope, 100);

  let matches = searchHits.map((h) => h.record);

  // Apply kind filter
  if (kind !== "all") {
    matches = matches.filter((r) => r.kind === kind);
  }

  // Apply since filter
  if (sinceDays !== undefined && sinceDays > 0) {
    const cutoffMs = Date.now() - sinceDays * 86_400_000;
    matches = matches.filter((r) => r.created_at >= cutoffMs);
  }

  return matches;
}

/**
 * Format a list of records as a human-readable preview.
 *
 * @param records - Records to format.
 * @returns Formatted string.
 */
function formatPreview(records: readonly MemoryRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    const ageMs = Date.now() - record.created_at;
    const ageDays = Math.floor(ageMs / 86_400_000);
    const ageStr = ageDays === 0 ? "today" : `${ageDays}d ago`;
    const tags = record.tags.length > 0 ? ` [${record.tags.join(", ")}]` : "";
    const superseded = record.superseded_by ? ` (superseded by ${record.superseded_by.slice(0, 8)}...)` : "";

    lines.push(
      `  • ${record.id.slice(0, 8)}… [${record.kind.toUpperCase()}] ` +
      `${record.content.slice(0, 80)}${record.content.length > 80 ? "..." : ""}` +
      `${tags} — ${ageStr}${superseded}`,
    );
  }
  return lines.join("\n");
}
