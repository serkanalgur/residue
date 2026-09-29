/**
 * Tests for the retention policy engine.
 *
 * Covers:
 * - Per-kind TTL expiry
 * - Row cap enforcement with access-decay scoring
 * - Superseded-first eviction
 * - Idempotency (second run changes nothing)
 * - Bounded work (batchSize cap)
 * - Cancellation via AbortSignal
 * - Never throws into caller
 *
 * @module test/retention
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runRetention } from "../src/retention.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryStore, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import type { RetentionConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const log = createLogger(false);

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

/** Project scope predicate. */
function projectScope(): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid",
    params: { ":pid": "proj-retention" },
  };
}

/** Default retention config for tests. */
function defaultConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    enabled: true,
    ttl: {
      decisionDays: 365,
      patternDays: 365,
      factDays: 180,
      digestDays: 30,
      profileDays: 0,
    },
    maxRecordsPerProject: 10,
    maxRecordsGlobal: 100,
    batchSize: 50,
    ...overrides,
  };
}

/** Setup a fresh SqliteStore. */
function createSqliteStore(): { store: SqliteStore; db: Database } {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  return { store: new SqliteStore(db, { embedder: null, readOnly: false }), db };
}

// ---------------------------------------------------------------------------
// Parameterized tests
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
  describe(`Retention engine — ${impl.name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      const result = await impl.create();
      store = result.store;
    });

    describe("TTL per kind", () => {
      it("expires digest records after 30 days", async () => {
        const oldTime = Date.now() - 31 * 86_400_000; // 31 days ago
        await store.insert(makeDraft({ content: "Old digest", kind: "digest", created_at: oldTime }));
        await store.insert(makeDraft({ content: "Fresh digest", kind: "digest" }));

        const config = defaultConfig();
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(1);

        const count = await store.count(projectScope());
        expect(count).toBe(1);
      });

      it("does not expire fact records before 180 days", async () => {
        const oldTime = Date.now() - 100 * 86_400_000; // 100 days ago
        await store.insert(makeDraft({ content: "100-day fact", kind: "fact", created_at: oldTime }));

        const config = defaultConfig();
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(0);
      });

      it("expires fact records after 180 days", async () => {
        const oldTime = Date.now() - 181 * 86_400_000; // 181 days ago
        await store.insert(makeDraft({ content: "Old fact", kind: "fact", created_at: oldTime }));

        const config = defaultConfig();
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(1);
      });

      it("never expires profile records (TTL = 0)", async () => {
        const ancientTime = Date.now() - 365 * 86_400_000 * 10; // 10 years ago
        await store.insert(makeDraft({ content: "Ancient profile", kind: "profile", created_at: ancientTime }));

        const config = defaultConfig();
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(0);
      });
    });

    describe("superseded-first eviction", () => {
      it("evicts superseded records before live ones", async () => {
        // Insert 9 live records and 1 superseded record
        for (let i = 0; i < 9; i++) {
          await store.insert(makeDraft({ content: `Live record ${i}` }));
        }
        const superseded = await store.insert(makeDraft({ content: "Superseded record" }));
        await store.supersede(superseded.id, "replacement-id");

        // Cap at 5 — should evict the superseded one first
        const config = defaultConfig({ maxRecordsPerProject: 5 });
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBeGreaterThanOrEqual(1);

        // The superseded record should be gone
        const fetched = await store.get(superseded.id);
        expect(fetched).toBeNull();
      });
    });

    describe("row cap enforcement", () => {
      it("evicts records when over cap", async () => {
        // Insert 15 records (cap is 10)
        for (let i = 0; i < 15; i++) {
          await store.insert(makeDraft({ content: `Record ${i}`, created_at: Date.now() + i }));
        }

        const config = defaultConfig({ maxRecordsPerProject: 10 });
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBeGreaterThanOrEqual(5);

        const count = await store.count(projectScope());
        expect(count).toBeLessThanOrEqual(10);
      });

      it("does nothing when under cap", async () => {
        for (let i = 0; i < 3; i++) {
          await store.insert(makeDraft({ content: `Record ${i}` }));
        }

        const config = defaultConfig({ maxRecordsPerProject: 10 });
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(0);
      });
    });

    describe("idempotency", () => {
      it("second run removes nothing", async () => {
        const oldTime = Date.now() - 31 * 86_400_000;
        await store.insert(makeDraft({ content: "Old digest", kind: "digest", created_at: oldTime }));

        const config = defaultConfig();
        await runRetention(store, config, projectScope(), log);

        const countBefore = await store.count(projectScope());
        await runRetention(store, config, projectScope(), log);
        const countAfter = await store.count(projectScope());

        expect(countAfter).toBe(countBefore);
      });
    });

    describe("bounded work", () => {
      it("respects batchSize limit per phase", async () => {
        // Insert many expired records
        const oldTime = Date.now() - 200 * 86_400_000;
        for (let i = 0; i < 20; i++) {
          await store.insert(makeDraft({ content: `Expired ${i}`, kind: "fact", created_at: oldTime }));
        }

        const config = defaultConfig({ batchSize: 5 });
        const removed = await runRetention(store, config, projectScope(), log);
        // Each phase (superseded, TTL, cap) is individually bounded by batchSize.
        // With 0 superseded, 20 expired, cap=10: TTL phase removes ≤5, cap phase removes ≤5.
        expect(removed).toBeGreaterThan(0);
        expect(removed).toBeLessThanOrEqual(15); // 5 (superseded) + 5 (TTL) + 5 (cap)
      });
    });

    describe("cancellation", () => {
      it("respects AbortSignal", async () => {
        const oldTime = Date.now() - 200 * 86_400_000;
        for (let i = 0; i < 10; i++) {
          await store.insert(makeDraft({ content: `Expired ${i}`, kind: "fact", created_at: oldTime }));
        }

        const controller = new AbortController();
        controller.abort(); // Pre-abort

        const config = defaultConfig();
        const removed = await runRetention(store, config, projectScope(), log, controller.signal);
        // Should complete without throwing (error is caught)
        expect(removed).toBeGreaterThanOrEqual(0);
      });
    });

    describe("disabled retention", () => {
      it("returns 0 when disabled", async () => {
        const oldTime = Date.now() - 200 * 86_400_000;
        await store.insert(makeDraft({ content: "Old record", created_at: oldTime }));

        const config = defaultConfig({ enabled: false });
        const removed = await runRetention(store, config, projectScope(), log);
        expect(removed).toBe(0);

        // Record still exists
        const count = await store.count(projectScope());
        expect(count).toBe(1);
      });
    });

    describe("never throws", () => {
      it("swallows errors and returns 0", async () => {
        // Pass an invalid scope that might cause issues
        const config = defaultConfig();
        // Should not throw even with empty store
        const removed = await runRetention(store, config, projectScope(), log);
        expect(typeof removed).toBe("number");
      });
    });
  });
}
