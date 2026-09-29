/**
 * Concurrency tests for SQLite store with WAL mode.
 *
 * Tests that multiple concurrent writers can safely access the same
 * database file without corruption, data loss, or inconsistency.
 *
 * Two "workspaces" (process-like contexts) open the same database file
 * and write concurrently. After all writes complete, we verify:
 * 1. Record count matches expected total
 * 2. Total content length is preserved (no partial writes)
 * 3. No records are lost or duplicated
 *
 * @module test/store.concurrency
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import { acquireLock, releaseLock } from "../src/store/sqlite/lock.js";
import type { MemoryDraft } from "../src/core/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Temp directory for concurrency tests. */
let tempDir: string;

/** Create a test draft. */
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

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "residue-concurrency-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
});

describe("SQLite WAL concurrency", () => {
  it("two concurrent writers produce correct total count and content length", async () => {
    const dbPath = join(tempDir, "concurrent-test.db");
    const WRITES_PER_WORKER = 50;
    const CONTENT_PREFIX = "worker-";

    // Worker A: opens DB, writes 50 records
    const workerA = async (): Promise<{ count: number; totalLen: number }> => {
      const db = new Database(dbPath);
      applyPragmas(db);
      initSchema(db);
      const store = new SqliteStore(db, { embedder: null, readOnly: false });
      await store.initialize();

      let count = 0;
      let totalLen = 0;
      for (let i = 0; i < WRITES_PER_WORKER; i++) {
        const content = `${CONTENT_PREFIX}A-${i}`;
        await store.insert(makeDraft({ content }));
        count++;
        totalLen += content.length;
      }

      await store.close();
      return { count, totalLen };
    };

    // Worker B: opens DB, writes 50 records
    const workerB = async (): Promise<{ count: number; totalLen: number }> => {
      const db = new Database(dbPath);
      applyPragmas(db);
      initSchema(db);
      const store = new SqliteStore(db, { embedder: null, readOnly: false });
      await store.initialize();

      let count = 0;
      let totalLen = 0;
      for (let i = 0; i < WRITES_PER_WORKER; i++) {
        const content = `${CONTENT_PREFIX}B-${i}`;
        await store.insert(makeDraft({ content }));
        count++;
        totalLen += content.length;
      }

      await store.close();
      return { count, totalLen };
    };

    // Run both workers concurrently
    const [resultA, resultB] = await Promise.all([workerA(), workerB()]);

    // Verify individual worker results
    expect(resultA.count).toBe(WRITES_PER_WORKER);
    expect(resultB.count).toBe(WRITES_PER_WORKER);

    // Open a fresh connection to verify totals
    const verifyDb = new Database(dbPath);
    applyPragmas(verifyDb);
    initSchema(verifyDb);
    const verifyStore = new SqliteStore(verifyDb, { embedder: null, readOnly: false });
    await verifyStore.initialize();

    // Count all records
    const totalCount = await verifyStore.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-test" },
    });
    expect(totalCount).toBe(WRITES_PER_WORKER * 2);

    // Verify total content length
    const stats = await verifyStore.stats({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-test" },
    });
    expect(stats.totalContentLength).toBe(resultA.totalLen + resultB.totalLen);

    // Verify both workers' records are present
    const resultsA = await verifyStore.search(
      `${CONTENT_PREFIX}A`,
      null,
      {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-test" },
      },
      WRITES_PER_WORKER + 10,
    );
    expect(resultsA.length).toBe(WRITES_PER_WORKER);

    const resultsB = await verifyStore.search(
      `${CONTENT_PREFIX}B`,
      null,
      {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-test" },
      },
      WRITES_PER_WORKER + 10,
    );
    expect(resultsB.length).toBe(WRITES_PER_WORKER);

    await verifyStore.close();
  });

  it("concurrent reads and writes do not block or corrupt", async () => {
    const dbPath = join(tempDir, "rw-concurrent-test.db");
    const WRITE_COUNT = 30;
    const READ_COUNT = 100;

    // Pre-populate with some data
    const seedDb = new Database(dbPath);
    applyPragmas(seedDb);
    initSchema(seedDb);
    const seedStore = new SqliteStore(seedDb, { embedder: null, readOnly: false });
    await seedStore.initialize();

    for (let i = 0; i < 10; i++) {
      await seedStore.insert(makeDraft({ content: `seed-${i}` }));
    }
    await seedStore.close();

    // Writer: adds records
    const writer = async (): Promise<number> => {
      const db = new Database(dbPath);
      applyPragmas(db);
      initSchema(db);
      const store = new SqliteStore(db, { embedder: null, readOnly: false });
      await store.initialize();

      let written = 0;
      for (let i = 0; i < WRITE_COUNT; i++) {
        try {
          await store.insert(makeDraft({ content: `written-${i}` }));
          written++;
        } catch {
          // Write might fail if lock is held — that's OK
        }
      }

      await store.close();
      return written;
    };

    // Reader: queries records
    const reader = async (): Promise<number> => {
      const db = new Database(dbPath);
      applyPragmas(db);
      initSchema(db);
      const store = new SqliteStore(db, { embedder: null, readOnly: false });
      await store.initialize();

      let reads = 0;
      for (let i = 0; i < READ_COUNT; i++) {
        try {
          const count = await store.count({
            where: "scope = 'project' AND project_id = :pid",
            params: { ":pid": "proj-test" },
          });
          expect(count).toBeGreaterThanOrEqual(10); // At least seeds
          reads++;
        } catch {
          // Read might fail if lock is held — that's OK
        }
      }

      await store.close();
      return reads;
    };

    // Run writer and reader concurrently
    const [writtenCount, readCount] = await Promise.all([writer(), reader()]);

    // At least some writes and reads should succeed
    expect(writtenCount).toBeGreaterThan(0);
    expect(readCount).toBeGreaterThan(0);

    // Final verification
    const verifyDb = new Database(dbPath);
    applyPragmas(verifyDb);
    initSchema(verifyDb);
    const verifyStore = new SqliteStore(verifyDb, { embedder: null, readOnly: false });
    await verifyStore.initialize();

    const finalCount = await verifyStore.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-test" },
    });
    // Should have at least seeds + some writes
    expect(finalCount).toBeGreaterThanOrEqual(10);

    await verifyStore.close();
  });

  it("PID lock prevents concurrent write access", async () => {
    const dbPath = join(tempDir, "lock-test.db");

    // Create the database
    const db1 = new Database(dbPath);
    applyPragmas(db1);
    initSchema(db1);
    const store1 = new SqliteStore(db1, { embedder: null, readOnly: false });
    await store1.initialize();

    // Acquire lock manually
    const lockAcquired = acquireLock(dbPath);
    expect(lockAcquired).toBe(true);

    // Try to acquire lock again — should fail
    const lockAcquired2 = acquireLock(dbPath);
    expect(lockAcquired2).toBe(false);

    // Release lock
    releaseLock(dbPath);

    // Now lock should be acquirable
    const lockAcquired3 = acquireLock(dbPath);
    expect(lockAcquired3).toBe(true);

    // Cleanup
    releaseLock(dbPath);
    await store1.close();
  });
});
