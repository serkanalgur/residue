/**
 * Scope isolation and predicate building for Residue memory records.
 *
 * CRITICAL SECURITY MODULE: Ensures that memory records are strictly isolated
 * between projects and worktrees. The `project_id` is ALWAYS sourced from
 * `ctx.location.project.id` — never from caller input — to prevent cross-project
 * data leakage.
 *
 * @module scope
 */

import type { ResolvedScope } from "./core/ports.js";
import { sha256 } from "./util/hash.js";

/** Scope filter mode — which records are visible. */
export type ScopeFilter = "global" | "project" | "both";

/** SQL WHERE predicate for scope filtering. */
export interface ScopePredicate {
  /** SQL WHERE fragment with named placeholders. */
  readonly where: string;
  /** Bound parameters for the predicate. */
  readonly params: Record<string, string | null>;
}

/**
 * SQL predicate that selects records visible to a given scope.
 *
 * - Global records: always visible.
 * - Project records: visible only if project_id matches AND worktree_key matches
 *   (or shareAcrossWorktrees is enabled).
 *
 * IMPORTANT: This predicate uses named placeholders (:pid, :wk) to prevent SQL
 * injection. The project_id is bound from `ctx.location.project.id`, never from
 * external input.
 */
const SCOPE_PREDICATE_BOTH =
  "(scope = 'global' OR (scope = 'project' AND project_id = :pid AND worktree_key = :wk))";

const SCOPE_PREDICATE_GLOBAL_ONLY = "scope = 'global'";

const SCOPE_PREDICATE_PROJECT_ONLY =
  "scope = 'project' AND project_id = :pid AND worktree_key = :wk";

/**
 * Resolve scope context from plugin context.
 *
 * projectID is EXCLUSIVELY sourced from `ctx.location.project.id`.
 * This is a security boundary — never accept project IDs from external input.
 *
 * @param location - Plugin location from ctx.location.
 * @param vcsInfo - VCS data from ctx.vcs.get().data.
 * @returns Resolved scope with project ID, worktree key, and branch.
 */
export async function resolveScope(
  location: { directory: string; project: { id: string; directory: string; canonical: string } },
  vcsInfo: { branch?: { current?: string | null; default?: string | null } | null },
): Promise<ResolvedScope> {
  // SECURITY: projectID comes exclusively from ctx.location.project.id
  const projectID = location.project.id;

  // Worktree key is SHA-256 of the ACTUAL working directory (not canonical root).
  // This ensures different worktrees of the same project get isolated stores.
  const worktreeKey = sha256(location.directory);

  // Branch key from VCS — null if detached/unknown.
  const branchKey = vcsInfo.branch?.current ?? null;

  return {
    projectID,
    worktreeKey,
    branchKey,
    canonicalDir: location.project.canonical,
  };
}

/**
 * Build a SQL WHERE predicate for scope filtering.
 *
 * The predicate uses named SQL placeholders (:pid, :wk) to prevent injection.
 * The caller MUST bind these values from the resolved scope, NOT from user input.
 *
 * @param scopeFilter - Which scopes to include.
 * @param resolved - Resolved scope context.
 * @param options - Plugin options (for shareAcrossWorktrees).
 * @returns SQL predicate with named parameters.
 */
export function buildScopePredicate(
  scopeFilter: ScopeFilter,
  resolved: ResolvedScope,
  options: { inject: { shareAcrossWorktrees: boolean } },
): ScopePredicate {
  switch (scopeFilter) {
    case "global":
      return {
        where: SCOPE_PREDICATE_GLOBAL_ONLY,
        params: {},
      };

    case "project":
      if (options.inject.shareAcrossWorktrees) {
        // When sharing across worktrees, match project_id only (ignore worktree_key).
        return {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": resolved.projectID },
        };
      }
      return {
        where: SCOPE_PREDICATE_PROJECT_ONLY,
        params: {
          ":pid": resolved.projectID,
          ":wk": resolved.worktreeKey,
        },
      };

    case "both":
      if (options.inject.shareAcrossWorktrees) {
        return {
          where: "(scope = 'global' OR (scope = 'project' AND project_id = :pid))",
          params: { ":pid": resolved.projectID },
        };
      }
      return {
        where: SCOPE_PREDICATE_BOTH,
        params: {
          ":pid": resolved.projectID,
          ":wk": resolved.worktreeKey,
        },
      };
  }
}

/**
 * Check if a memory record matches the resolved scope.
 *
 * Pure function for testing scope logic without database interaction.
 *
 * @param record - The memory record to check.
 * @param resolved - Resolved scope context.
 * @param options - Plugin options.
 * @returns Whether the record is visible in this scope.
 */
export function matchesScope(
  record: { scope: string; project_id: string | null; worktree_key: string | null },
  resolved: ResolvedScope,
  options: { inject: { shareAcrossWorktrees: boolean } },
): boolean {
  // Global records are always visible
  if (record.scope === "global") {
    return true;
  }

  // Project records must match project ID
  if (record.project_id !== resolved.projectID) {
    return false;
  }

  // If sharing across worktrees, only project_id match is needed
  if (options.inject.shareAcrossWorktrees) {
    return true;
  }

  // Demoted records (worktree_key is null/empty) match any worktree — their scope was widened.
  if (!record.worktree_key || record.worktree_key === "") {
    return true;
  }

  // Otherwise, worktree key must match too
  return record.worktree_key === resolved.worktreeKey;
}
