/**
 * SQLite-backed implementation of the MemoryStore port.
 *
 * Provides persistent storage with scope isolation, hybrid search (FTS5 + vector),
 * and WAL-mode concurrency. The store is file-backed and supports multiple
 * concurrent readers with a single writer.
 *
 * @module store/sqlite/store
 */

import type { MemoryDraft, MemoryKind, MemoryPatch, MemoryRecord, SearchHit, Scope } from "../../core/types.js";
import type { MemoryStore, ScopePredicate, Embedder, ScanOptions, StoreStats } from "../../core/ports.js";
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
  const keys = Object.keys(scope.params).sort();
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
    const createdAt = draft.created_at ?? now;
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
        createdAt,
        createdAt,
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
      confidence: 0.6,
      created_at: createdAt,
      last_access: createdAt,
      access_count: 0,
      superseded_by: null,
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

      // Try candidates most-precise-first and stop at the first that returns
      // rows, so an exact/identifier query is never broadened needlessly.
      for (const ftsQuery of buildFtsQueries(query)) {
        try {
          const params: (string | number)[] = [ftsQuery, ...resolved.values, limit * 2];
          const ftsResults = this.db.prepare(sql).all(...params) as Array<
            MemoryRow & { rank: number }
          >;

          // Remap bm25 onto a usable 0-1 scale relative to this result set,
          // so strong and weak matches are actually distinguishable.
          const ftsScores = ftsRanksToScores(ftsResults.map((r) => r.rank));

          for (const [i, row] of ftsResults.entries()) {
            if (seenIds.has(row.id)) continue;
            seenIds.add(row.id);
            this.touchRecord(row.id);
            hits.push({
              record: rowToRecord(row),
              score: ftsScores[i] ?? 0,
              ftsMatch: true,
            });
          }

          if (ftsResults.length > 0) break;
        } catch {
          // FTS query failure on this candidate — try the next one, and if all
          // fail, continue without FTS results.
        }
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
  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** @inheritdoc */
  async update(id: string, patch: MemoryPatch): Promise<MemoryRecord | null> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    const existing = await this.get(id);
    if (!existing) return null;

    const newContent = patch.content ?? existing.content;
    const newTags = patch.tags ?? existing.tags;
    const newConfidence = patch.confidence ?? existing.confidence;
    const newSupersededBy =
      patch.superseded_by !== undefined ? patch.superseded_by : existing.superseded_by;

    const tagsJson = JSON.stringify(newTags);

    this.db.run(
      `UPDATE memory SET text = ?, tags = ?, confidence = ?, superseded_by = ? WHERE id = ?`,
      [newContent, tagsJson, newConfidence, newSupersededBy, id],
    );

    // Keep FTS5 in sync: delete old entry, insert new one if content changed
    if (this.fts5Available && newContent !== existing.content) {
      try {
        this.db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
        this.db.run("INSERT INTO memory_fts (id, text) VALUES (?, ?)", [id, newContent]);
      } catch {
        // FTS sync failure is non-fatal
      }
    }

    // Re-embed if content changed and embedder is available
    if (this.activeVecTable && this.config.embedder && newContent !== existing.content) {
      try {
        const newEmbedding = await this.config.embedder.embed(newContent);
        if (newEmbedding) {
          // Remove old vector, store new one
          deleteVector(this.db, this.activeVecTable, id);
          storeVector(this.db, this.activeVecTable, id, newEmbedding);
        } else {
          // Embedder returned null — remove stale vector
          deleteVector(this.db, this.activeVecTable, id);
        }
      } catch {
        // Re-embedding failure is non-fatal — remove stale vector
        try {
          deleteVector(this.db, this.activeVecTable, id);
        } catch {
          // Best effort
        }
      }
    }

    return this.get(id);
  }

  /** @inheritdoc */
  async remove(id: string): Promise<boolean> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    const existing = await this.get(id);
    if (!existing) return false;

    // Remove FTS entry
    if (this.fts5Available) {
      try {
        this.db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
      } catch {
        // Best effort
      }
    }

    // Remove vector entry
    if (this.activeVecTable) {
      try {
        deleteVector(this.db, this.activeVecTable, id);
      } catch {
        // Best effort
      }
    }

    this.db.run("DELETE FROM memory WHERE id = ?", [id]);
    return true;
  }

  /** @inheritdoc */
  async removeMany(ids: readonly string[]): Promise<number> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }
    if (ids.length === 0) return 0;

    // Count how many actually exist before deleting
    const placeholders = ids.map(() => "?").join(", ");
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory WHERE id IN (${placeholders})`,
    ).get(...ids) as { cnt: number } | undefined;
    const existingCount = countRow?.cnt ?? 0;

    // Remove FTS entries
    if (this.fts5Available) {
      for (const id of ids) {
        try {
          this.db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
        } catch {
          // Best effort
        }
      }
    }

    // Remove vector entries
    if (this.activeVecTable) {
      for (const id of ids) {
        try {
          deleteVector(this.db, this.activeVecTable, id);
        } catch {
          // Best effort
        }
      }
    }

    // Delete records in a single statement for transactional behaviour
    this.db.run(`DELETE FROM memory WHERE id IN (${placeholders})`, [...ids]);

    return existingCount;
  }

  /** @inheritdoc */
  async scan(options: ScanOptions): Promise<readonly MemoryRecord[]> {
    const resolved = resolveScopeParams(options.scope);
    const conditions: string[] = [resolved.where];
    const params: (string | number)[] = [...resolved.values];

    if (options.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    if (options.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(options.since);
    }
    if (options.until !== undefined) {
      conditions.push("created_at <= ?");
      params.push(options.until);
    }

    const where = conditions.join(" AND ");
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM memory WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as MemoryRow[];

    return rows.map(rowToRecord);
  }

  /** @inheritdoc */
  async stats(scope: ScopePredicate): Promise<StoreStats> {
    const resolved = resolveScopeParams(scope);

    const aggRow = this.db.prepare(
      `SELECT COUNT(*) as total,
              MIN(created_at) as oldest,
              MAX(created_at) as newest
       FROM memory WHERE ${resolved.where}`,
    ).get(...resolved.values) as {
      total: number;
      oldest: number | null;
      newest: number | null;
    } | undefined;

    const total = aggRow?.total ?? 0;
    const oldest = aggRow?.oldest ?? null;
    const newest = aggRow?.newest ?? null;

    // Count by kind
    const kindRows = this.db.prepare(
      `SELECT kind, COUNT(*) as cnt FROM memory WHERE ${resolved.where} GROUP BY kind`,
    ).all(...resolved.values) as Array<{ kind: string; cnt: number }>;

    const byKind: Record<string, number> = {};
    for (const row of kindRows) {
      byKind[row.kind] = row.cnt;
    }

    // Approximate DB size from page count
    let dbBytes = 0;
    try {
      const pageRow = this.db.prepare("PRAGMA page_count").get() as
        | { page_count: number }
        | undefined;
      const pageSize = this.db.prepare("PRAGMA page_size").get() as
        | { page_size: number }
        | undefined;
      if (pageRow && pageSize) {
        dbBytes = pageRow.page_count * pageSize.page_size;
      }
    } catch {
      // Best effort
    }

    return {
      total,
      byKind: byKind as Readonly<Record<MemoryKind, number>>,
      oldest,
      newest,
      dbBytes,
    };
  }

  /** @inheritdoc */
  async touch(id: string): Promise<void> {
    this.touchRecord(id);
  }

  /** @inheritdoc */
  async supersede(oldId: string, newId: string): Promise<void> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }
    this.db.run(
      "UPDATE memory SET superseded_by = ? WHERE id = ?",
      [newId, oldId],
    );
  }

  /** @inheritdoc */
  async demoteWorktreeKey(projectId: string, worktreeKey: string): Promise<number> {
    if (this.config.readOnly) {
      throw new Error("[residue] Store is in read-only mode");
    }

    // Count records that will be demoted
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory WHERE scope = 'project' AND project_id = ? AND worktree_key = ?`,
    ).get(projectId, worktreeKey) as { cnt: number } | undefined;

    const count = countRow?.cnt ?? 0;
    if (count === 0) return 0;

    // Set worktree_key to NULL — records become visible across all worktrees in the project
    this.db.run(
      `UPDATE memory SET worktree_key = NULL WHERE scope = 'project' AND project_id = ? AND worktree_key = ?`,
      [projectId, worktreeKey],
    );

    return count;
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
    kind: row.kind as MemoryKind,
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
    confidence: row.confidence,
    created_at: row.created_at,
    last_access: row.last_access,
    access_count: row.access_count,
    superseded_by: row.superseded_by,
  };
}

