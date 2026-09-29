/**
 * Port interfaces (hexagonal architecture) for Residue's pluggable backends.
 *
 * @module core/ports
 */

import type { MemoryDraft, MemoryRecord, SearchHit } from "./types.js";

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

  /** Search for relevant records using hybrid (vector + FTS5) retrieval. */
  search(
    query: string,
    embedding: Float32Array | null,
    scope: ScopePredicate,
    limit: number,
  ): Promise<readonly SearchHit[]>;

  /** Count records matching a scope predicate. */
  count(scope: ScopePredicate): Promise<number>;

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
