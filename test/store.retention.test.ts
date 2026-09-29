/**
 * Retention policy tests for MemoryStore implementations.
 *
 * Tests TTL-based retention (delete records older than a threshold),
 * LRU-based retention (keep only the N most recent), and capacity limits.
 *
 * @module test/store.retention
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryStore, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import { newId } from "../src/util/ids.js";

/** Create a test draft. */
function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: "fact",
    scope: "project",
    project_id: "proj-retention",
    worktree_key: "wk-retention",
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

/** Create a scope predicate for retention tests. */
function retentionScope(): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid",
    params: { ":pid": "proj-retention" },
  };
}

/** Insert a record with a specific created_at timestamp (raw SQL). */
function insertOldRecord(
  db: Database,
  content: string,
  createdAtMs: number,
  projectId: string = "proj-retention",
  worktreeKey: string = "wk-retention",
): string {
  const id = newId();
  db.run(
    `INSERT INTO memory (id, text, kind, tags, scope, project_id, worktree_key,
     branch_key, source, confidence, created_at, last_access, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.6, ?, ?, 0)`,
    [
      id,
      content,
      "fact",
      "[]",
      "project",
      projectId,
      worktreeKey,
      "main",
      JSON.stringify({ sessionID: "ses-test", timestamp: new Date(createdAtMs).toISOString() }),
      createdAtMs,
      createdAtMs,
    ],
  );
  return id;
}

/** Setup a fresh SqliteStore. */
function createSqliteStore(): { store: SqliteStore; db: Database } {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  const store = new SqliteStore(db, { embedder: null, readOnly: false });
  return { store, db };
}

// ---------------------------------------------------------------------------
// Parameterized retention tests
// ---------------------------------------------------------------------------

interface StoreFactory {
  name: string;
  create: () => Promise<{ store: MemoryStore; db?: Database }>;
}

const implementations: StoreFactory[] = [
  {
    name: "InMemoryStore",
    create: async () => {
      const store = new InMemoryStore();
      await store.initialize();
      return { store };
    },
  },
  {
    name: "SqliteStore",
    create: async () => {
      const { store, db } = createSqliteStore();
      await store.initialize();
      return { store, db };
    },
  },
];

