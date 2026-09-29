/**
 * In-memory implementation of the MemoryStore port for testing.
 *
 * Provides the same contract as SqliteStore without any disk I/O.
 * All data lives in JavaScript Maps and Arrays. Suitable for unit tests
 * and integration tests where database setup is undesirable.
 *
 * @module store/memory-store
 */

import type { MemoryDraft, MemoryKind, MemoryPatch, MemoryRecord, SearchHit } from "../core/types.js";
import type { MemoryStore, ScopePredicate, ScanOptions, StoreStats } from "../core/ports.js";
import { newId } from "../util/ids.js";
import { cosine } from "../embed/normalize.js";

/**
 * In-memory memory store implementing the MemoryStore port.
 *
 * Uses Maps for O(1) lookup by ID and Arrays for sequential scan.
 * Vector similarity search uses brute-force cosine similarity.
 */
export class InMemoryStore implements MemoryStore {
  private records: Map<string, MemoryRecord> = new Map();

  /** @inheritdoc */
  async initialize(): Promise<void> {
    // No-op — data is already in memory
  }

  /** @inheritdoc */
  async insert(draft: MemoryDraft): Promise<MemoryRecord> {
    const id = newId();
    const now = Date.now();
    const createdAt = draft.created_at ?? now;
    const record: MemoryRecord = {
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
    this.records.set(id, record);
    return record;
  }

  /** @inheritdoc */
  async search(
    query: string,
    embedding: Float32Array | null,
    scope: ScopePredicate,
    limit: number,
  ): Promise<readonly SearchHit[]> {
    const hits: SearchHit[] = [];

    for (const record of this.records.values()) {
      if (!matchesPredicate(record, scope)) continue;

      let score = 0;
      let ftsMatch = false;

      // Text match scoring (simple contains + term overlap)
      if (query.trim()) {
        const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
        const contentLower = record.content.toLowerCase();
        const matchedTerms = terms.filter((t) => contentLower.includes(t));
        if (matchedTerms.length > 0) {
          score = matchedTerms.length / terms.length;
          ftsMatch = true;
        }
      }

      // Vector similarity scoring
      if (embedding && record.embedding) {
        const vecScore = cosine(embedding, record.embedding);
        // Combine scores (vector takes precedence if available)
        score = Math.max(score, vecScore);
      }

      if (score > 0) {
        hits.push({ record, score, ftsMatch });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** @inheritdoc */
  async count(scope: ScopePredicate): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (matchesPredicate(record, scope)) count++;
    }
    return count;
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    this.records.clear();
  }

  /** @inheritdoc */
  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id) ?? null;
  }

  /** @inheritdoc */
  async update(id: string, patch: MemoryPatch): Promise<MemoryRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;