/**
 * Remap raw FTS5 bm25 `rank` values onto a usable 0–1 scale.
 *
 * ## Why the old formula failed
 *
 * `1 / (1 + abs(rank))` assumed bm25 magnitudes of order 1. In practice
 * FTS5 returns values around `1e-6`, so **every** hit scored ~0.9999 and the
 * score carried no information — a strong match and a weak one were
 * indistinguishable, and downstream `score DESC` sorting became arbitrary.
 *
 * bm25 is negative, more-negative means better, and its absolute magnitude
 * depends on corpus size and query length, so no fixed constant can map it to
 * a comparable scale. The only stable reference point is the best rank *in the
 * current result set*.
 *
 * ## The remap
 *
 * Dividing by the best (most negative) rank makes the top hit exactly `1.0`
 * and spreads the remainder proportionally — independent of corpus size and
 * bm25's absolute scale. This is the same relative-normalization approach used
 * for RRF scores in `src/retrieval/search.ts`.
 *
 * Monotonic, so it never reorders results; it only makes the magnitudes
 * meaningful.
 *
 * @param ranks - Raw bm25 ranks from one FTS5 query, any order.
 * @returns Scores in [0, 1] aligned index-wise with `ranks`; best hit = 1.0.
 */
function ftsRanksToScores(ranks: readonly number[]): number[] {
  if (ranks.length === 0) return [];

  // Best bm25 is the most negative value in the set.
  let best = 0;
  for (const r of ranks) {
    if (r < best) best = r;
  }

  // Degenerate set (all zero / no usable signal) — no meaningful spread.
  // Fall back to a flat 1.0 rather than dividing by zero.
  if (!(best < 0)) return ranks.map(() => 1);

  return ranks.map((r) => {
    // A non-negative rank is not a valid bm25 result; treat as worst.
    if (!(r < 0)) return 0;
    const s = r / best; // both negative -> positive, <= 1
    return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  });
}

