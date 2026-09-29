/**
 * SQLite-backed implementation of the MemoryStore port.
 *
 * Provides persistent storage with scope isolation, hybrid search (FTS5 + vector),
 * and WAL-mode concurrency. The store is file-backed and supports multiple
 * concurrent readers with a single writer.
 *
 * @module store/sqlite/store
 */

import type { MemoryDraft, MemoryRecord, SearchHit, Scope } from "../../core/types.js";
import type { MemoryStore, ScopePredicate, Embedder } from "../../core/ports.js";
import type { SqliteDatabase } from "./driver.js";
import { newId } from "../../util/ids.js";
import { initSchema, createVecTable } from "./schema.js";
import { vectorSearch, storeVector, deleteVector, findVecTable } from "./vectors.js";
import { applyPragmas } from "./lock.js";

/** Source reference serialized as JSON in the database. */
interface SourceRow {
  readonly sessionID: string;
  readonly messageID?: string;
  readonly timestamp: string;
}

/** Row shape returned by SQLite queries. */
interface MemoryRow {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly tags: string;
  readonly scope: string;
  readonly project_id: string | null;
  readonly worktree_key: string;
  readonly branch_key: string | null;
  readonly source: string;
  readonly confidence: number;
  readonly created_at: number;
  readonly last_access: number;
  readonly access_count: number;
  readonly superseded_by: string | null;
}

/**
 * Configuration for SqliteStore.
 */
export interface SqliteStoreConfig {
  /** Embedder to use for vector operations (null = no embeddings). */
  readonly embedder: Embedder | null;
  /** Whether the store is in read-only mode (lock acquisition failed). */
  readonly readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Named-to-positional parameter conversion
// ---------------------------------------------------------------------------

/**
 * Convert a ScopePredicate with named placeholders (:pid, :wk) into
 * positional `?` placeholders and return the values array.
 *
 * bun:sqlite does not reliably support `$N` positional parameters when
 * placeholders are not in sequential order in the SQL text. The `?`
 * placeholder is the most portable approach.
 *
 * @param scope - Scope predicate with named placeholders.
 * @returns Object with the rewritten WHERE clause and ordered values array.
 */
function resolveScopeParams(scope: ScopePredicate): {
  where: string;
  values: (string | number)[];
} {
  const keys = Object.keys(scope.params);
  const values: (string | number)[] = [];
  let where = scope.where;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const val = scope.params[key] as string | number;
    // Count occurrences so we push one value per ? placeholder.
    // replaceAll replaces ALL occurrences, so we need one bound value per occurrence.
    const occurrences = where.split(key).length - 1;
    for (let j = 0; j < occurrences; j++) {
      values.push(val);
    }
    where = where.replaceAll(key, "?");
  }

  return { where, values };
}

/**
 * SQLite-backed memory store implementing the MemoryStore port.
 *
 * Features:
 * - WAL mode for concurrent reads
 * - FTS5 for full-text search (graceful degradation to JS fallback)
 * - Vector similarity search via IVF-lite
 * - Scope isolation via named SQL parameters
 * - Automatic FTS sync on insert
 */
export class SqliteStore implements MemoryStore {
  private db: SqliteDatabase;
  private config: SqliteStoreConfig;
  private fts5Available = false;
  private schemaVersion = 0;
  private activeVecTable: string | null = null;

  /**
   * Create a new SqliteStore.
   *
   * @param db - Opened SQLite database instance.
   * @param config - Store configuration.
   */
  constructor(db: SqliteDatabase, config: SqliteStoreConfig) {
    this.db = db;
    this.config = config;
  }

  /** @inheritdoc */
  async initialize(): Promise<void> {
    applyPragmas(this.db);
    const schema = initSchema(this.db);
    this.fts5Available = schema.fts5Available;
    this.schemaVersion = schema.schemaVersion;

    if (this.config.embedder && !this.config.embedder.degraded) {
      createVecTable(this.db, this.config.embedder.id, this.config.embedder.dimension);
      this.activeVecTable = findVecTable(this.db, this.config.embedder.id);
    }
  }

