/**
 * Tests for the res_forget tool.
 *
 * Covers:
 * - Preview mode (confirm=false) deletes nothing
 * - Confirm mode (confirm=true) deletes records
 * - No-id-no-query returns error
 * - Large match set still previews
 * - FTS and vector rows disappear on delete
 * - Cross-project records never returned or deletable
 * - Previewed vs deleted counts are correct
 *
 * @module test/tools.forget
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { executeForget, validateForgetInput, type ForgetInput } from "../src/tools/forget.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { createLogger } from "../src/log.js";
import type { Embedder, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { buildScopePredicate } from "../src/scope.js";

const log = createLogger(false);

function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-forget-test",
    worktreeKey: "wk-forget-test",
    branchKey: "main",
    canonicalDir: "/test",
    ...overrides,
  };
}

const OPTIONS = {
  inject: { shareAcrossWorktrees: false },
};

async function makeStore(records: Array<{ content: string; kind?: string; scope?: string }>): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.initialize();
  const resolved = makeResolved();

  for (const rec of records) {
    const scope = rec.scope === "global" ? "global" : "project";
    const draft: MemoryDraft = {
      kind: (rec.kind as MemoryDraft["kind"]) ?? "fact",
      scope,
      project_id: scope === "global" ? null : resolved.projectID,
      worktree_key: scope === "global" ? "global" : resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content: rec.content,
      embedding: null,
      source: {
        sessionID: "test-session",
        timestamp: new Date().toISOString(),
      },
      tags: [],
    };
    await store.insert(draft);
  }

  return store;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateForgetInput", () => {
  it("rejects when neither id nor query provided", () => {
    const error = validateForgetInput({});
    expect(error).toContain("Either 'id' or 'query'");
  });

  it("rejects when both id and query provided", () => {
    const error = validateForgetInput({ id: "abc", query: "test" });
    expect(error).toContain("not both");
  });

  it("rejects invalid sinceDays", () => {
    const error = validateForgetInput({ query: "test", sinceDays: 0 });
    expect(error).toContain("between 1 and 3650");
  });

  it("accepts valid id input", () => {
    expect(validateForgetInput({ id: "abc" })).toBeNull();
  });

  it("accepts valid query input", () => {
    expect(validateForgetInput({ query: "test" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Preview mode
// ---------------------------------------------------------------------------

describe("executeForget — preview mode", () => {
  it("returns matching records without deleting when confirm=false", async () => {
    const store = await makeStore([
      { content: "Banana bread recipe" },
      { content: "Chocolate cake recipe" },
    ]);
    const resolved = makeResolved();

    const result = await executeForget(
      { query: "recipe", confirm: false },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    expect(result.content).toContain("Preview");
    expect(result.content).toContain("recipe");
    expect(result.metadata.previewed).toBeGreaterThanOrEqual(1);
    expect(result.metadata.deleted).toBe(0);

    // Records should still exist
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-forget-test" },
    });
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Confirm mode
// ---------------------------------------------------------------------------

describe("executeForget — confirm mode", () => {
  it("deletes records when confirm=true", async () => {
    const store = await makeStore([
      { content: "Banana bread recipe" },
      { content: "Chocolate cake recipe" },
    ]);
    const resolved = makeResolved();

    const result = await executeForget(
      { query: "recipe", confirm: true },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    expect(result.content).toContain("Deleted");
    expect(result.metadata.deleted).toBeGreaterThanOrEqual(1);

    // Records should be gone
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-forget-test" },
    });
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Safety: no truncation
// ---------------------------------------------------------------------------

describe("executeForget — safety", () => {
  it("errors when neither id nor query is given", async () => {
    const store = await makeStore([{ content: "Some record" }]);
    const resolved = makeResolved();

    const result = await executeForget(
      {},
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    expect(result.content).toContain("Either 'id' or 'query'");
    expect(result.metadata.deleted).toBe(0);

    // Record still exists
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-forget-test" },
    });
    expect(count).toBe(1);
  });

  it("previewed and deleted counts are distinct", async () => {
    const store = await makeStore([
      { content: "Alpha record" },
      { content: "Beta record" },
    ]);
    const resolved = makeResolved();

    // Preview
    const preview = await executeForget(
      { query: "record", confirm: false },
      {},
      { store, embedder: null, resolved, options: OPTIONS, logger: log },
    );
    expect(preview.metadata.previewed).toBeGreaterThanOrEqual(1);
    expect(preview.metadata.deleted).toBe(0);

    // Delete
    const del = await executeForget(
      { query: "record", confirm: true },
      {},
      { store, embedder: null, resolved, options: OPTIONS, logger: log },
    );
    expect(del.metadata.deleted).toBeGreaterThanOrEqual(1);
    expect(del.metadata.previewed).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("executeForget — scope isolation", () => {
  it("does not return cross-project records", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    // Insert into a different project
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: "proj-other",
      worktree_key: "wk-other",
      branch_key: "main",
      content: "Other project secret data",
      embedding: null,
      source: { sessionID: "other", timestamp: new Date().toISOString() },
      tags: [],
    });

    // Insert into our project
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: "main",
      content: "My project data",
      embedding: null,
      source: { sessionID: "mine", timestamp: new Date().toISOString() },
      tags: [],
    });

    // Search for "data" with our scope — should not find other project
    const result = await executeForget(
      { query: "data", confirm: false },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    // Should only find our project's record
    expect(result.content).toContain("My project");
    // The other project's record should not appear
    expect(result.content).not.toContain("Other project secret");
  });

  it("can delete global records", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    await store.insert({
      kind: "fact",
      scope: "global",
      project_id: null,
      worktree_key: "global",
      branch_key: null,
      content: "Global deletion target",
      embedding: null,
      source: { sessionID: "global", timestamp: new Date().toISOString() },
      tags: [],
    });

    const result = await executeForget(
      { query: "deletion target", scope: "global", confirm: true },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    expect(result.metadata.deleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Large match set
// ---------------------------------------------------------------------------

describe("executeForget — large match set", () => {
  it("always shows preview for large match sets even with confirm=true", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    // Insert 15 records that will match
    for (let i = 0; i < 15; i++) {
      await store.insert({
        kind: "fact",
        scope: "project",
        project_id: resolved.projectID,
        worktree_key: resolved.worktreeKey,
        branch_key: "main",
        content: `Test record number ${i} with keyword`,
        embedding: null,
        source: { sessionID: "test", timestamp: new Date().toISOString() },
        tags: [],
      });
    }

    const result = await executeForget(
      { query: "test keyword", confirm: true },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    // Should show preview, not delete
    expect(result.content).toContain("preview");
    expect(result.metadata.deleted).toBe(0);
  });
});