for (const impl of implementations) {
  describe(`Retention policies — ${impl.name}`, () => {
    let store: MemoryStore;
    let db: Database | undefined;

    beforeEach(async () => {
      const result = await impl.create();
      store = result.store;
      db = result.db;
    });

    describe("TTL retention", () => {
      it("deletes records older than maxAgeMs", async () => {
        const oldMs = Date.now() - 100_000; // 100 seconds ago
        const newMs = Date.now(); // now

        if (db) {
          // SqliteStore: insert with old created_at via raw SQL
          insertOldRecord(db, "old-record-1", oldMs);
          insertOldRecord(db, "old-record-2", oldMs);
          insertOldRecord(db, "new-record", newMs);
        } else {
          // InMemoryStore: use source.timestamp (TTL checks source.timestamp)
          await store.insert(makeDraft({
            content: "old-record-1",
            source: { sessionID: "ses-old", timestamp: new Date(oldMs).toISOString() },
          }));
          await store.insert(makeDraft({
            content: "old-record-2",
            source: { sessionID: "ses-old", timestamp: new Date(oldMs).toISOString() },
          }));
          await store.insert(makeDraft({
            content: "new-record",
            source: { sessionID: "ses-new", timestamp: new Date(newMs).toISOString() },
          }));
        }

        // TTL: delete records older than 50 seconds
        if ("retention" in store) {
          const deleted = await (store as { retention(maxAgeMs: number, scope: ScopePredicate): Promise<number> }).retention(
            50_000,
            retentionScope(),
          );
          expect(deleted).toBe(2);
        }

        // Verify new record survived
        const count = await store.count(retentionScope());
        expect(count).toBe(1);
      });

      it("deletes nothing when all records are fresh", async () => {
        await store.insert(makeDraft({ content: "fresh-1" }));
        await store.insert(makeDraft({ content: "fresh-2" }));

        if ("retention" in store) {
          const deleted = await (store as { retention(maxAgeMs: number, scope: ScopePredicate): Promise<number> }).retention(
            3600_000, // 1 hour — all records are fresh
            retentionScope(),
          );
          expect(deleted).toBe(0);
        }

        const count = await store.count(retentionScope());
        expect(count).toBe(2);
      });

      it("TTL respects scope boundaries", async () => {
        const oldMs = Date.now() - 100_000;

        if (db) {
          insertOldRecord(db, "old-project-record", oldMs);
          insertOldRecord(db, "old-global-record", oldMs, "null-project", "wk-global");
          // Override the global record's scope
          db.run(
            "UPDATE memory SET scope = 'global', project_id = NULL WHERE id = (SELECT id FROM memory WHERE project_id = 'null-project' LIMIT 1)",
          );
        } else {
          await store.insert(makeDraft({
            content: "old-project-record",
            source: { sessionID: "ses-old", timestamp: new Date(oldMs).toISOString() },
          }));
          await store.insert(makeDraft({
            scope: "global",
            project_id: null,
            content: "old-global-record",
            source: { sessionID: "ses-old", timestamp: new Date(oldMs).toISOString() },
          }));
        }

        if ("retention" in store) {
          // Only delete project records
          const deleted = await (store as { retention(maxAgeMs: number, scope: ScopePredicate): Promise<number> }).retention(
            50_000,
            retentionScope(),
          );
          expect(deleted).toBe(1);
        }

        // Global record should survive
        const globalCount = await store.count({ where: "scope = 'global'", params: {} });
        expect(globalCount).toBe(1);
      });
    });

    describe("LRU retention", () => {
      it("keeps only the N most recent records", async () => {
        // Insert 10 records with ascending timestamps
        for (let i = 0; i < 10; i++) {
          const ts = new Date(Date.now() + i * 1000).toISOString();
          await store.insert(makeDraft({
            content: `record-${i}`,
            source: { sessionID: `ses-${i}`, timestamp: ts },
          }));
        }

        if ("retentionLru" in store) {
          const deleted = await (store as { retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> }).retentionLru(
            5,
            retentionScope(),
          );
          expect(deleted).toBe(5);
        }

        const count = await store.count(retentionScope());
        expect(count).toBe(5);
      });

      it("does nothing when count is at or below limit", async () => {
        for (let i = 0; i < 3; i++) {
          await store.insert(makeDraft({ content: `record-${i}` }));
        }

        if ("retentionLru" in store) {
          const deleted = await (store as { retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> }).retentionLru(
            5,
            retentionScope(),
          );
          expect(deleted).toBe(0);
        }

        const count = await store.count(retentionScope());
        expect(count).toBe(3);
      });

      it("LRU respects scope boundaries", async () => {
        // Insert project records
        for (let i = 0; i < 5; i++) {
          const ts = new Date(Date.now() + i * 1000).toISOString();
          await store.insert(makeDraft({
            content: `project-record-${i}`,
            source: { sessionID: `ses-${i}`, timestamp: ts },
          }));
        }

        // Insert global records
        for (let i = 0; i < 5; i++) {
          const ts = new Date(Date.now() + i * 1000).toISOString();
          await store.insert(makeDraft({
            scope: "global",
            project_id: null,
            content: `global-record-${i}`,
            source: { sessionID: `ses-global-${i}`, timestamp: ts },
          }));
        }

        if ("retentionLru" in store) {
          // Only retain 2 project records
          const deleted = await (store as { retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> }).retentionLru(
            2,
            retentionScope(),
          );
          expect(deleted).toBe(3);
        }

        // Project records reduced
        const projectCount = await store.count(retentionScope());
        expect(projectCount).toBe(2);

        // Global records untouched
        const globalCount = await store.count({ where: "scope = 'global'", params: {} });
        expect(globalCount).toBe(5);
      });

      it("LRU with zero limit deletes all matching records", async () => {
        await store.insert(makeDraft({ content: "r1" }));
        await store.insert(makeDraft({ content: "r2" }));
        await store.insert(makeDraft({ content: "r3" }));

        if ("retentionLru" in store) {
          const deleted = await (store as { retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> }).retentionLru(
            0,
            retentionScope(),
          );
          expect(deleted).toBe(3);
        }

        const count = await store.count(retentionScope());
        expect(count).toBe(0);
      });
    });

    describe("capacity (count + stats)", () => {
      it("stats returns correct aggregate values", async () => {
        await store.insert(makeDraft({ content: "abc" })); // 3 chars
        await store.insert(makeDraft({ content: "defgh" })); // 5 chars

        if ("stats" in store) {
          const stats = await (store as { stats(scope: ScopePredicate): Promise<{ count: number; totalContentLength: number; avgConfidence: number }> }).stats(retentionScope());
          expect(stats.count).toBe(2);
          expect(stats.totalContentLength).toBe(8); // 3 + 5
          expect(stats.avgConfidence).toBeGreaterThanOrEqual(0);
        }
      });

      it("count is consistent after multiple operations", async () => {
        await store.insert(makeDraft({ content: "a" }));
        await store.insert(makeDraft({ content: "b" }));
        await store.insert(makeDraft({ content: "c" }));

        let count = await store.count(retentionScope());
        expect(count).toBe(3);

        // Search doesn't change count
        await store.search("a", null, retentionScope(), 10);
        count = await store.count(retentionScope());
        expect(count).toBe(3);
      });
    });
  });
}
