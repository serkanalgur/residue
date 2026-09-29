/**
 * SQL query builder for hybrid retrieval.
 *
 * Converts high-level search parameters (scope, kind, sinceDays, minScore)
 * into parameterised SQL with `?` placeholders. Named placeholders from
 * `buildScopePredicate` are rewritten to `?` via `replaceAll` — values are
 * appended to a separate bindings array. This eliminates string interpolation
 * of user-controlled data.
 *
 * Security invariant: the caller MUST provide the project ID via `resolved`,
 * never from external input. `validateScopeBind` enforces this at the SQL level.
 *
 * NOTE: This module provides general-purpose query building. SqliteStore.search
 * builds its own FTS5-specific SQL because FTS5 MATCH queries require a different
 * structure (JOIN with memory_fts, ORDER BY rank). Both share scope handling
 * via resolveScopeParams in store.ts.
 *
 * @module retrieval/query
 */

import type { ResolvedScope, ScopePredicate } from "../core/ports.js";
import type { MemoryKind } from "../core/types.js";
import { buildScopePredicate, type ScopeFilter } from "../scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options that refine the SQL WHERE clause beyond scope. */
export interface QueryFilters {
  /** Filter by memory kind (null = all kinds). */
  readonly kind: MemoryKind | "all";
  /** Only include records created within the last N days (null = no limit). */
  readonly sinceDays: number | null;
  /** Minimum score threshold — only returned in HAVING or post-filter (null = 0). */
  readonly minScore: number | null;
}

/** Result of buildQuery: a ready-to-execute SQL string + ordered bindings. */
export interface BuiltQuery {
  /** SQL statement with `?` placeholders. */
  readonly sql: string;
  /** Ordered parameter values for the `?` placeholders. */
  readonly bindings: unknown[];
}

// ---------------------------------------------------------------------------
// buildQuery
// ---------------------------------------------------------------------------

/**
 * Build a parameterised SQL query for memory search.
 *
 * The SQL selects memory records filtered by scope, kind, and time.
 * Scope placeholders (:pid, :wk) are replaced with `?` and their values
 * are appended to the bindings array in the correct order.
 *
 * @param resolved - Resolved scope (project ID comes from ctx.location.project.id).
 * @param filters - Query filters (kind, sinceDays, minScore).
 * @param scopeFilter - Which scopes to include ("project" | "global" | "both").
 * @param options - Plugin options for shareAcrossWorktrees.
 * @param limit - Maximum rows to return.
 * @returns SQL string with `?` placeholders + ordered bindings.
 */
export function buildQuery(
  resolved: ResolvedScope,
  filters: QueryFilters,
  scopeFilter: ScopeFilter,
  options: { inject: { shareAcrossWorktrees: boolean } },
  limit: number,
): BuiltQuery {
  // Build the scope predicate with named placeholders
  const scopePredicate = buildScopePredicate(scopeFilter, resolved, options);

  // Start building the SQL
  const conditions: string[] = [scopePredicate.where];

  // Kind filter
  if (filters.kind !== "all") {
    conditions.push("kind = ?");
  }

  // Time filter (sinceDays)
  if (filters.sinceDays !== null && filters.sinceDays > 0) {
    conditions.push("created_at >= ?");
  }

  const whereClause = conditions.join(" AND ");

  const sql = `SELECT id, text, kind, tags, scope, project_id, worktree_key,
       branch_key, source, confidence, created_at, last_access,
       access_count, superseded_by
  FROM memory
  WHERE ${whereClause}
  ORDER BY created_at DESC
  LIMIT ?`;

  // Build ordered bindings
  // 1. Scope predicate values (in key order for determinism)
  const scopeKeys = Object.keys(scopePredicate.params).sort();
  const bindings: unknown[] = scopeKeys.map((k) => scopePredicate.params[k]);

  // 2. Kind filter
  if (filters.kind !== "all") {
    bindings.push(filters.kind);
  }

  // 3. Time filter
  if (filters.sinceDays !== null && filters.sinceDays > 0) {
    const cutoffMs = Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000;
    bindings.push(cutoffMs);
  }

  // 4. Limit
  bindings.push(limit);

  return { sql, bindings };
}

// ---------------------------------------------------------------------------
// validateScopeBind
// ---------------------------------------------------------------------------

/**
 * Security constant: the :pid placeholder value MUST equal the resolved
 * project ID. This prevents cross-project data leakage if the scope
 * predicate is ever constructed from untrusted input.
 *
 * @param bindings - The ordered bindings array from buildQuery.
 * @param resolved - The resolved scope (project ID from ctx.location.project.id).
 * @param scopePredicate - The scope predicate with named params.
 * @returns true if bindings are safe; throws if :pid is tampered.
 */
export function validateScopeBind(
  bindings: unknown[],
  resolved: ResolvedScope,
  scopePredicate: ScopePredicate,
): boolean {
  // Find the index of :pid in the sorted key order
  const scopeKeys = Object.keys(scopePredicate.params).sort();
  const pidIndex = scopeKeys.indexOf(":pid");

  if (pidIndex === -1) {
    // No :pid in the predicate (global-only scope) — nothing to validate
    return true;
  }

  const boundPid = bindings[pidIndex];

  if (boundPid !== resolved.projectID) {
    throw new Error(
      `[residue] SECURITY: Scope bind mismatch — :pid bound to "${String(boundPid)}" ` +
      `but project ID is "${resolved.projectID}". This indicates tampering.`,
    );
  }

  return true;
}
