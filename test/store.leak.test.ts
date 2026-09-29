/**
 * Scope isolation leak test.
 *
 * Generates 200 random (scope, project_id, worktree_key) combinations and
 * verifies that matchesScope never leaks records across projects.
 *
 * This is a security-critical test — if it fails, the isolation boundary is broken.
 *
 * @module test/store.leak
 */

import { describe, it, expect } from "bun:test";
import { matchesScope } from "../src/scope.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { randomBytes } from "node:crypto";

/** Generate a random project ID. */
function randomProjectId(): string {
  return `proj-${randomBytes(8).toString("hex")}`;
}

/** Generate a random worktree key. */
function randomWorktreeKey(): string {
  return `wk-${randomBytes(8).toString("hex")}`;
}

describe("scope isolation (200 random combinations)", () => {
  const options = { inject: { shareAcrossWorktrees: false } };
  const sharedOptions = { inject: { shareAcrossWorktrees: true } };

  it("no cross-project leakage without worktree sharing", () => {
    for (let i = 0; i < 200; i++) {
      // Random project IDs — guaranteed to be different
      const projectA = randomProjectId();
      const projectB = randomProjectId();
      const worktreeA = randomWorktreeKey();
      const worktreeB = randomWorktreeKey();

      const scopeA: ResolvedScope = {
        projectID: projectA,
        worktreeKey: worktreeA,
        branchKey: "main",
        canonicalDir: "/workspace/a",
      };

      const scopeB: ResolvedScope = {
        projectID: projectB,
        worktreeKey: worktreeB,
        branchKey: "main",
        canonicalDir: "/workspace/b",
      };

      // Record belongs to project A
      const recordA = {
        scope: "project" as const,
        project_id: projectA,
        worktree_key: worktreeA,
      };

      // Record belongs to project B
      const recordB = {
        scope: "project" as const,
        project_id: projectB,
        worktree_key: worktreeB,
      };

      // Security assertion: A's records MUST NOT be visible to B's scope
      expect(matchesScope(recordA, scopeB, options)).toBe(false);
      // Security assertion: B's records MUST NOT be visible to A's scope
      expect(matchesScope(recordB, scopeA, options)).toBe(false);
      // Sanity: A's records ARE visible to A's scope
      expect(matchesScope(recordA, scopeA, options)).toBe(true);
      // Sanity: B's records ARE visible to B's scope
      expect(matchesScope(recordB, scopeB, options)).toBe(true);
    }
  });

  it("no cross-project leakage with worktree sharing enabled", () => {
    for (let i = 0; i < 200; i++) {
      const projectA = randomProjectId();
      const projectB = randomProjectId();
      const worktreeA = randomWorktreeKey();
      const worktreeB = randomWorktreeKey();

      const scopeA: ResolvedScope = {
        projectID: projectA,
        worktreeKey: worktreeA,
        branchKey: "main",
        canonicalDir: "/workspace/a",
      };

      const scopeB: ResolvedScope = {
        projectID: projectB,
        worktreeKey: worktreeB,
        branchKey: "main",
        canonicalDir: "/workspace/b",
      };

      const recordA = {
        scope: "project" as const,
        project_id: projectA,
        worktree_key: worktreeA,
      };

      const recordB = {
        scope: "project" as const,
        project_id: projectB,
        worktree_key: worktreeB,
      };

      // Even with sharing, cross-project should be blocked
      expect(matchesScope(recordA, scopeB, sharedOptions)).toBe(false);
      expect(matchesScope(recordB, scopeA, sharedOptions)).toBe(false);
      // Same project, different worktrees should match with sharing
      expect(matchesScope(recordA, scopeA, sharedOptions)).toBe(true);
      expect(matchesScope(recordB, scopeB, sharedOptions)).toBe(true);
    }
  });

  it("global records are visible to all scopes", () => {
    for (let i = 0; i < 200; i++) {
      const scope: ResolvedScope = {
        projectID: randomProjectId(),
        worktreeKey: randomWorktreeKey(),
        branchKey: null,
        canonicalDir: "/workspace/x",
      };

      const globalRecord = {
        scope: "global" as const,
        project_id: null,
        worktree_key: "any",
      };

      expect(matchesScope(globalRecord, scope, options)).toBe(true);
      expect(matchesScope(globalRecord, scope, sharedOptions)).toBe(true);
    }
  });
});