    const updated: MemoryRecord = {
      ...existing,
      content: patch.content ?? existing.content,
      tags: patch.tags ?? existing.tags,
      confidence: patch.confidence ?? existing.confidence,
      superseded_by:
        patch.superseded_by !== undefined ? patch.superseded_by : existing.superseded_by,
    };
    this.records.set(id, updated);
    return updated;
  }

  /** @inheritdoc */
  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  /** @inheritdoc */
  async removeMany(ids: readonly string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.records.delete(id)) count++;
    }
    return count;
  }

  /** @inheritdoc */
  async scan(options: ScanOptions): Promise<readonly MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (!matchesPredicate(record, options.scope)) continue;
      if (options.kind && record.kind !== options.kind) continue;
      if (options.since !== undefined && record.created_at < options.since) continue;
      if (options.until !== undefined && record.created_at > options.until) continue;
      results.push(record);
    }
    // Sort by created_at DESC
    results.sort((a, b) => b.created_at - a.created_at);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  /** @inheritdoc */
  async stats(scope: ScopePredicate): Promise<StoreStats> {
    let total = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    const byKind: Record<string, number> = {};

    for (const record of this.records.values()) {
      if (!matchesPredicate(record, scope)) continue;
      total++;
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      if (oldest === null || record.created_at < oldest) oldest = record.created_at;
      if (newest === null || record.created_at > newest) newest = record.created_at;
    }

    return {
      total,
      byKind: byKind as Readonly<Record<MemoryKind, number>>,
      oldest,
      newest,
      dbBytes: 0, // In-memory store has no disk footprint
    };
  }

  /** @inheritdoc */
  async touch(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    // MemoryRecord is readonly, so we create a new object
    const updated: MemoryRecord = {
      ...record,
      last_access: Date.now(),
      access_count: record.access_count + 1,
    };
    this.records.set(id, updated);
  }

  /** @inheritdoc */
  async supersede(oldId: string, newId: string): Promise<void> {
    const record = this.records.get(oldId);
    if (!record) return;
    const updated: MemoryRecord = {
      ...record,
      superseded_by: newId,
    };
    this.records.set(oldId, updated);
  }

  /**
   * Delete records matching a scope predicate.
   *
   * @param scope - Scope predicate to filter records.
   * @returns Number of deleted records.
   */
  async delete(scope: ScopePredicate): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (matchesPredicate(record, scope)) {
        this.records.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Apply TTL-based retention: delete records older than maxAgeMs.
   *
   * @param maxAgeMs - Maximum age in milliseconds.
   * @param scope - Scope predicate to limit deletion.
   * @returns Number of deleted records.
   */
  async retention(maxAgeMs: number, scope: ScopePredicate): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (!matchesPredicate(record, scope)) continue;
      if (record.created_at < cutoff) {
        this.records.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Apply LRU-based retention: keep only the top N most recently accessed records.
   *
   * In memory store, we use the source timestamp as access proxy.
   *
   * @param maxCount - Maximum number of records to keep.
   * @param scope - Scope predicate to limit retention.
   * @returns Number of deleted records.
   */
  async retentionLru(maxCount: number, scope: ScopePredicate): Promise<number> {
    const matching: Array<[string, MemoryRecord]> = [];
    for (const [id, record] of this.records) {
      if (matchesPredicate(record, scope)) {
        matching.push([id, record]);
      }
    }

    if (matching.length <= maxCount) return 0;

    // Sort by source timestamp ascending (oldest first)
    matching.sort(
      (a, b) =>
        new Date(a[1].source.timestamp).getTime() -
        new Date(b[1].source.timestamp).getTime(),
    );

    const toDelete = matching.slice(0, matching.length - maxCount);
    for (const [id] of toDelete) {
      this.records.delete(id);
    }
    return toDelete.length;
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a record matches a scope predicate.
 *
 * This is a simplified check for in-memory testing. It handles the three
 * scope filter modes: "global", "project", and "both".
 *
 * For testing purposes, we check the params map for :pid and :wk values
 * and compare them against the record's fields.
 *
 * @param record - Memory record to check.
 * @param scope - Scope predicate with params.
 * @returns True if the record matches the predicate.
 */
function matchesPredicate(
  record: MemoryRecord,
  scope: ScopePredicate,
): boolean {
  const where = scope.where;

  // Global-only
  if (where === "scope = 'global'") {
    return record.scope === "global";
  }

  // Project-only with worktree
  if (
    where.includes("scope = 'project'") &&
    where.includes("project_id = :pid") &&
    where.includes("worktree_key = :wk")
  ) {
    return (
      record.scope === "project" &&
      record.project_id === scope.params[":pid"] &&
      record.worktree_key === scope.params[":wk"]
    );
  }

  // Project-only without worktree (shareAcrossWorktrees)
  if (
    where.includes("scope = 'project'") &&
    where.includes("project_id = :pid") &&
    !where.includes("worktree_key")
  ) {
    return (
      record.scope === "project" &&
      record.project_id === scope.params[":pid"]
    );
  }

  // Both (global + project with worktree)
  if (
    where.includes("scope = 'global'") &&
    where.includes("project_id = :pid") &&
    where.includes("worktree_key")
  ) {
    if (record.scope === "global") return true;
    return (
      record.scope === "project" &&
      record.project_id === scope.params[":pid"] &&
      record.worktree_key === scope.params[":wk"]
    );
  }

  // Both (global + project without worktree)
  if (
    where.includes("scope = 'global'") &&
    where.includes("project_id = :pid") &&
    !where.includes("worktree_key")
  ) {
    if (record.scope === "global") return true;
    return (
      record.scope === "project" &&
      record.project_id === scope.params[":pid"]
    );
  }

  // Fallback: match all
  return true;
}