/**
 * Common English stopwords that carry no retrieval signal.
 *
 * Queries arrive from natural-language user prompts ("What is the deployment
 * pipeline canary cap?"), so these appear constantly and must not participate
 * in matching.
 *
 * Deliberately conservative: words that are often *content* in technical
 * prompts are excluded, even though they are stopwords in prose — "can" (as in
 * "canary"), "not"/"no" (negations carry the constraint), "use"/"get"/"make"
 * (the verbs users actually search for), "like", "up", "out", "down", "just".
 * Dropping those would silently lose real matches.
 */
const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
  "could", "did", "do", "does", "for", "from", "had", "has", "have", "he",
  "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "me", "more", "my", "of", "on", "or", "our", "over", "please", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "those", "to", "too", "us", "very",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

/**
 * Build candidate FTS5 query strings, most precise first.
 *
 * ## Why AND-then-OR
 *
 * The query is an entire natural-language user prompt, so pure AND semantics
 * are unusable: "What is the zorblax deployment pipeline canary cap?" becomes
 * `"what" AND "is" AND "the" AND ...`, and the stopwords alone make it
 * unsatisfiable — zero results for essentially every real prompt.
 *
 * Pure OR fixes recall but destroys precision on identifier-style queries.
 * Searching `worker-A` over records `worker-A-0`…`worker-B-49` must return
 * only the 50 A-records; OR collapses it to `worker` (the trailing `A` is a
 * stopword) and returns everything.
 *
 * So the precise form is attempted first, and the broad form is used only when
 * the precise one finds nothing. That keeps exact/identifier queries exact
 * while still retrieving natural-language prompts.
 *
 * Each term stays double-quoted so user text can never be FTS5 query syntax.
 *
 * @param query - Raw search query.
 * @returns Candidate FTS5 query strings, highest precision first.
 */
function buildFtsQueries(query: string): string[] {
  const terms = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return ['""'];

  // Precise: every term must be present. No stopword stripping here — a term
  // like the trailing "A" in "worker-A" is precisely the discriminating part.
  const precise = terms.map((t) => `"${t}"`).join(" AND ");

  // Broad fallback: drop stopwords and accept any term.
  const meaningful = terms.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase()));
  if (meaningful.length === 0 || meaningful.length === terms.length) {
    return [precise];
  }

  const recall = meaningful.map((t) => `"${t}"`).join(" OR ");
  return [precise, recall];
}
