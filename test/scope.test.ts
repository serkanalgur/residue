/**
 * Tests for scope resolution, predicate building, and matchesScope.
 *
 * @module test/scope
 */

import { describe, it, expect } from "bun:test";
import {
  buildScopePredicate,
  matchesScope,
  type ScopeFilter,
} from "../src/scope.js";
import type { ResolvedScope } from "../src/core/ports.js";

/** Default options for test scope checks. */
const DEFAULT_SCOPE_OPTIONS = {
  inject: { shareAcrossWorktrees: false },
};

const SHARED_OPTIONS = {
  inject: { shareAcrossWorktrees: true },
};

/** Create a mock resolved scope. */
function makeScope(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-001",
    worktreeKey: "wk-abc123",
    branchKey: "main",
    canonicalDir: "/workspace/project",
    ...overrides,
  };
}

describe("buildScopePredicate", () => {
  it("produces global-only predicate for scope=global", () => {
    const pred = buildScopePredicate("global", makeScope(), DEFAULT_SCOPE_OPTIONS);
    expect(pred.where).toBe("scope = 'global'");
    expect(Object.keys(pred.params)).toHaveLength(0);
  });

  it("produces project-only predicate for scope=project with proper placeholders", () => {
    const pred = buildScopePredicate("project", makeScope(), DEFAULT_SCOPE_OPTIONS);
    expect(pred.where).toContain(":pid");
    expect(pred.where).toContain(":wk");
    expect(pred.params[":pid"]).toBe("proj-001");
    expect(pred.params[":wk"]).toBe("wk-abc123");
  });

  it("produces combined predicate for scope=both", () => {
    const pred = buildScopePredicate("both", makeScope(), DEFAULT_SCOPE_OPTIONS);
    expect(pred.where).toContain("scope = 'global'");
    expect(pred.where).toContain("project_id = :pid");
    expect(pred.where).toContain("worktree_key = :wk");
  });

  it("omits worktree_key when shareAcrossWorktrees=true", () => {
    const pred = buildScopePredicate("project", makeScope(), SHARED_OPTIONS);
    expect(pred.where).toContain(":pid");
    expect(pred.where).not.toContain(":wk");
    expect(pred.params[":pid"]).toBe("proj-001");
  });

  it("does not produce SQL injection via projectID", () => {
    const maliciousScope = makeScope({
      projectID: "'; DROP TABLE facts; --",
    });
    const pred = buildScopePredicate("project", maliciousScope, DEFAULT_SCOPE_OPTIONS);
    // The project ID is in params, not interpolated into SQL
    expect(pred.params[":pid"]).toBe("'; DROP TABLE facts; --");
    expect(pred.where).not.toContain("DROP TABLE");
  });

  it("does not produce SQL injection via worktreeKey", () => {
    const maliciousScope = makeScope({
      worktreeKey: "1' OR '1'='1",
    });
    const pred = buildScopePredicate("both", maliciousScope, DEFAULT_SCOPE_OPTIONS);
    expect(pred.params[":wk"]).toBe("1' OR '1'='1");
    expect(pred.where).not.toContain("OR '1'='1");
  });
});

describe("matchesScope", () => {
  it("always matches global records", () => {
    const record = { scope: "global", project_id: "other-project", worktree_key: "other-wk" };
    expect(matchesScope(record, makeScope(), DEFAULT_SCOPE_OPTIONS)).toBe(true);
  });

  it("matches project records with same project and worktree", () => {
    const record = { scope: "project", project_id: "proj-001", worktree_key: "wk-abc123" };
    expect(matchesScope(record, makeScope(), DEFAULT_SCOPE_OPTIONS)).toBe(true);
  });

  it("rejects project records from different project", () => {
    const record = { scope: "project", project_id: "proj-999", worktree_key: "wk-abc123" };
    expect(matchesScope(record, makeScope(), DEFAULT_SCOPE_OPTIONS)).toBe(false);
  });

  it("rejects project records from different worktree when not sharing", () => {
    const record = { scope: "project", project_id: "proj-001", worktree_key: "wk-other" };
    expect(matchesScope(record, makeScope(), DEFAULT_SCOPE_OPTIONS)).toBe(false);
  });

  it("matches project records from different worktree when sharing enabled", () => {
    const record = { scope: "project", project_id: "proj-001", worktree_key: "wk-other" };
    expect(matchesScope(record, makeScope(), SHARED_OPTIONS)).toBe(true);
  });

  it("rejects project records from different project even when sharing", () => {
    const record = { scope: "project", project_id: "proj-999", worktree_key: "wk-other" };
    expect(matchesScope(record, makeScope(), SHARED_OPTIONS)).toBe(false);
  });
});
