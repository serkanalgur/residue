/**
 * JSON Schema definitions for Residue tools.
 *
 * All schemas use plain JSON Schema (no Zod) as required by the V2 plugin API.
 *
 * @module tools/schemas
 */

/**
 * Schema for the `res_status` tool (zero parameters).
 *
 * Returns plugin health, store status, embedder state, and data directory info.
 */
export const STATUS_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

/**
 * Schema for the `res_search` tool.
 *
 * Hybrid search across project memory — combines lexical (FTS5) and
 * vector similarity via Reciprocal Rank Fusion.
 */
export const SEARCH_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "Search query for memory records",
    },
    scope: {
      type: "string" as const,
      enum: ["project", "global", "all"] as const,
      description: "Scope filter: project-local, global, or both",
      default: "all",
    },
    kind: {
      type: "string" as const,
      enum: ["fact", "decision", "pattern", "digest", "profile", "all"] as const,
      description: "Memory kind filter",
      default: "all",
    },
    limit: {
      type: "integer" as const,
      description: "Maximum number of results (1–20)",
      default: 5,
      minimum: 1,
      maximum: 20,
    },
    sinceDays: {
      type: "integer" as const,
      description: "Only include records created within the last N days",
      minimum: 1,
      maximum: 3650,
    },
    minScore: {
      type: "number" as const,
      description: "Minimum similarity score threshold (0.0–1.0)",
      default: 0.25,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `res_add` tool.
 *
 * Manually add a memory record. Provenance (source) is mandatory —
 * every record must trace back to a session and message.
 */
export const ADD_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    content: {
      type: "string" as const,
      description: "Memory content text (minimum 8 characters)",
      minLength: 8,
    },
    kind: {
      type: "string" as const,
      enum: ["fact", "decision", "pattern", "profile"] as const,
      description: "Type of memory record",
      default: "fact",
    },
    tags: {
      type: "array" as const,
      items: {
        type: "string" as const,
      },
      description: "Optional tags for categorization (max 8)",
      maxItems: 8,
    },
    scope: {
      type: "string" as const,
      enum: ["project", "global"] as const,
      description: "Scope: project-local or global",
      default: "project",
    },
    supersedes: {
      type: "string" as const,
      description: "ID of the record this one supersedes (optional)",
    },
    source: {
      type: "object" as const,
      description: "Provenance information (required)",
      properties: {
        path: {
          type: "string" as const,
          description: "File path of the source material",
        },
        line: {
          type: "integer" as const,
          description: "Line number in the source file",
          minimum: 1,
        },
      },
    },
  },
  required: ["content"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `res_forget` tool.
 *
 * Preview and delete memory records. Two-step workflow:
 * 1. Preview (confirm=false): returns matching records without deleting.
 * 2. Delete (confirm=true): removes the matched records.
 */
export const FORGET_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string" as const,
      description: "Delete exactly this record by ID",
    },
    query: {
      type: "string" as const,
      description: "Find matching records by text query",
    },
    scope: {
      type: "string" as const,
      enum: ["project", "global", "all"] as const,
      description: "Scope filter",
      default: "all",
    },
    kind: {
      type: "string" as const,
      enum: ["fact", "decision", "pattern", "digest", "profile", "all"] as const,
      description: "Memory kind filter",
      default: "all",
    },
    sinceDays: {
      type: "integer" as const,
      description: "Only include records created within the last N days",
      minimum: 1,
      maximum: 3650,
    },
    confirm: {
      type: "boolean" as const,
      description: "Confirm deletion. Default false (preview only).",
      default: false,
    },
  },
  additionalProperties: false,
} as const;

/**
 * Schema for the `res_profile` tool.
 *
 * Read-only cross-project aggregated view of durable preferences.
 */
export const PROFILE_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    includeProject: {
      type: "boolean" as const,
      description: "Include current project records alongside global. Default: false.",
      default: false,
    },
    maxScan: {
      type: "integer" as const,
      description: "Maximum records to scan (1–1000). Default: 200.",
      minimum: 1,
      maximum: 1000,
      default: 200,
    },
  },
  additionalProperties: false,
} as const;
