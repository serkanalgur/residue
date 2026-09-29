/**
 * Tests for the res_profile tool.
 *
 * Covers:
 * - Read-only guarantee (no store mutation)
 * - Bounded scan
 * - Groups by kind
 * - Meaningful content digest
 * - Empty store returns helpful message
 *
 * @module test/tools.profile
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { executeProfile } from "../src/tools/profile.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { createLogger } from "../src/log.js";
import type { ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { buildScopePredicate } from "../src/scope.js";

const log = createLogger(false);

function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-profile-test",
    worktreeKey: "wk-profile-test",
    branchKey: "main",
    canonicalDir: "/test",
    ...overrides,
  };
}

const OPTIONS = {
  inject: { shareAcrossWorktrees: false },
};

async function makeStore(records: Array<{
  content: string;
  kind?: string;
  scope?: string;
  tags?: string[];
  accessCount?: number;
}>): Promise<InMemoryStore> {
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
      tags: rec.tags ?? [],
    };
    const inserted = await store.insert(draft);

    // Simulate access count by touching
    for (let i = 0; i < (rec.accessCount ?? 0); i++) {
      await store.touch(inserted.id);
    }
  }

  return store;
}

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe("executeProfile — read-only", () => {
  it("never inserts, updates, or deletes records", async () => {
    const store = await makeStore([
      { content: "Global preference: use tabs", scope: "global", tags: ["style"] },
      { content: "Global rule: semantic commits", scope: "global", tags: ["git"] },
    ]);

    const countBefore = await store.count({
      where: "scope = 'global'",
      params: {},
    });

    const resolved = makeResolved();
    const result = await executeProfile(
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

    const countAfter = await store.count({
      where: "scope = 'global'",
      params: {},
    });

    expect(countAfter).toBe(countBefore);
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Groups by kind
// ---------------------------------------------------------------------------

describe("executeProfile — grouping", () => {
  it("groups records by kind", async () => {
    const store = await makeStore([
      { content: "Fact 1", kind: "fact", scope: "global" },
      { content: "Fact 2", kind: "fact", scope: "global" },
      { content: "Decision 1", kind: "decision", scope: "global" },
    ]);

    const resolved = makeResolved();
    const result = await executeProfile(
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

    expect(result.content).toContain("FACT");
    expect(result.content).toContain("DECISION");
    expect(result.content).toContain("2 records"); // fact count
    expect(result.content).toContain("1 records"); // decision count
  });

  it("includes tag information", async () => {
    const store = await makeStore([
      { content: "Tagged record", scope: "global", tags: ["typescript", "config"] },
    ]);

    const resolved = makeResolved();
    const result = await executeProfile(
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

    expect(result.content).toContain("typescript");
    expect(result.content).toContain("config");
  });
});

// ---------------------------------------------------------------------------
// Bounded scan
// ---------------------------------------------------------------------------

describe("executeProfile — bounded", () => {
  it("respects maxScan parameter", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    // Insert 50 global records
    for (let i = 0; i < 50; i++) {
      await store.insert({
        kind: "fact",
        scope: "global",
        project_id: null,
        worktree_key: "global",
        branch_key: null,
        content: `Global record ${i}`,
        embedding: null,
        source: { sessionID: "test", timestamp: new Date().toISOString() },
        tags: [],
      });
    }

    const resolved = makeResolved();
    const result = await executeProfile(
      { maxScan: 10 },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS,
        logger: log,
      },
    );

    // Should only scan 10 records, not all 50
    expect(result.metadata.recordCount).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Empty store
// ---------------------------------------------------------------------------

describe("executeProfile — empty store", () => {
  it("returns helpful message for empty store", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const resolved = makeResolved();
    const result = await executeProfile(
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

    expect(result.content).toContain("No memory records found");
    expect(result.metadata.recordCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

describe("executeProfile — content digest", () => {
  it("returns a readable digest, not raw JSON", async () => {
    const store = await makeStore([
      { content: "Use TypeScript", scope: "global", tags: ["typescript"], accessCount: 5 },
      { content: "Use ESLint", scope: "global", tags: ["linting"], accessCount: 3 },
    ]);

    const resolved = makeResolved();
    const result = await executeProfile(
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

    // Should be human-readable, not JSON
    expect(result.content).not.toContain("{");
    expect(result.content).toContain("Memory Profile");
    expect(result.content).toContain("FACT");
  });

  it("shows most accessed records", async () => {
    const store = await makeStore([
      { content: "Frequently used pattern", scope: "global", tags: [], accessCount: 10 },
      { content: "Rarely used pattern", scope: "global", tags: [], accessCount: 0 },
    ]);

    const resolved = makeResolved();
    const result = await executeProfile(
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

    expect(result.content).toContain("Most accessed");
    expect(result.content).toContain("Frequently used");
  });
});
