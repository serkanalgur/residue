/**
 * Tests for resolveScopeParams binding order correctness (finding 2d).
 *
 * Ensures that sorted keys produce the correct placeholder-to-value mapping
 * for every scope variant.
 *
 * @module test/scope-bind
 */

import { describe, it, expect } from "bun:test";
import { buildScopePredicate } from "../src/scope.js";
import type { ResolvedScope } from "../src/core/ports.js";

const RESOLVED: ResolvedScope = {
  projectID: "proj-test-bind",
  worktreeKey: "wk-test-bind",
  branchKey: "main",
  canonicalDir: "/test",
};

describe("resolveScopeParams — binding order matches placeholder order", () => {
  function resolveScopeParams(scope: { where: string; params: Record<string, string | null> }) {
    const keys = Object.keys(scope.params).sort();
    const values: (string | null)[] = [];
    let where = scope.where;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const val = scope.params[key] as string | null;
      const occurrences = where.split(key).length - 1;
      for (let j = 0; j < occurrences; j++) {
        values.push(val);
      }
      where = where.replaceAll(key, "?");
    }

    return { where, values, keys };
  }

  it("project scope — :pid placeholder binds to projectID", () => {
    const predicate = buildScopePredicate("project", RESOLVED, {
      inject: { shareAcrossWorktrees: false },
    });

    const resolved = resolveScopeParams(predicate);

    // Keys should be sorted alphabetically
    expect(resolved.keys).toEqual([":pid", ":wk"]);

    // :pid should appear first in the values (sorted key order)
    const pidIndex = resolved.where.indexOf("?");
    const wkIndex = resolved.where.indexOf("?", pidIndex + 1);

    // The first ? should bind to projectID
    expect(resolved.values[0]).toBe(RESOLVED.projectID);
    // The second ? should bind to worktreeKey
    expect(resolved.values[1]).toBe(RESOLVED.worktreeKey);

    // Verify the WHERE clause uses ? placeholders
    expect(resolved.where).not.toContain(":pid");
    expect(resolved.where).not.toContain(":wk");
    expect(resolved.where).toContain("?");
  });

  it("both scope — :pid and :wk bind in sorted order", () => {
    const predicate = buildScopePredicate("both", RESOLVED, {
      inject: { shareAcrossWorktrees: false },
    });

    const resolved = resolveScopeParams(predicate);

    expect(resolved.keys).toEqual([":pid", ":wk"]);
    expect(resolved.values[0]).toBe(RESOLVED.projectID);
    expect(resolved.values[1]).toBe(RESOLVED.worktreeKey);
  });

  it("project scope with shareAcrossWorktrees — only :pid", () => {
    const predicate = buildScopePredicate("project", RESOLVED, {
      inject: { shareAcrossWorktrees: true },
    });

    const resolved = resolveScopeParams(predicate);

    expect(resolved.keys).toEqual([":pid"]);
    expect(resolved.values).toEqual([RESOLVED.projectID]);
  });

  it("global scope — no placeholders", () => {
    const predicate = buildScopePredicate("global", RESOLVED, {
      inject: { shareAcrossWorktrees: false },
    });

    const resolved = resolveScopeParams(predicate);

    expect(resolved.keys).toEqual([]);
    expect(resolved.values).toEqual([]);
    expect(resolved.where).toBe("scope = 'global'");
  });
});
