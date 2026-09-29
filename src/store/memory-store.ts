/**
 * In-memory implementation of the MemoryStore port for testing.
 *
 * Provides the same contract as SqliteStore without any disk I/O.
 * All data lives in JavaScript Maps and Arrays. Suitable for unit tests
 * and integration tests where database setup is undesirable.
 *
 * @module store/memory-store
 */

import type { MemoryDraft, MemoryRecord, SearchHit } from "../core/types.js";
import type { MemoryStore, ScopePredicate } from "../core/ports.js";
import { newId } from "../util/ids.js";

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
        const vecScore = cosineSimilarity(embedding, record.embedding);
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
      // Use source.timestamp as the creation time proxy
      const created = new Date(record.source.timestamp).getTime();
      if (created < cutoff) {
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

  /**
   * Get aggregate statistics.
   *
   * @param scope - Scope predicate.
   * @returns Statistics object.
   */
  async stats(scope: ScopePredicate): Promise<{
    readonly count: number;
    readonly totalContentLength: number;
    readonly avgConfidence: number;
  }> {
    let count = 0;
    let totalLen = 0;
    for (const record of this.records.values()) {
      if (!matchesPredicate(record, scope)) continue;
      count++;
      totalLen += record.content.length;
    }
    return {
      count,
      totalContentLength: totalLen,
      avgConfidence: 0.6, // Default confidence
    };
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

/**
 * Compute cosine similarity between two vectors.
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Cosine similarity.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
