/**
 * Core domain types for Residue memory system.
 *
 * @module core/types
 */

/** Kinds of memory records Residue can capture. */
export type MemoryKind = "fact" | "decision" | "pattern" | "digest" | "profile";

/** Scope for a memory record — project-local or global. */
export type Scope = "global" | "project";

/** Reference to the source material that produced a memory record. */
export interface SourceRef {
  /** Session ID that produced this record. */
  readonly sessionID: string;
  /** Message ID within the session, if applicable. */
  readonly messageID?: string;
  /** Timestamp when the record was created (ISO 8601). */
  readonly timestamp: string;
}

/** A single memory record stored in the database. */
export interface MemoryRecord {
  /** Unique identifier for this record. */
  readonly id: string;
  /** Kind of memory (fact, decision, pattern, etc.). */
  readonly kind: MemoryKind;
  /** Scope: project-local or global. */
  readonly scope: Scope;
  /** Project ID this record belongs to (null for global scope). */
  readonly project_id: string | null;
  /** Worktree key for isolation within a project. */
  readonly worktree_key: string;
  /** Branch name, if applicable. */
  readonly branch_key: string | null;
  /** The content/text of the memory record. */
  readonly content: string;
  /** Embedding vector, if computed. null when embeddings are unavailable. */
  readonly embedding: Float32Array | null;
  /** Source reference metadata. */
  readonly source: SourceRef;
  /** Optional tags for categorization. */
  readonly tags: readonly string[];
  /** Confidence score (0.0–1.0). Higher = more reliable. */
  readonly confidence: number;
  /** Epoch milliseconds when the record was created. */
  readonly created_at: number;
  /** Epoch milliseconds of last access (touch). */
  readonly last_access: number;
  /** Number of times this record has been accessed. */
  readonly access_count: number;
  /** ID of the record that supersedes this one, or null. */
  readonly superseded_by: string | null;
}

/** A search result hit from the memory store. */
export interface SearchHit {
  /** The matched memory record. */
  readonly record: MemoryRecord;
  /** Similarity score (0.0–1.0 for cosine, higher = more similar). */
  readonly score: number;
  /** Whether this hit was returned by full-text search (true) or vector similarity (false). */
  readonly ftsMatch: boolean;
}

/** Partial patch for updating an existing memory record. */
export interface MemoryPatch {
  /** New content text. */
  readonly content?: string;
  /** New tags. */
  readonly tags?: readonly string[];
  /** New confidence score. */
  readonly confidence?: number;
  /** Record ID that supersedes this one. */
  readonly superseded_by?: string | null;
}

/** A draft for creating a new memory record (before ID assignment). */
export interface MemoryDraft {
  /** Kind of memory. */
  readonly kind: MemoryKind;
  /** Scope. */
  readonly scope: Scope;
  /** Project ID (null for global). */
  readonly project_id: string | null;
  /** Worktree key. */
  readonly worktree_key: string;
  /** Branch key. */
  readonly branch_key: string | null;
  /** Content text. */
  readonly content: string;
  /** Embedding vector. */
  readonly embedding: Float32Array | null;
  /** Source reference. */
  readonly source: SourceRef;
  /** Tags. */
  readonly tags: readonly string[];
  /** Override creation timestamp (epoch ms). If omitted, Date.now() is used. */
  readonly created_at?: number;
}

/** Payload injected into the context hook for the model call. */
export interface InjectionPayload {
  /** Text to inject as a system part. */
  readonly text: string;
  /** Number of facts included. */
  readonly factCount: number;
  /** Characters used in the injection. */
  readonly charCount: number;
  /** Budget remaining after injection (chars). */
  readonly budgetRemaining: number;
}

/** Status information returned by res_status. */
export interface ResidueStatus {
  /** Plugin version. */
  readonly pluginVersion: string;
  /** Store version (schema version). */
  readonly storeVersion: number;
  /** SQLite driver used. */
  readonly driver: string;
  /** WAL mode enabled. */
  readonly walEnabled: boolean;
  /** FTS5 available. */
  readonly fts5Available: boolean;
  /** Number of project-scoped records. */
  readonly projectRecordCount: number;
  /** Number of global-scoped records. */
  readonly globalRecordCount: number;
  /** Embedder status. */
  readonly embedder: {
    readonly id: string;
    readonly degraded: boolean;
    readonly reason: string;
  };
  /** Data directory path. */
  readonly dataDir: string;
  /** Last injection budget info. */
  readonly lastInjection: {
    readonly factCount: number;
    readonly charCount: number;
  };
}
