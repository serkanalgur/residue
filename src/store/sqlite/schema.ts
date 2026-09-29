/**
 * Database schema definition and DDL for Residue's SQLite store.
 *
 * Schema version is tracked in the `meta` table. Migrations are additive only —
 * columns are never removed or renamed, and destructive migrations are forbidden.
 *
 * @module store/sqlite/schema
 */

import type { SqliteDatabase } from "./driver.js";

/** Current schema version — incremented on DDL changes. */
export const SCHEMA_VERSION = 1;

/**
 * SQL statements to initialize the database schema.
 *
 * The schema includes:
 * - `meta`: key-value store for schema version and embedder identity
 * - `memory`: main record table with scope isolation indexes
 * - `memory_fts`: FTS5 virtual table for full-text search (graceful degradation)
 *
 * The `vec_*` vector tables are created dynamically by vectors.ts when needed.
 */
const DDL_STATEMENTS = [
  // Schema version tracking
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,

  // Main memory record table
  `CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    kind TEXT NOT NULL,
    tags TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT,
    worktree_key TEXT,
    branch_key TEXT,
    source TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.6,
    created_at INTEGER NOT NULL,
    last_access INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT,
    CHECK ((scope='global' AND project_id IS NULL) OR
           (scope='project' AND project_id IS NOT NULL))
  )`,

  // Scope index for filtered queries
  `CREATE INDEX IF NOT EXISTS ix_scope ON memory(scope, project_id)`,

  // Access time index for LRU retention
  `CREATE INDEX IF NOT EXISTS ix_access ON memory(last_access)`,
];

/**
 * Check if FTS5 is available by attempting to create a temporary table.
 *
 * @param db - Database instance.
 * @returns True if FTS5 is available.
 */
export function checkFts5(db: SqliteDatabase): boolean {
  try {
    db.run('CREATE VIRTUAL TABLE IF NOT EXISTS _residue_fts_check USING fts5(a)');
    db.run("DROP TABLE IF EXISTS _residue_fts_check");
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize the FTS5 virtual table for full-text search.
 *
 * Creates the FTS table if it doesn't exist. If FTS5 is not available,
 * returns false to indicate degraded mode (JS fallback will be used).
 *
 * @param db - Database instance.
 * @returns True if FTS5 table was created successfully.
 */
export function initFts5(db: SqliteDatabase): boolean {
  try {
    db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text, tokenize='unicode61')",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize the database schema.
 *
 * Runs all DDL statements, sets schema version, and checks FTS5 availability.
 * Idempotent — safe to call multiple times.
 *
 * @param db - Database instance.
 * @returns Object indicating FTS5 availability and schema version.
 */
export function initSchema(db: SqliteDatabase): { fts5Available: boolean; schemaVersion: number } {
  // Run all DDL statements
  for (const sql of DDL_STATEMENTS) {
    db.run(sql);
  }

  // Set schema version
  db.run(
    "INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)",
    [String(SCHEMA_VERSION)],
  );

  // Check and initialize FTS5
  const fts5Available = checkFts5(db) && initFts5(db);

  return { fts5Available, schemaVersion: SCHEMA_VERSION };
}

/**
 * Create a vector table for a specific embedder and dimension.
 *
 * Table name encodes the embedder identity and dimension:
 * `vec_<embedderID>_<dim>` — e.g., `vec_openai-3-small_1536`
 *
 * If a table with a different dimension already exists for the same embedder,
 * the old table is left in place (new table is created alongside). This prevents
 * destructive data loss when switching embedders.
 *
 * @param db - Database instance.
 * @param embedderId - Embedder identifier (sanitized for SQL).
 * @param dimension - Vector dimension.
 */
export function createVecTable(
  db: SqliteDatabase,
  embedderId: string,
  dimension: number,
): void {
  const safeName = sanitizeTableName(embedderId);
  const tableName = `vec_${safeName}_${dimension}`;

  db.run(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_id TEXT PRIMARY KEY,
      v BLOB NOT NULL
    )
  `);
}

/**
 * Drop vector tables for a specific embedder (all dimensions).
 *
 * Used when the embedder identity changes (stored in meta table).
 *
 * @param db - Database instance.
 * @param embedderId - Embedder identifier prefix to match.
 */
export function dropVecTables(db: SqliteDatabase, embedderId: string): void {
  const safePrefix = sanitizeTableName(embedderId);

  // Query for matching tables in sqlite_master
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?",
  ).all(`vec_${safePrefix}_%`) as Array<{ name: string }>;

  for (const table of tables) {
    db.run(`DROP TABLE IF EXISTS ${table.name}`);
  }
}

/**
 * Sanitize an embedder ID for use as a SQL table name component.
 *
 * Replaces non-alphanumeric characters with underscores to prevent SQL injection
 * while preserving readability.
 *
 * @param id - Raw embedder identifier.
 * @returns Safe table name component.
 */
function sanitizeTableName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
