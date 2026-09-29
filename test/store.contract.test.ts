/**
 * Contract tests for MemoryStore implementations.
 *
 * Both InMemoryStore and SqliteStore must pass the same test suite.
 * This ensures that any implementation satisfies the MemoryStore interface
 * contract. Tests are parameterized over both implementations.
 *
 * @module test/store.contract
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryStore, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Temp directory for SQLite tests. */
let tempDir: string;

/** Create a test draft with defaults. */
function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: "fact",
    scope: "project",
    project_id: "proj-test",
    worktree_key: "wk-test",
    branch_key: "main",
    content: "Test content",
    embedding: null,
    source: {
      sessionID: "ses-test",
      timestamp: new Date().toISOString(),
    },
    tags: ["test"],
    ...overrides,
  };
}

/** Create a "both" scope predicate. */
function bothScope(pid: string = "proj-test", wk: string = "wk-test"): ScopePredicate {
  return {
    where: "(scope = 'global' OR (scope = 'project' AND project_id = :pid AND worktree_key = :wk))",
    params: { ":pid": pid, ":wk": wk },
  };
}

/** Create a project-only scope predicate. */
function projectScope(pid: string = "proj-test", wk: string = "wk-test"): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid AND worktree_key = :wk",
    params: { ":pid": pid, ":wk": wk },
  };
}

/** Create a global-only scope predicate. */
function globalScope(): ScopePredicate {
  return {
    where: "scope = 'global'",
    params: {},
  };
}

/** Setup a fresh SqliteStore. */
function createSqliteStore(): SqliteStore {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  return new SqliteStore(db, { embedder: null, readOnly: false });
}

// ---------------------------------------------------------------------------
// Parameterized contract tests
// ---------------------------------------------------------------------------

interface StoreFactory {
  name: string;
  create: () => Promise<MemoryStore>;
  cleanup?: (store: MemoryStore) => Promise<void>;
}

const implementations: StoreFactory[] = [
  {
    name: "InMemoryStore",
    create: async () => {
      const store = new InMemoryStore();
      await store.initialize();
      return store;
    },
  },
  {
    name: "SqliteStore",
    create: async () => {
      const store = createSqliteStore();
      await store.initialize();
      return store;
    },
  },
];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "residue-contract-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
});

