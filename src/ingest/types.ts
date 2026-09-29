/**
 * Types for the session ingestion module.
 *
 * @module ingest/types
 */

import type { MemoryDraft } from "../core/types.js";

/** Raw extraction item from the LLM (before validation and draft building). */
export interface RawExtraction {
  /** Content text of the memory. */
  readonly text: string;
  /** Kind string (may be invalid — must be validated against MemoryKind). */
  readonly kind: string;
  /** Tags for categorization. */
  readonly tags: readonly string[];
  /** Confidence score (0..1). */
  readonly confidence: number;
  /** Reference to a previous fact this contradicts, if applicable. */
  readonly contradicts?: string;
}

/** JSON response shape from the extraction prompt. */
export interface ExtractionResponse {
  readonly memories: readonly RawExtraction[];
}

/** Result of extraction: validated drafts ready for store insertion. */
export interface ExtractionResult {
  /** Validated memory drafts with provenance. */
  readonly drafts: readonly MemoryDraft[];
  /** Number of raw items that failed validation. */
  readonly rejectedCount: number;
  /** Total raw items returned by the model. */
  readonly rawCount: number;
}

/** Configuration for the ingestion pipeline. */
export interface IngestOptions {
  /** Whether auto-capture is enabled. */
  readonly autoCapture: boolean;
  /** Model to use for extraction. */
  readonly extractModel?: { readonly id: string; readonly providerID: string; readonly variant?: string };
  /** Maximum facts to extract per idle event. */
  readonly maxFactsPerIdle: number;
  /** Minimum interval between extractions for a session (ms). */
  readonly minIntervalMs: number;
  /** Maximum extractions per session (anti-feedback loop). */
  readonly extractionsPerSession: number;
  /** Ring buffer capacity per session (number of messages). */
  readonly bufferCapacity: number;
  /** Maximum total characters per session in the buffer. */
  readonly bufferMaxChars: number;
}

/** Default ingest options. */
export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  autoCapture: true,
  maxFactsPerIdle: 8,
  minIntervalMs: 20_000,
  extractionsPerSession: 20,
  bufferCapacity: 200,
  bufferMaxChars: 100_000,
};

/** Dependencies required by the ingestion pipeline. */
export interface IngestDeps {
  /** Resolved scope context. */
  readonly resolved: {
    readonly projectID: string;
    readonly worktreeKey: string;
    readonly branchKey: string | null;
    readonly canonicalDir: string;
  };
  /** Active memory store. */
  readonly store: {
    readonly insert: (draft: MemoryDraft) => Promise<unknown>;
  };
  /** Text generation function from plugin context. */
  readonly generateText: (opts: {
    readonly prompt: string;
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string };
  }) => Promise<{ readonly text: string }>;
  /** Default model getter from plugin context. */
  readonly defaultModel: () => { readonly id: string; readonly providerID: string; readonly variant?: string } | Promise<{ readonly id: string; readonly providerID: string; readonly variant?: string }>;
}
