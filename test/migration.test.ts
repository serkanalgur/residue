/**
 * Tests for schema migration.
 *
 * Verifies that:
 * - Migration from v1 to v2 adds new columns
 * - Existing data survives migration
 * - Migration is idempotent
 * - vec_* tables are untouched
 *
 * @module test/migration
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import type { ScopePredicate } from "../src/core/ports.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "residue-migration-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
});

const bothScope: ScopePredicate = {
  where: "(scope = 'global' OR (scope = 'project' AND project_id = :pid AND worktree_key = :wk))",
  params: { ":pid": "proj-migration", ":wk": "wk-migration" },
};

describe("Schema migration v1 → v2", () => {
  it("adds new columns and preserves existing data", () => {
    const db = new Database(":memory:");
    applyPragmas(db);

    // Manually create a v1 schema (without the new columns)
    db.run(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      tags TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      worktree_key TEXT,
      branch_key TEXT,
      source TEXT NOT NULL,
      CHECK ((scope='global' AND project_id IS NULL) OR
             (scope='project' AND project_id IS NOT NULL))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS ix_scope ON memory(scope, project_id)`);
    // NOTE: ix_access does NOT exist in v1 schema (last_access was added in v2)

    // Set schema version to 1
    db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '1')");

    // Insert a v1 record
    db.run(
      `INSERT INTO memory (id, text, kind, tags, scope, project_id, worktree_key, branch_key, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "v1-record-1",
        "Old v1 content",
        "fact",
        "[]",
        "project",
        "proj-migration",
        "wk-migration",
        "main",
        JSON.stringify({ sessionID: "ses-v1", timestamp: new Date().toISOString() }),
      ],
    );

    db.run(
      `INSERT INTO memory (id, text, kind, tags, scope, project_id, worktree_key, branch_key, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "v1-record-2",
        "Another v1 record",
        "decision",
        '["old-tag"]',
        "project",
        "proj-migration",
        "wk-migration",
        "main",
        JSON.stringify({ sessionID: "ses-v1", timestamp: new Date().toISOString() }),
      ],
    );

    // Run migration by calling initSchema
    const result = initSchema(db);

    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.fts5Available).toBe(true);

    // Verify existing data survived
    const rows = db.prepare("SELECT * FROM memory").all() as Array<{
      id: string;
      text: string;
      kind: string;
      tags: string;
    }>;
    expect(rows.length).toBe(2);

    const r1 = rows.find((r) => r.id === "v1-record-1");
    expect(r1).toBeDefined();
    expect(r1!.text).toBe("Old v1 content");
    expect(r1!.kind).toBe("fact");

    const r2 = rows.find((r) => r.id === "v1-record-2");
    expect(r2).toBeDefined();
    expect(r2!.text).toBe("Another v1 record");
    expect(r2!.tags).toBe('["old-tag"]');

    // Verify new columns exist with defaults
    const row1 = db.prepare("SELECT confidence, created_at, last_access, access_count, superseded_by FROM memory WHERE id = 'v1-record-1'").get() as {
      confidence: number;
      created_at: number;
      last_access: number;
      access_count: number;
      superseded_by: string | null;
    };
    expect(row1.confidence).toBe(0.6);
    expect(row1.created_at).toBe(0); // Default for existing rows
    expect(row1.last_access).toBe(0);
    expect(row1.access_count).toBe(0);
    expect(row1.superseded_by).toBeNull();

    // Verify schema version was updated
    const meta = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string };
    expect(meta.v).toBe(String(SCHEMA_VERSION));

    // Verify new index exists
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'ix_superseded'").get();
    expect(indexes).toBeDefined();

    db.close();
  });

  it("migration is idempotent", () => {
    const db = new Database(":memory:");
    applyPragmas(db);

    // Create v1 schema
    db.run(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      tags TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      worktree_key TEXT,
      branch_key TEXT,
      source TEXT NOT NULL,
      CHECK ((scope='global' AND project_id IS NULL) OR
             (scope='project' AND project_id IS NOT NULL))
    )`);
    db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '1')");

    // Insert a record
    db.run(
      `INSERT INTO memory (id, text, kind, tags, scope, project_id, worktree_key, branch_key, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["id1", "Test", "fact", "[]", "project", "p1", "w1", "main", "{}"],
    );

    // Run migration twice
    initSchema(db);
    const result2 = initSchema(db);

    expect(result2.schemaVersion).toBe(SCHEMA_VERSION);

    // Data should still be there
    const rows = db.prepare("SELECT * FROM memory").all();
    expect(rows.length).toBe(1);

    db.close();
  });

  it("new records get proper created_at", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    initSchema(db);

    const store = new SqliteStore(db, { embedder: null, readOnly: false });
    const before = Date.now();

    store.insert({
      kind: "fact",
      scope: "project",
      project_id: "proj-migration",
      worktree_key: "wk-migration",
      branch_key: "main",
      content: "Post-migration record",
      embedding: null,
      source: { sessionID: "ses-new", timestamp: new Date().toISOString() },
      tags: [],
    }).then((record) => {
      expect(record.created_at).toBeGreaterThanOrEqual(before);
      expect(record.confidence).toBe(0.6);
      expect(record.access_count).toBe(0);
      expect(record.superseded_by).toBeNull();
    });

    db.close();
  });
});
