/**
 * Retrieval module — public API surface.
 *
 * Re-exports query building, hybrid search, post-retrieval selection,
 * and token estimation.
 *
 * @module retrieval
 */

export { buildQuery, validateScopeBind } from "./query.js";
export type { QueryFilters, BuiltQuery } from "./query.js";

export { hybridSearch, rrfMerge, normalizeRrfScores } from "./search.js";
export type { SearchOptions, SearchParams, HybridResult } from "./search.js";

export { select } from "./select.js";
export type { SelectOptions, AccessMeta } from "./select.js";

export { estimateTokens, estimateCost, clampToBudget } from "./estimate.js";
export type { CostTier, TokenEstimate, CostEstimate } from "./estimate.js";
