/**
 * Port interfaces (hexagonal architecture) for Residue's pluggable backends.
 *
 * @module core/ports
 */

import type { MemoryDraft, MemoryKind, MemoryPatch, MemoryRecord, SearchHit } from "./types.js";

/** Scope predicate parameters for SQL WHERE clauses. */
export interface ScopePredicate {
  /** SQL WHERE fragment with named placeholders. */
  readonly where: string;
  /** Bound parameters for the predicate. */
  readonly params: Record<string, string | null>;
}

/** Resolved scope context for a plugin invocation. */
export interface ResolvedScope {
  /** Project ID from the current location. */
  readonly projectID: string;
  /** SHA-256 hash of the working directory (worktree isolation key). */
  readonly worktreeKey: string;
  /** Current VCS branch name, or null if detached/unknown. */
  readonly branchKey: string | null;
  /** Canonical project directory. */
  readonly canonicalDir: string;
}

/** Options for the `scan` method. */
export interface ScanOptions {
  /** Scope predicate to filter records. */
  readonly scope: ScopePredicate;
  /** Optional kind filter. */
  readonly kind?: MemoryKind;
  /** Only records created on or after this epoch ms. */
  readonly since?: number;
  /** Only records created on or before this epoch ms. */
  readonly until?: number;
  /** Maximum number of records to return. */
  readonly limit?: number;
  /** Number of records to skip (for pagination). */
  readonly offset?: number;
}

/** Aggregated store statistics. */
export interface StoreStats {
  /** Total number of records matching the scope. */
  readonly total: number;
  /** Record count broken down by kind. */
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  /** Epoch ms of the oldest record, or null if no records. */
  readonly oldest: number | null;
  /** Epoch ms of the newest record, or null if no records. */
  readonly newest: number | null;
  /** Approximate database size in bytes (0 for in-memory store). */
  readonly dbBytes: number;
}

/**
 * Persistent storage backend for memory records.
 *
 * Implementations must be thread-safe and respect scope isolation:
 * project-scoped records are only visible within their project + worktree.
 */
export interface MemoryStore {
  /** Initialize the store (create tables, run migrations). */
  initialize(): Promise<void>;

  /** Insert a memory draft and return the persisted record. */
  insert(draft: MemoryDraft): Promise<MemoryRecord>;

  /** Retrieve a single record by ID, or null if not found. */
  get(id: string): Promise<MemoryRecord | null>;

  /** Update a record by ID with a partial patch. Returns the updated record or null. */
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord | null>;

  /** Remove a single record by ID. Returns true if removed, false if not found. */
  remove(id: string): Promise<boolean>;

  /** Remove multiple records by ID. Returns the count removed. Transactional. */
  removeMany(ids: readonly string[]): Promise<number>;

  /** Search for relevant records using hybrid (vector + FTS5) retrieval. */
  search(
    query: string,
    embedding: Float32Array | null,
    scope: ScopePredicate,
    limit: number,
  ): Promise<readonly SearchHit[]>;

  /** Count records matching a scope predicate. */
  count(scope: ScopePredicate): Promise<number>;

  /** List records under a scope predicate with filters, ordered by created_at DESC. */
  scan(options: ScanOptions): Promise<readonly MemoryRecord[]>;

  /** Get aggregated statistics about records in a scope. */
  stats(scope: ScopePredicate): Promise<StoreStats>;

  /** Update last_access and increment access_count for a record. */
  touch(id: string): Promise<void>;

  /** Mark a record as superseded by another record. */
  supersede(oldId: string, newId: string): Promise<void>;

  /**
   * Demote records: set worktree_key to NULL for all project-scoped records
   * matching a specific project_id and worktree_key.
   *
   * Used by worktree lifecycle to widen scope when a worktree is removed.
   * Records are NOT deleted — their worktree association is dissolved.
   *
   * @param projectId - Project ID to demote within.
   * @param worktreeKey - Worktree key whose records should be demoted.
   * @returns Number of records demoted.
   */
  demoteWorktreeKey(projectId: string, worktreeKey: string): Promise<number>;

  /** Close the underlying connection. */
  close(): Promise<void>;
}

/**
 * Embedding provider for vector similarity search.
 *
 * Implementations convert text to fixed-dimensional vectors.
 */
export interface Embedder {
  /** Unique identifier for this embedder (e.g., "openai-text-embedding-3-small"). */
  readonly id: string;

  /** Whether this embedder is degraded (e.g., API key missing). */
  readonly degraded: boolean;

  /** Reason for degradation, if applicable. */
  readonly reason?: string;

  /** Embed a single text string. Returns null if embedding fails. */
  embed(text: string): Promise<Float32Array | null>;

  /** Embed multiple texts in batch. Returns null for failed items. */
  embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]>;

  /** The dimension of vectors produced by this embedder. */
  readonly dimension: number;
}

/** Resolved embedder with fallback handling. */
export interface ResolvedEmbedder {
  /** The active embedder, or null if none available. */
  readonly embedder: Embedder | null;
  /** Whether the system is running in degraded mode (no embeddings). */
  readonly degraded: boolean;
  /** Reason for degraded mode. */
  readonly reason?: string;
}