  /** @inheritdoc */
  async insert(draft: MemoryDraft): Promise<MemoryRecord> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode (lock held by another process)");
    }

    const id = newId();
    const now = Date.now();
    const tagsJson = JSON.stringify(draft.tags);
    const sourceJson = JSON.stringify(draft.source);

    this.db.run(
      `INSERT INTO memory (id, text, kind, tags, scope, project_id, worktree_key,
       branch_key, source, confidence, created_at, last_access, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.6, ?, ?, 0)`,
      [
        id,
        draft.content,
        draft.kind,
        tagsJson,
        draft.scope,
        draft.project_id,
        draft.worktree_key,
        draft.branch_key,
        sourceJson,
        now,
        now,
      ],
    );

    // Sync FTS5 if available
    if (this.fts5Available) {
      try {
        this.db.run(
          "INSERT INTO memory_fts (id, text) VALUES (?, ?)",
          [id, draft.content],
        );
      } catch {
        // FTS sync failure is non-fatal
      }
    }

    // Store vector if embedding is available
    if (draft.embedding && this.activeVecTable) {
      try {
        storeVector(this.db, this.activeVecTable, id, draft.embedding);
      } catch {
        // Vector storage failure is non-fatal
      }
    }

    return {
      id,
      kind: draft.kind,
      scope: draft.scope,
      project_id: draft.project_id,
      worktree_key: draft.worktree_key,
      branch_key: draft.branch_key,
      content: draft.content,
      embedding: draft.embedding,
      source: draft.source,
      tags: draft.tags,
    };
  }

  /** @inheritdoc */
  async search(
    query: string,
    embedding: Float32Array | null,
    scope: ScopePredicate,
    limit: number,
  ): Promise<readonly SearchHit[]> {
    const hits: SearchHit[] = [];
    const seenIds = new Set<string>();

    // FTS5 search
    if (this.fts5Available && query.trim()) {
      try {
        const ftsQuery = buildFtsQuery(query);
        const resolved = resolveScopeParams(scope);

        // Append FTS query and limit as additional ? placeholders.
        // IMPORTANT: FTS MATCH ? must be the FIRST ? in the SQL, so the
        // FTS query value must come first in the params array.
        const sql = `SELECT m.id, m.text, m.kind, m.tags, m.scope, m.project_id,
                m.worktree_key, m.branch_key, m.source, m.confidence,
                m.created_at, m.last_access, m.access_count, m.superseded_by,
                rank
         FROM memory_fts f
         JOIN memory m ON m.id = f.id
         WHERE memory_fts MATCH ?
           AND ${resolved.where}
         ORDER BY rank
         LIMIT ?`;

        const params: (string | number)[] = [ftsQuery, ...resolved.values, limit * 2];
        const ftsResults = this.db.prepare(sql).all(...params) as Array<MemoryRow & { rank: number }>;

        for (const row of ftsResults) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          this.touchRecord(row.id);
          hits.push({
            record: rowToRecord(row),
            score: ftsRankToScore(row.rank),
            ftsMatch: true,
          });
        }
      } catch {
        // FTS query failure — continue without FTS results
      }
    }

    // Vector similarity search
    if (embedding && this.activeVecTable) {
      try {
        const vecHits = vectorSearch(this.db, embedding, this.config.embedder!.id, limit * 2);

        for (const vh of vecHits) {
          if (seenIds.has(vh.memoryId)) continue;
          seenIds.add(vh.memoryId);

          const resolved = resolveScopeParams(scope);

          const row = this.db.prepare(
            `SELECT * FROM memory WHERE id = ? AND ${resolved.where}`,
          ).get(vh.memoryId, ...resolved.values) as MemoryRow | undefined;

          if (row) {
            this.touchRecord(row.id);
            hits.push({
              record: rowToRecord(row),
              score: vh.score,
              ftsMatch: false,
            });
          }
        }
      } catch {
        // Vector search failure — continue with FTS results only
      }
    }

    // Sort by score descending and return top limit
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** @inheritdoc */
  async count(scope: ScopePredicate): Promise<number> {
    const resolved = resolveScopeParams(scope);
    const result = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory WHERE ${resolved.where}`,
    ).get(...resolved.values) as { cnt: number } | undefined;
    return result?.cnt ?? 0;
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Best effort
    }
  }

  /**
   * Delete records matching a scope predicate.
   *
   * @param scope - Scope predicate to filter records.
   * @returns Number of deleted records.
   */
  async delete(scope: ScopePredicate): Promise<number> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    const resolved = resolveScopeParams(scope);

    // Get IDs to delete (for FTS/vector cleanup)
    const rows = this.db.prepare(
      `SELECT id FROM memory WHERE ${resolved.where}`,
    ).all(...resolved.values) as Array<{ id: string }>;

    // Delete FTS entries
    if (this.fts5Available) {
      for (const row of rows) {
        try {
          this.db.run("DELETE FROM memory_fts WHERE id = ?", [row.id]);
        } catch {
          // Best effort
        }
      }
    }

    // Delete vector entries
    if (this.activeVecTable) {
      for (const row of rows) {
        try {
          deleteVector(this.db, this.activeVecTable, row.id);
        } catch {
          // Best effort
        }
      }
    }

    // Delete records
    this.db.run(
      `DELETE FROM memory WHERE ${resolved.where}`,
      resolved.values,
    );

    return rows.length;
  }

  /**
   * Apply TTL-based retention: delete records older than maxAgeMs.
   *
   * @param maxAgeMs - Maximum age in milliseconds.
   * @param scope - Scope predicate to limit deletion.
   * @returns Number of deleted records.
   */
  async retention(maxAgeMs: number, scope: ScopePredicate): Promise<number> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    const cutoff = Date.now() - maxAgeMs;
    const resolved = resolveScopeParams(scope);

    // Get IDs to delete — use created_at for TTL (not last_access, which is for LRU)
    const rows = this.db.prepare(
      `SELECT id FROM memory WHERE created_at < ? AND ${resolved.where}`,
    ).all(cutoff, ...resolved.values) as Array<{ id: string }>;

    // Cleanup FTS and vectors
    if (this.fts5Available) {
      for (const row of rows) {
        try {
          this.db.run("DELETE FROM memory_fts WHERE id = ?", [row.id]);
        } catch {
          // Best effort
        }
      }
    }
    if (this.activeVecTable) {
      for (const row of rows) {
        try {
          deleteVector(this.db, this.activeVecTable, row.id);
        } catch {
          // Best effort
        }
      }
    }

    this.db.run(
      `DELETE FROM memory WHERE created_at < ? AND ${resolved.where}`,
      [cutoff, ...resolved.values],
    );

    return rows.length;
  }

  /**
   * Apply LRU-based retention: keep only the top N most recently accessed records.
   *
   * @param maxCount - Maximum number of records to keep.
   * @param scope - Scope predicate to limit retention.
   * @returns Number of deleted records.
   */
  async retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    const resolved = resolveScopeParams(scope);

    // Count current records
    const countResult = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory WHERE ${resolved.where}`,
    ).get(...resolved.values) as { cnt: number } | undefined;

    const currentCount = countResult?.cnt ?? 0;
    if (currentCount <= maxCount) return 0;

    // Find IDs to delete (oldest by last_access)
    const deleteCount = currentCount - maxCount;
    const rows = this.db.prepare(
      `SELECT id FROM memory WHERE ${resolved.where} ORDER BY last_access ASC LIMIT ?`,
    ).all(...resolved.values, deleteCount) as Array<{ id: string }>;

    // Cleanup FTS and vectors
    if (this.fts5Available) {
      for (const row of rows) {
        try {
          this.db.run("DELETE FROM memory_fts WHERE id = ?", [row.id]);
        } catch {
          // Best effort
        }
      }
    }
    if (this.activeVecTable) {
      for (const row of rows) {
        try {
          deleteVector(this.db, this.activeVecTable, row.id);
        } catch {
          // Best effort
        }
      }
    }

    // Delete the oldest records
    const idList = rows.map((r) => r.id);
    if (idList.length > 0) {
      this.db.run(
        `DELETE FROM memory WHERE id IN (${idList.map(() => "?").join(", ")})`,
        idList,
      );
    }

    return rows.length;
  }

  /**
   * Get aggregate statistics about the store.
   *
   * @param scope - Scope predicate.
   * @returns Statistics object.
   */
  async stats(scope: ScopePredicate): Promise<{
    readonly count: number;
    readonly totalContentLength: number;
    readonly avgConfidence: number;
  }> {
    const resolved = resolveScopeParams(scope);
    const result = this.db.prepare(
      `SELECT COUNT(*) as cnt,
              COALESCE(SUM(LENGTH(text)), 0) as total_len,
              COALESCE(AVG(confidence), 0) as avg_conf
       FROM memory WHERE ${resolved.where}`,
    ).get(...resolved.values) as {
      cnt: number;
      total_len: number;
      avg_conf: number;
    } | undefined;

    return {
      count: result?.cnt ?? 0,
      totalContentLength: result?.total_len ?? 0,
      avgConfidence: result?.avg_conf ?? 0,
    };
  }

  /**
   * Get schema version and FTS5 status.
   */
  get schemaInfo(): { readonly version: number; readonly fts5: boolean; readonly vecTable: string | null } {
    return {
      version: this.schemaVersion,
      fts5: this.fts5Available,
      vecTable: this.activeVecTable,
    };
  }

  /**
   * Update the last_access timestamp and increment access_count.
   */
  private touchRecord(id: string): void {
    try {
      this.db.run(
        "UPDATE memory SET last_access = ?, access_count = access_count + 1 WHERE id = ?",
        [Date.now(), id],
      );
    } catch {
      // Touch failure is non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SQLite row to a MemoryRecord.
 *
 * @param row - Raw database row.
 * @returns Typed MemoryRecord.
 */
function rowToRecord(row: MemoryRow): MemoryRecord {
  const tags: string[] = JSON.parse(row.tags) as string[];
  const source: SourceRow = JSON.parse(row.source) as SourceRow;

  return {
    id: row.id,
    kind: row.kind as MemoryRecord["kind"],
    scope: row.scope as Scope,
    project_id: row.project_id,
    worktree_key: row.worktree_key,
    branch_key: row.branch_key,
    content: row.text,
    embedding: null, // Vectors are stored separately
    source: {
      sessionID: source.sessionID,
      messageID: source.messageID,
      timestamp: source.timestamp,
    },
    tags,
  };
}

/**
 * Convert FTS5 rank to a 0–1 similarity score.
 *
 * FTS5 rank is negative (closer to 0 = better match).
 * We normalize: score = 1 / (1 + abs(rank)).
 *
 * @param rank - FTS5 rank value.
 * @returns Score in [0, 1].
 */
function ftsRankToScore(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

/**
 * Build an FTS5 query string from a text query.
 *
 * Splits the query into terms and joins with AND for precision.
 *
 * @param query - Raw search query.
 * @returns FTS5-compatible query string.
 */
function buildFtsQuery(query: string): string {
  const terms = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return '""';

  // Join terms with AND for precision
  return terms.map((t) => `"${t}"`).join(" AND ");
}
