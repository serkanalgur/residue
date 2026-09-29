/**
 * `res_add` tool — manually add a memory record.
 *
 * Inserts a new memory record with mandatory provenance (source).
 * Optionally embeds the content for vector search.
 *
 * @module tools/add
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { MemoryKind, Scope, MemoryDraft } from "../core/types.js";
import type { ResolvedScope } from "../core/ports.js";
import type { Logger } from "../log.js";
import { buildScopePredicate } from "../scope.js";
import { newId } from "../util/ids.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for res_add (matches ADD_TOOL_SCHEMA). */
export interface AddInput {
  readonly content: string;
  readonly kind?: "fact" | "decision" | "pattern" | "profile";
  readonly tags?: readonly string[];
  readonly scope?: "project" | "global";
  readonly supersedes?: string;
  readonly source?: {
    readonly path?: string;
    readonly line?: number;
  };
}

/** Dependencies injected into the add tool. */
export interface AddDeps {
  readonly store: MemoryStore;
  readonly embedder: Embedder | null;
  readonly resolved: ResolvedScope;
  readonly options: {
    readonly inject: {
      readonly shareAcrossWorktrees: boolean;
    };
  };
  readonly logger: Logger;
  readonly sessionID: string;
  readonly messageID?: string;
}

/** Minimal ToolContext shape used by our execute function. */
interface ToolContext {
  readonly signal?: AbortSignal;
  progress?(Update: { status: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validation error with field context. */
export class AddValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "AddValidationError";
  }
}

/**
 * Validate add input against business rules.
 * JSON Schema handles structural validation; this handles semantic rules.
 *
 * @param input - Raw input from the tool call.
 * @throws AddValidationError if validation fails.
 */
export function validateAddInput(input: AddInput): void {
  // Content minimum length
  if (typeof input.content !== "string" || input.content.trim().length < 8) {
    throw new AddValidationError(
      "Content must be at least 8 characters",
      "content",
    );
  }

  // Source is mandatory (provenance requirement)
  if (!input.source || typeof input.source !== "object") {
    throw new AddValidationError(
      "Source information is required. Every memory record must have provenance.",
      "source",
    );
  }

  // Tags max count
  if (input.tags && input.tags.length > 8) {
    throw new AddValidationError(
      "Maximum 8 tags allowed",
      "tags",
    );
  }

  // Kind validation
  const validKinds = ["fact", "decision", "pattern", "profile"];
  if (input.kind && !validKinds.includes(input.kind)) {
    throw new AddValidationError(
      `Invalid kind "${input.kind}". Must be one of: ${validKinds.join(", ")}`,
      "kind",
    );
  }

  // Scope validation
  const validScopes = ["project", "global"];
  if (input.scope && !validScopes.includes(input.scope)) {
    throw new AddValidationError(
      `Invalid scope "${input.scope}". Must be one of: ${validScopes.join(", ")}`,
      "scope",
    );
  }
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Execute the res_add tool.
 *
 * @param input - Tool input (validated against ADD_TOOL_SCHEMA).
 * @param context - Tool context with signal and progress.
 * @param deps - Injected dependencies (store, embedder, scope, etc.).
 * @returns Tool output with content string and metadata.
 */
export async function executeAdd(
  input: AddInput,
  context: ToolContext,
  deps: AddDeps,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const start = Date.now();

  // Check for cancellation
  context.signal?.throwIfAborted();

  // Validate input
  validateAddInput(input);

  await context.progress?.({ status: "Storing memory record..." });

  // Normalize
  const kind: MemoryKind = input.kind ?? "fact";
  const scope: Scope = input.scope ?? "project";

  // Build scope predicate for counting
  const scopeFilter = scope === "global" ? "global" as const : "project" as const;
  const scopePredicate = buildScopePredicate(scopeFilter, deps.resolved, deps.options);

  // Generate embedding (best effort)
  let embedding: Float32Array | null = null;
  if (deps.embedder && !deps.embedder.degraded) {
    try {
      embedding = await deps.embedder.embed(input.content);
    } catch (err) {
      deps.logger.debug(
        `[residue] embedding failed for add: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Build the worktree key
  const worktreeKey = scope === "global" ? "global" : deps.resolved.worktreeKey;

  // Build draft
  const draft: MemoryDraft = {
    kind,
    scope,
    project_id: scope === "global" ? null : deps.resolved.projectID,
    worktree_key: worktreeKey,
    branch_key: scope === "global" ? null : deps.resolved.branchKey,
    content: input.content.trim(),
    embedding,
    source: {
      sessionID: deps.sessionID,
      messageID: deps.messageID,
      timestamp: new Date().toISOString(),
    },
    tags: input.tags ?? [],
  };

  // Insert into store
  const record = await deps.store.insert(draft);

  const elapsedMs = Date.now() - start;

  // Build output
  const tagsStr = record.tags.length > 0 ? ` tags=[${record.tags.join(", ")}]` : "";
  const output =
    `Memory stored: ${record.id} [${record.kind.toUpperCase()}] ` +
    `scope=${record.scope}${tagsStr} content="${record.content.slice(0, 80)}${record.content.length > 80 ? "..." : ""}"`;

  return {
    content: output,
    metadata: {
      id: record.id,
      kind: record.kind,
      scope: record.scope,
      hasEmbedding: embedding !== null,
      elapsedMs,
    },
  };
}
