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
 * Schema for the `res_search` tool (future Faz 2+).
 *
 * Excluded from Phase 1 but documented here for reference.
 */
export const SEARCH_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "Search query for memory records",
    },
    limit: {
      type: "number",
      description: "Maximum number of results to return",
      default: 5,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;
