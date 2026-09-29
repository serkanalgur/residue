/**
 * Hybrid search — combines vector similarity and lexical (FTS5) retrieval
 * using Reciprocal Rank Fusion (RRF).
 *
 * ## Design
 *
 * Two independent retrieval channels run in parallel:
 *
 * 1. **Vector channel**: If an embedder is available, the query is embedded
 *    and compared against stored vectors via cosine similarity.
 * 2. **Lexical channel**: FTS5 full-text search against the memory store.
 *
 * Both channels ALWAYS run — when the embedder is null the vector channel
 * silently returns an empty list. Results are merged with RRF:
 *
 *     score(q, d) = Σ  1 / (k + rank_i(d))
 *                    i∈channels
 *
 * where `k = 60` (standard constant from the original RRF paper). RRF is
 * preferred over raw-score blending because cosine similarity and FTS5 BM25
 * live on incompatible scales — RRF only cares about rank order.
 *
 * @module retrieval/search
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { SearchHit } from "../core/types.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for hybrid search. */
export interface SearchOptions {
  /** Maximum results to retrieve per channel (over-fetch for fusion). */
  readonly channelLimit: number;
  /** Final limit after selection. */
  readonly limit: number;
  /** Minimum score threshold (0–1). Hits below this are discarded. */
  readonly minScore: number;
}

/** Parameters passed to the store for scope filtering. */
export interface SearchParams {
  /** Scope predicate for SQL WHERE clause. */
  readonly scope: ScopePredicate;
}

/** Result returned by hybridSearch. */
export interface HybridResult {
  /** Merged and ranked search hits. */
  readonly hits: readonly SearchHit[];
  /** Which channels contributed results. */
  readonly mode: "hybrid" | "lexical" | "vector";
  /** Whether the vector channel was unavailable. */
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF constant — controls the balance between top-rank and lower-rank items.
 *  k=60 is the standard value from the original RRF paper (Cormack et al. 2009). */
const RRF_K = 60;

// ---------------------------------------------------------------------------
// hybridSearch
// ---------------------------------------------------------------------------

/**
 * Execute a hybrid search across vector and lexical channels.
 *
 * @param store - Memory store with search capability.
 * @param embedder - Embedding provider (null = vector channel disabled).
 * @param query - Search query text.
 * @param options - Search configuration.
 * @param params - Scope and filter parameters.
 * @param logger - Logger for debug output.
 * @returns HybridResult with merged hits and metadata.
 */
export async function hybridSearch(
  store: MemoryStore,
  embedder: Embedder | null,
  query: string,
  options: SearchOptions,
  params: SearchParams,
  logger: Logger,
): Promise<HybridResult> {
  // Guard: empty query or invalid limits
  if (!query.trim() || options.limit <= 0 || options.minScore >= 1) {
    return { hits: [], mode: "lexical", degraded: embedder === null };
  }

  const channelLimit = Math.max(options.channelLimit, options.limit * 2);

  // --- Lexical channel (always runs) ---
  let lexicalHits: readonly SearchHit[] = [];
  try {
    lexicalHits = await store.search(query, null, params.scope, channelLimit);
  } catch (err) {
    logger.warn(`[residue] lexical search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Vector channel (runs if embedder available) ---
  let vectorHits: readonly SearchHit[] = [];
  let vectorDegraded = false;

  if (embedder && !embedder.degraded) {
    try {
      const embedding = await embedder.embed(query);
      if (embedding) {
        vectorHits = await store.search(query, embedding, params.scope, channelLimit);
      } else {
        vectorDegraded = true;
        logger.debug("[residue] vector channel: embed returned null");
      }
    } catch (err) {
      vectorDegraded = true;
      logger.warn(`[residue] vector search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    vectorDegraded = true;
  }

  // --- Merge with RRF ---
  const merged = rrfMerge(lexicalHits, vectorHits, RRF_K);

  // --- Filter by minScore ---
  const filtered = merged.filter((h) => h.score >= options.minScore);

  // --- Determine mode ---
  const hasLexical = lexicalHits.length > 0;
  const hasVector = vectorHits.length > 0;
  let mode: "hybrid" | "lexical" | "vector";
  if (hasLexical && hasVector) {
    mode = "hybrid";
  } else if (hasVector) {
    mode = "vector";
  } else {
    mode = "lexical";
  }

  logger.debug(
    `[residue] hybridSearch: lexical=${lexicalHits.length} vector=${vectorHits.length} ` +
    `merged=${filtered.length} mode=${mode} degraded=${vectorDegraded}`,
  );

  return {
    hits: filtered,
    mode,
    degraded: vectorDegraded,
  };
}

// ---------------------------------------------------------------------------
// RRF merge
// ---------------------------------------------------------------------------

/**
 * Merge two ranked lists using Reciprocal Rank Fusion.
 *
 * RRF formula: score(d) = Σ 1/(k + rank_i(d))
 *
 * Where rank_i(d) is the 1-based position of document d in channel i.
 * If a document appears in both channels, its scores are summed.
 *
 * Why RRF over raw-score blending: cosine similarity (0–1) and FTS5 BM25
 * rank (negative, unbounded) live on incompatible scales. RRF only needs
 * rank order, making it scale-invariant and robust.
 *
 * @param lexicalHits - Results from FTS5 channel.
 * @param vectorHits - Results from vector channel.
 * @param k - RRF constant (default 60).
 * @returns Merged hits sorted by RRF score descending.
 */
export function rrfMerge(
  lexicalHits: readonly SearchHit[],
  vectorHits: readonly SearchHit[],
  k: number = RRF_K,
): SearchHit[] {
  const scoreMap = new Map<string, { hit: SearchHit; score: number }>();

  // Process lexical channel
  for (let rank = 0; rank < lexicalHits.length; rank++) {
    const hit = lexicalHits[rank]!;
    const id = hit.record.id;
    const rrfContribution = 1 / (k + rank + 1); // rank is 1-based

    const existing = scoreMap.get(id);
    if (existing) {
      existing.score += rrfContribution;
    } else {
      scoreMap.set(id, { hit, score: rrfContribution });
    }
  }

  // Process vector channel
  for (let rank = 0; rank < vectorHits.length; rank++) {
    const hit = vectorHits[rank]!;
    const id = hit.record.id;
    const rrfContribution = 1 / (k + rank + 1); // rank is 1-based

    const existing = scoreMap.get(id);
    if (existing) {
      existing.score += rrfContribution;
    } else {
      scoreMap.set(id, { hit, score: rrfContribution });
    }
  }

  // Convert to array and sort by RRF score descending
  const merged: SearchHit[] = [];
  for (const entry of scoreMap.values()) {
    merged.push({ record: entry.hit.record, score: entry.score, ftsMatch: entry.hit.ftsMatch });
  }

  merged.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    // Deterministic tie-break: by id
    return a.record.id.localeCompare(b.record.id);
  });

  return merged;
}
