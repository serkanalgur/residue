/**
 * SQLite driver probe tests.
 *
 * These tests verify that bun:sqlite (or node:sqlite fallback) is available
 * with WAL mode and FTS5 support. If any of these fail, it indicates a
 * regression in the runtime environment — treat as a hard failure.
 *
 * NOTE: WAL mode only works with file-backed databases, not :memory:.
 * We use temp files for WAL tests and :memory: for FTS5 tests.
 *
 * @module test/sqlite.probe
 */

import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Temp directory for file-backed SQLite tests. */
let tempDir: string;

/** Temp database path. */
let tempDbPath: string;

// Create temp dir before tests
try {
  tempDir = mkdtempSync(join(tmpdir(), "residue-sqlite-test-"));
  tempDbPath = join(tempDir, "test.db");
} catch {
  tempDir = "";
  tempDbPath = "";
}

afterAll(() => {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort
    }
  }
});

describe("bun:sqlite driver probe", () => {
  it("bun:sqlite is importable and functional", () => {
    const db = new Database(":memory:");

    // Basic CRUD
    db.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO test (value) VALUES (?)", ["hello"]);
    const row = db.prepare("SELECT value FROM test WHERE id = 1").get() as { value: string };
    expect(row.value).toBe("hello");

    db.close();
  });

  it("WAL journal mode is supported with file-backed database", () => {
    if (!tempDbPath) {
      throw new Error("Temp directory not available");
    }

    const db = new Database(tempDbPath);

    // Enable WAL mode
    db.exec("PRAGMA journal_mode=WAL");

    // Verify WAL is active by reading the pragma
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");

    db.close();
  });

  it("FTS5 virtual tables can be created and queried", () => {
    const db = new Database(":memory:");

    // Create FTS5 virtual table
    db.run("CREATE VIRTUAL TABLE test_fts USING fts5(content)");

    // Insert data
    db.run("INSERT INTO test_fts (content) VALUES (?)", ["the quick brown fox"]);
    db.run("INSERT INTO test_fts (content) VALUES (?)", ["lazy dog sleeps"]);

    // Full-text search
    const results = db
      .prepare("SELECT content FROM test_fts WHERE test_fts MATCH ?")
      .all("fox") as { content: string }[];

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("the quick brown fox");

    // Cleanup
    db.run("DROP TABLE test_fts");
    db.close();
  });

  it("WAL mode persists across DDL operations on file-backed database", () => {
    if (!tempDbPath) {
      throw new Error("Temp directory not available");
    }

    // Use a separate DB for this test to avoid conflicts
    const dbPath = join(tempDir, "test-persistent.db");
    const db = new Database(dbPath);

    db.exec("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE persistent (id INTEGER, data TEXT)");
    db.run("INSERT INTO persistent VALUES (1, 'test')");

    // Verify WAL mode is still active after DDL
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");

    db.close();
  });

  it("bun:sqlite PRAGMA query API works correctly", () => {
    const db = new Database(":memory:");

    // Verify we can read pragma values via prepare().get()
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    // In-memory databases use "memory" journal mode
    expect(typeof row.journal_mode).toBe("string");
    expect(row.journal_mode.length).toBeGreaterThan(0);

    db.close();
  });
});
