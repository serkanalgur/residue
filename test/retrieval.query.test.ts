/**
 * Tests for SQL query builder for hybrid retrieval.
 *
 * Verifies that buildQuery produces correct parameterised SQL and bindings,
 * and that validateScopeBind catches scope tampering.
 *
 * @module test/retrieval.query
 */

import { describe, it, expect } from "bun:test";
import { buildQuery, validateScopeBind } from "../src/retrieval/query.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { buildScopePredicate } from "../src/scope.js";

/** Default resolved scope for tests. */
function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-001",
    worktreeKey: "wk-abc123",
    branchKey: "main",
    canonicalDir: "/workspace/project",
    ...overrides,
  };
}

const DEFAULT_OPTIONS = { inject: { shareAcrossWorktrees: false } };
const SHARED_OPTIONS = { inject: { shareAcrossWorktrees: true } };

describe("buildQuery", () => {
  it("builds a basic project-scoped query with kind=all and no time filter", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "project",
      DEFAULT_OPTIONS,
      10,
    );

    expect(result.sql).toContain("FROM memory");
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("ORDER BY created_at DESC");
    expect(result.sql).toContain("LIMIT ?");
    // Scope predicate keeps named placeholders
    expect(result.sql).toContain(":pid");
    expect(result.sql).toContain(":wk");
    // Bindings include scope values + limit
    expect(result.bindings).toContain("proj-001");
    expect(result.bindings).toContain("wk-abc123");
    expect(result.bindings).toContain(10);
  });

  it("adds kind filter when kind !== 'all'", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "fact", sinceDays: null, minScore: null },
      "project",
      DEFAULT_OPTIONS,
      10,
    );

    expect(result.sql).toContain("kind = ?");
    expect(result.bindings).toContain("fact");
  });

  it("adds time filter when sinceDays is set", () => {
    const resolved = makeResolved();
    const before = Date.now();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: 7, minScore: null },
      "project",
      DEFAULT_OPTIONS,
      10,
    );

    expect(result.sql).toContain("created_at >= ?");
    // The cutoff should be roughly 7 days before now
    const cutoff = result.bindings.find(
      (b) => typeof b === "number" && b > 0 && b < before,
    ) as number | undefined;
    expect(cutoff).toBeDefined();
    if (cutoff !== undefined) {
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(before - cutoff).toBeLessThanOrEqual(sevenDaysMs + 1000);
      expect(before - cutoff).toBeGreaterThanOrEqual(sevenDaysMs - 1000);
    }
  });

  it("builds global-only query with no scope params in bindings", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "global",
      DEFAULT_OPTIONS,
      10,
    );

    expect(result.sql).toContain("scope = 'global'");
    expect(result.sql).not.toContain(":pid");
    expect(result.sql).not.toContain(":wk");
    // Only limit binding
    expect(result.bindings).toEqual([10]);
  });

  it("builds both-scope query with both global and project conditions", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "both",
      DEFAULT_OPTIONS,
      5,
    );

    expect(result.sql).toContain("scope = 'global'");
    expect(result.sql).toContain(":pid");
    expect(result.sql).toContain(":wk");
    expect(result.bindings).toContain("proj-001");
    expect(result.bindings).toContain("wk-abc123");
  });

  it("omits worktree_key when shareAcrossWorktrees is true", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "project",
      SHARED_OPTIONS,
      10,
    );

    expect(result.sql).toContain(":pid");
    expect(result.sql).not.toContain(":wk");
  });

  it("combines all filters correctly", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "decision", sinceDays: 30, minScore: null },
      "both",
      DEFAULT_OPTIONS,
      20,
    );

    expect(result.sql).toContain("scope = 'global'");
    expect(result.sql).toContain("kind = ?");
    expect(result.sql).toContain("created_at >= ?");
    expect(result.sql).toContain("LIMIT ?");
    expect(result.bindings).toContain("decision");
    expect(result.bindings).toContain(20);
  });

  it("deterministic binding order: scope keys sorted alphabetically", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "both",
      DEFAULT_OPTIONS,
      10,
    );

    // :pid sorts before :wk, so proj-001 should come before wk-abc123
    const pidIndex = result.bindings.indexOf("proj-001");
    const wkIndex = result.bindings.indexOf("wk-abc123");
    expect(pidIndex).toBeLessThan(wkIndex);
  });

  it("does not include kind filter when kind='all'", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "both",
      DEFAULT_OPTIONS,
      5,
    );

    expect(result.sql).not.toContain("kind = ?");
  });

  it("does not include time filter when sinceDays=null", () => {
    const resolved = makeResolved();
    const result = buildQuery(
      resolved,
      { kind: "all", sinceDays: null, minScore: null },
      "both",
      DEFAULT_OPTIONS,
      5,
    );

    expect(result.sql).not.toContain("created_at >= ?");
  });
});

describe("validateScopeBind", () => {
  it("passes when :pid matches resolved projectID", () => {
    const resolved = makeResolved();
    const predicate = buildScopePredicate("both", resolved, DEFAULT_OPTIONS);
    const bindings = ["proj-001", "wk-abc123"];

    expect(validateScopeBind(bindings, resolved, predicate)).toBe(true);
  });

  it("throws when :pid does not match resolved projectID", () => {
    const resolved = makeResolved();
    const predicate = buildScopePredicate("both", resolved, DEFAULT_OPTIONS);
    // Tampered binding — different project ID
    const bindings = ["proj-HACKED", "wk-abc123"];

    expect(() => validateScopeBind(bindings, resolved, predicate)).toThrow("SECURITY");
  });

  it("passes for global-only scope (no :pid)", () => {
    const resolved = makeResolved();
    const predicate = buildScopePredicate("global", resolved, DEFAULT_OPTIONS);
    const bindings: unknown[] = [];

    expect(validateScopeBind(bindings, resolved, predicate)).toBe(true);
  });

  it("passes for shareAcrossWorktrees with correct :pid", () => {
    const resolved = makeResolved();
    const predicate = buildScopePredicate("both", resolved, SHARED_OPTIONS);
    const bindings = ["proj-001"];

    expect(validateScopeBind(bindings, resolved, predicate)).toBe(true);
  });

  it("catches SQL injection in projectID", () => {
    const resolved = makeResolved({ projectID: "legit-project" });
    const predicate = buildScopePredicate("project", resolved, DEFAULT_OPTIONS);

    const tampered = ["'; DROP TABLE memory; --"];
    expect(() => validateScopeBind(tampered, resolved, predicate)).toThrow("SECURITY");
  });
});