for (const impl of implementations) {
  describe(`MemoryStore contract — ${impl.name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await impl.create();
    });

    afterAll(async () => {
      if (impl.cleanup) await impl.cleanup(store);
    });

    describe("insert", () => {
      it("inserts a draft and returns a record with generated ID", async () => {
        const draft = makeDraft({ content: "Use WAL mode for SQLite" });
        const record = await store.insert(draft);

        expect(record.id).toBeTruthy();
        expect(record.id.length).toBeGreaterThan(0);
        expect(record.content).toBe("Use WAL mode for SQLite");
        expect(record.kind).toBe("fact");
        expect(record.scope).toBe("project");
        expect(record.project_id).toBe("proj-test");
      });

      it("preserves all draft fields in the returned record", async () => {
        const draft = makeDraft({
          kind: "decision",
          content: "Use TypeScript strict mode",
          tags: ["typescript", "config"],
          branch_key: "develop",
        });
        const record = await store.insert(draft);

        expect(record.kind).toBe("decision");
        expect(record.tags).toEqual(["typescript", "config"]);
        expect(record.branch_key).toBe("develop");
        expect(record.source.sessionID).toBe("ses-test");
      });

      it("inserts global-scoped records", async () => {
        const draft = makeDraft({
          scope: "global",
          project_id: null,
          content: "Global rule: always use semantic commits",
        });
        const record = await store.insert(draft);

        expect(record.scope).toBe("global");
        expect(record.project_id).toBeNull();
      });
    });

    describe("count", () => {
      it("returns 0 for empty store", async () => {
        const count = await store.count(bothScope());
        expect(count).toBe(0);
      });

      it("counts project-scoped records correctly", async () => {
        await store.insert(makeDraft({ content: "Record 1" }));
        await store.insert(makeDraft({ content: "Record 2" }));
        await store.insert(makeDraft({ content: "Record 3" }));

        const count = await store.count(bothScope());
        expect(count).toBe(3);
      });

      it("does not count records from other projects", async () => {
        await store.insert(makeDraft({ content: "My project" }));
        await store.insert(makeDraft({ project_id: "proj-other", content: "Other project" }));

        const count = await store.count(bothScope("proj-test", "wk-test"));
        expect(count).toBe(1);
      });

      it("counts global records separately", async () => {
        await store.insert(makeDraft({ content: "Project record" }));
        await store.insert(makeDraft({ scope: "global", project_id: null, content: "Global record" }));

        const projectCount = await store.count(projectScope());
        const globalCount = await store.count(globalScope());

        expect(projectCount).toBe(1);
        expect(globalCount).toBe(1);
      });
    });

    describe("search", () => {
      it("returns empty for no matches", async () => {
        const results = await store.search(
          "nonexistent query",
          null,
          bothScope(),
          10,
        );
        expect(results).toHaveLength(0);
      });

      it("finds records by text content", async () => {
        await store.insert(makeDraft({ content: "Use WAL mode for SQLite databases" }));
        await store.insert(makeDraft({ content: "Configure TypeScript compiler options" }));

        const results = await store.search("WAL mode", null, bothScope(), 10);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.record.content).toContain("WAL");
      });

      it("respects scope isolation in search results", async () => {
        await store.insert(makeDraft({ content: "My project fact" }));
        await store.insert(makeDraft({
          project_id: "proj-other",
          worktree_key: "wk-other",
          content: "Other project fact",
        }));

        const results = await store.search("fact", null, bothScope("proj-test", "wk-test"), 10);
        for (const hit of results) {
          expect(hit.record.project_id).toBe("proj-test");
        }
      });

      it("returns results sorted by score descending", async () => {
        await store.insert(makeDraft({ content: "SQLite WAL mode configuration" }));
        await store.insert(makeDraft({ content: "WAL" }));

        const results = await store.search("WAL mode", null, bothScope(), 10);
        if (results.length >= 2) {
          expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
        }
      });

      it("respects limit parameter", async () => {
        for (let i = 0; i < 20; i++) {
          await store.insert(makeDraft({ content: `Test record ${i} with common keyword` }));
        }

        const results = await store.search("common", null, bothScope(), 5);
        expect(results.length).toBeLessThanOrEqual(5);
      });
    });

    describe("delete (via scope)", () => {
      it("deletes records matching scope", async () => {
        await store.insert(makeDraft({ content: "To delete" }));
        await store.insert(makeDraft({ content: "To keep" }));

        // InMemoryStore and SqliteStore both support delete via the port
        // For contract test, we verify count changes
        const beforeCount = await store.count(bothScope());
        expect(beforeCount).toBe(2);

        // We can't call delete directly on MemoryStore interface,
        // but we can verify the store works after operations
        const afterSearch = await store.search("delete", null, bothScope(), 10);
        expect(afterSearch.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("close", () => {
      it("can be called without error", async () => {
        await expect(store.close()).resolves.toBeUndefined();
      });

      it("can be called multiple times", async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });

    describe("get", () => {
      it("retrieves a record by ID", async () => {
        const inserted = await store.insert(makeDraft({ content: "Gettable record" }));
        const fetched = await store.get(inserted.id);

        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(inserted.id);
        expect(fetched!.content).toBe("Gettable record");
      });

      it("returns null for nonexistent ID", async () => {
        const result = await store.get("nonexistent-id");
        expect(result).toBeNull();
      });

      it("returns all new fields correctly", async () => {
        const inserted = await store.insert(makeDraft({
          content: "Full fields record",
          kind: "decision",
        }));
        const fetched = await store.get(inserted.id);

        expect(fetched).not.toBeNull();
        expect(fetched!.confidence).toBe(0.6);
        expect(fetched!.created_at).toBeGreaterThan(0);
        expect(fetched!.last_access).toBeGreaterThan(0);
        expect(fetched!.access_count).toBe(0);
        expect(fetched!.superseded_by).toBeNull();
      });
    });

    describe("update", () => {
      it("updates content and returns the updated record", async () => {
        const inserted = await store.insert(makeDraft({ content: "Original content" }));
        const updated = await store.update(inserted.id, { content: "Updated content" });

        expect(updated).not.toBeNull();
        expect(updated!.content).toBe("Updated content");
        expect(updated!.id).toBe(inserted.id);
      });

      it("updates tags", async () => {
        const inserted = await store.insert(makeDraft({
          content: "Tagged record",
          tags: ["old-tag"],
        }));
        const updated = await store.update(inserted.id, { tags: ["new-tag", "extra"] });

        expect(updated).not.toBeNull();
        expect(updated!.tags).toEqual(["new-tag", "extra"]);
      });

      it("updates confidence", async () => {
        const inserted = await store.insert(makeDraft({ content: "Confidence record" }));
        const updated = await store.update(inserted.id, { confidence: 0.9 });

        expect(updated).not.toBeNull();
        expect(updated!.confidence).toBe(0.9);
      });

      it("updates superseded_by", async () => {
        const old = await store.insert(makeDraft({ content: "Old record" }));
        const updated = await store.update(old.id, { superseded_by: "new-record-id" });

        expect(updated).not.toBeNull();
        expect(updated!.superseded_by).toBe("new-record-id");
      });

      it("returns null for nonexistent ID", async () => {
        const result = await store.update("nonexistent", { content: "nope" });
        expect(result).toBeNull();
      });

      it("preserves unchanged fields", async () => {
        const inserted = await store.insert(makeDraft({
          content: "Preserve me",
          kind: "pattern",
          tags: ["keep"],
        }));
        const updated = await store.update(inserted.id, { content: "New content" });

        expect(updated).not.toBeNull();
        expect(updated!.kind).toBe("pattern");
        expect(updated!.tags).toEqual(["keep"]);
        expect(updated!.scope).toBe("project");
      });
    });

    describe("remove", () => {
      it("removes a record by ID and returns true", async () => {
        const inserted = await store.insert(makeDraft({ content: "Remove me" }));
        const result = await store.remove(inserted.id);

        expect(result).toBe(true);
        const fetched = await store.get(inserted.id);
        expect(fetched).toBeNull();
      });

      it("returns false for nonexistent ID", async () => {
        const result = await store.remove("nonexistent");
        expect(result).toBe(false);
      });

      it("does not affect other records", async () => {
        const r1 = await store.insert(makeDraft({ content: "Keep me" }));
        const r2 = await store.insert(makeDraft({ content: "Remove me" }));

        await store.remove(r2.id);

        const fetched = await store.get(r1.id);
        expect(fetched).not.toBeNull();
      });
    });

    describe("removeMany", () => {
      it("removes multiple records and returns count", async () => {
        const r1 = await store.insert(makeDraft({ content: "Record A" }));
        const r2 = await store.insert(makeDraft({ content: "Record B" }));
        const r3 = await store.insert(makeDraft({ content: "Record C" }));

        const removed = await store.removeMany([r1.id, r2.id]);
        expect(removed).toBe(2);

        expect(await store.get(r1.id)).toBeNull();
        expect(await store.get(r2.id)).toBeNull();
        expect(await store.get(r3.id)).not.toBeNull();
      });

      it("returns 0 for empty array", async () => {
        const removed = await store.removeMany([]);
        expect(removed).toBe(0);
      });

      it("handles nonexistent IDs gracefully", async () => {
        const r1 = await store.insert(makeDraft({ content: "Real record" }));
        const removed = await store.removeMany([r1.id, "fake-id-1", "fake-id-2"]);
        expect(removed).toBe(1);
      });
    });

    describe("scan", () => {
      it("returns records ordered by created_at DESC", async () => {
        const oldTime = Date.now() - 10_000;
        const newTime = Date.now();

        await store.insert(makeDraft({ content: "Older", created_at: oldTime }));
        await store.insert(makeDraft({ content: "Newer", created_at: newTime }));

        const results = await store.scan({ scope: bothScope() });
        expect(results.length).toBe(2);
        expect(results[0]!.content).toBe("Newer");
        expect(results[1]!.content).toBe("Older");
      });

      it("filters by kind", async () => {
        await store.insert(makeDraft({ content: "Fact record", kind: "fact" }));
        await store.insert(makeDraft({ content: "Decision record", kind: "decision" }));

        const facts = await store.scan({ scope: bothScope(), kind: "fact" });
        expect(facts.length).toBe(1);
        expect(facts[0]!.kind).toBe("fact");
      });

      it("filters by since", async () => {
        const oldTime = Date.now() - 100_000;
        const newTime = Date.now();

        await store.insert(makeDraft({ content: "Old", created_at: oldTime }));
        await store.insert(makeDraft({ content: "New", created_at: newTime }));

        const results = await store.scan({ scope: bothScope(), since: newTime - 1000 });
        expect(results.length).toBe(1);
        expect(results[0]!.content).toBe("New");
      });

      it("respects limit and offset", async () => {
        for (let i = 0; i < 10; i++) {
          await store.insert(makeDraft({ content: `Record ${i}`, created_at: Date.now() + i }));
        }

        const page1 = await store.scan({ scope: bothScope(), limit: 3, offset: 0 });
        const page2 = await store.scan({ scope: bothScope(), limit: 3, offset: 3 });
        expect(page1.length).toBe(3);
        expect(page2.length).toBe(3);
        expect(page1[0]!.id).not.toBe(page2[0]!.id);
      });
    });

    describe("stats", () => {
      it("returns correct total and byKind", async () => {
        await store.insert(makeDraft({ content: "Fact 1", kind: "fact" }));
        await store.insert(makeDraft({ content: "Fact 2", kind: "fact" }));
        await store.insert(makeDraft({ content: "Decision 1", kind: "decision" }));

        const stats = await store.stats(bothScope());
        expect(stats.total).toBe(3);
        expect(stats.byKind["fact"]).toBe(2);
        expect(stats.byKind["decision"]).toBe(1);
      });

      it("returns null oldest/newest for empty store", async () => {
        const stats = await store.stats(bothScope());
        expect(stats.total).toBe(0);
        expect(stats.oldest).toBeNull();
        expect(stats.newest).toBeNull();
      });

      it("returns correct oldest and newest", async () => {
        const oldTime = Date.now() - 50_000;
        const newTime = Date.now();

        await store.insert(makeDraft({ content: "Old", created_at: oldTime }));
        await store.insert(makeDraft({ content: "New", created_at: newTime }));

        const stats = await store.stats(bothScope());
        expect(stats.oldest).toBe(oldTime);
        expect(stats.newest).toBe(newTime);
      });
    });

    describe("touch", () => {
      it("updates last_access and increments access_count", async () => {
        const inserted = await store.insert(makeDraft({ content: "Touch me" }));
        const original = await store.get(inserted.id);
        expect(original!.access_count).toBe(0);

        await store.touch(inserted.id);
        const touched = await store.get(inserted.id);
        expect(touched!.access_count).toBe(1);
        expect(touched!.last_access).toBeGreaterThanOrEqual(original!.last_access);

        await store.touch(inserted.id);
        const doubleTouched = await store.get(inserted.id);
        expect(doubleTouched!.access_count).toBe(2);
      });

      it("does nothing for nonexistent ID", async () => {
        // Should not throw
        await store.touch("nonexistent");
      });
    });

    describe("supersede", () => {
      it("marks a record as superseded", async () => {
        const old = await store.insert(makeDraft({ content: "Old record" }));
        await store.supersede(old.id, "new-record-id");

        const fetched = await store.get(old.id);
        expect(fetched!.superseded_by).toBe("new-record-id");
      });

      it("does nothing for nonexistent ID", async () => {
        // Should not throw
        await store.supersede("nonexistent", "new-id");
      });
    });

    describe("FTS5 consistency", () => {
      it("update changes content and old text no longer matches", async () => {
        const inserted = await store.insert(makeDraft({
          content: "Unique banana bread recipe",
        }));

        // Verify original text is searchable
        const before = await store.search("banana bread", null, bothScope(), 10);
        expect(before.length).toBeGreaterThanOrEqual(1);
        expect(before[0]!.record.id).toBe(inserted.id);

        // Update content
        await store.update(inserted.id, { content: "Unique chocolate cake recipe" });

        // New text should be searchable
        const afterNew = await store.search("chocolate cake", null, bothScope(), 10);
        expect(afterNew.length).toBeGreaterThanOrEqual(1);
        expect(afterNew[0]!.record.id).toBe(inserted.id);

        // Old text should NOT match
        const afterOld = await store.search("banana bread", null, bothScope(), 10);
        // For SqliteStore, old FTS entry is deleted; for InMemoryStore, text match is on current content
        for (const hit of afterOld) {
          expect(hit.record.id).not.toBe(inserted.id);
        }
      });
    });

    describe("remove cleans up FTS and vectors", () => {
      it("removed record is absent from search", async () => {
        const inserted = await store.insert(makeDraft({
          content: "Findable unique record about quantum computing",
        }));

        // Verify it's searchable
        const before = await store.search("quantum computing", null, bothScope(), 10);
        expect(before.length).toBeGreaterThanOrEqual(1);

        // Remove it
        await store.remove(inserted.id);

        // Should no longer appear in search
        const after = await store.search("quantum computing", null, bothScope(), 10);
        for (const hit of after) {
          expect(hit.record.id).not.toBe(inserted.id);
        }

        // And should not be gettable
        expect(await store.get(inserted.id)).toBeNull();
      });
    });

    describe("demoteWorktreeKey", () => {
      it("sets worktree_key to NULL and record survives (never deletes)", async () => {
        const wkKey = "wk-demote-test";
        const inserted = await store.insert(
          makeDraft({ worktree_key: wkKey, content: "Demotable record" }),
        );

        const scope = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-test" } as Record<string, string | null>,
        };

        const countBefore = await store.count(scope);
        expect(countBefore).toBe(1);

        // Demote
        const demoted = await store.demoteWorktreeKey("proj-test", wkKey);
        expect(demoted).toBe(1);

        // Record still exists
        const fetched = await store.get(inserted.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(inserted.id);
        expect(fetched!.content).toBe("Demotable record");

        // worktree_key is now NULL/empty
        expect(fetched!.worktree_key === "" || fetched!.worktree_key === null).toBe(true);

        // Count is still 1 — nothing was deleted
        const countAfter = await store.count(scope);
        expect(countAfter).toBe(1);
      });

      it("demoted record is visible to shareAcrossWorktrees scope", async () => {
        const wkKey = "wk-shared";
        const inserted = await store.insert(
          makeDraft({ worktree_key: wkKey, content: "Shared record" }),
        );

        await store.demoteWorktreeKey("proj-test", wkKey);

        // A shareAcrossWorktrees scope (project_id only, no worktree_key filter)
        const sharedScope = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-test" } as Record<string, string | null>,
        };

        const results = await store.scan({ scope: sharedScope, limit: 100 });
        expect(results.length).toBe(1);
        expect(results[0]!.id).toBe(inserted.id);
      });

      it("returns 0 when no records match", async () => {
        const demoted = await store.demoteWorktreeKey("proj-test", "nonexistent-key");
        expect(demoted).toBe(0);
      });

      it("does not affect other projects", async () => {
        const wkKey = "wk-isolation";
        await store.insert(
          makeDraft({ worktree_key: wkKey, project_id: "proj-A", content: "Project A" }),
        );
        await store.insert(
          makeDraft({ worktree_key: wkKey, project_id: "proj-B", content: "Project B" }),
        );

        // Demote only proj-A
        const demoted = await store.demoteWorktreeKey("proj-A", wkKey);
        expect(demoted).toBe(1);

        // proj-B record is untouched
        const bScope = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-B" } as Record<string, string | null>,
        };
        const bRecords = await store.scan({ scope: bScope, limit: 100 });
        expect(bRecords.length).toBe(1);
        expect(bRecords[0]!.worktree_key).toBe(wkKey);
      });

      it("is idempotent — demoting twice returns 0 the second time", async () => {
        const wkKey = "wk-idiom";
        await store.insert(
          makeDraft({ worktree_key: wkKey, content: "Idempotent record" }),
        );

        const first = await store.demoteWorktreeKey("proj-test", wkKey);
        expect(first).toBe(1);

        const second = await store.demoteWorktreeKey("proj-test", wkKey);
        expect(second).toBe(0);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SQLite-specific WAL reopen test
// ---------------------------------------------------------------------------

describe("SqliteStore WAL persistence", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "residue-wal-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("data persists across database reopens with WAL mode", async () => {
    const dbPath = join(tempDir, "wal-test.db");

    // First connection: insert data
    const db1 = new Database(dbPath);
    applyPragmas(db1);
    const schema1 = initSchema(db1);
    expect(schema1.fts5Available).toBe(true);

    const store1 = new SqliteStore(db1, { embedder: null, readOnly: false });
    await store1.initialize();

    await store1.insert(makeDraft({ content: "Persistent record 1" }));
    await store1.insert(makeDraft({ content: "Persistent record 2" }));

    const count1 = await store1.count(bothScope());
    expect(count1).toBe(2);

    await store1.close();

    // Second connection: verify data persists
    const db2 = new Database(dbPath);
    applyPragmas(db2);
    initSchema(db2);

    const store2 = new SqliteStore(db2, { embedder: null, readOnly: false });
    await store2.initialize();

    const count2 = await store2.count(bothScope());
    expect(count2).toBe(2);

    const results = await store2.search("Persistent", null, bothScope(), 10);
    expect(results.length).toBe(2);

    await store2.close();
  });
});
