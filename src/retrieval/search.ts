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
 * ## Score scale
 *
 * Raw RRF scores are rank-derived and bounded by `2/(k+1) ≈ 0.033`. They are
 * therefore rescaled by `normalizeRrfScores` against that fixed structural
 * bound before `minScore` is applied, so the configured threshold is
 * meaningful instead of discarding every hit.
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

  // --- Run both channels in parallel (they are independent) ---
  let lexicalHits: readonly SearchHit[] = [];
  let vectorHits: readonly SearchHit[] = [];
  let vectorDegraded = false;

  const lexicalPromise = (async () => {
    try {
      return await store.search(query, null, params.scope, channelLimit);
    } catch (err) {
      logger.warn(`[residue] lexical search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as readonly SearchHit[];
    }
  })();

  const vectorPromise = (async () => {
    if (embedder && !embedder.degraded) {
      try {
        const embedding = await embedder.embed(query);
        if (embedding) {
          return await store.search(query, embedding, params.scope, channelLimit);
        } else {
          vectorDegraded = true;
          logger.debug("[residue] vector channel: embed returned null");
          return [] as readonly SearchHit[];
        }
      } catch (err) {
        vectorDegraded = true;
        logger.warn(`[residue] vector search failed: ${err instanceof Error ? err.message : String(err)}`);
        return [] as readonly SearchHit[];
      }
    } else {
      vectorDegraded = true;
      return [] as readonly SearchHit[];
    }
  })();

  [lexicalHits, vectorHits] = await Promise.all([lexicalPromise, vectorPromise]);

  // --- Merge with RRF, then rescale ---
  // Raw RRF scores are rank-derived and bounded by 2/(k+1) ≈ 0.033 at k=60,
  // so they cannot be compared against a 0–1 `minScore` directly. They are
  // rescaled against that fixed structural bound (1.0 = ranked first in BOTH
  // channels) before the threshold is applied. See normalizeRrfScores.
  const merged = normalizeRrfScores(rrfMerge(lexicalHits, vectorHits, RRF_K));

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
// Score normalization
// ---------------------------------------------------------------------------

/**
 * Rescale RRF scores to a relative 0–1 scale.
 *
 * ## Why this is necessary
 *
 * RRF produces **rank-derived** scores, not similarity scores. The maximum
 * possible value is `2 / (k + 1)` — with the standard `k = 60` that is
 * `0.0328`, and a single-channel hit tops out at `0.0164`. Comparing those
 * against a 0–1 `minScore` threshold is a unit mismatch: with the default
 * `minScore` of `0.34`, **every** hit is discarded and injection silently
 * returns nothing. No corpus or query can produce a high enough score,
 * because the bound is structural.
 *
 * ## The fix
 *
 * Rescale against the **fixed structural bound** `2 / (k + 1)` — the score a
 * record would earn by ranking first in *both* channels — rather than against
 * the best hit in the result set.
 *
 * A fixed divisor matters. Dividing by the observed maximum would make the
 * top hit `1.0` for any result set, including a set where every hit is a poor
 * match, which silently reduces `minScore` to a no-op. Against the structural
 * bound the scale is stable and independent of the result set, so the one
 * signal RRF genuinely carries — **channel agreement** — survives:
 *
 * | Hit                                   | Normalized |
 * | ------------------------------------- | ---------- |
 * | rank 0 in both channels (best case)  | `1.000`    |
 * | rank 0 in one channel                 | `0.500`    |
 * | rank 17 in one channel (worst case)   | `0.391`    |
 *
 * ## What this cannot do
 *
 * RRF is rank-based, so it carries **no absolute relevance information**: a
 * rank-0 hit scores identically whether it is an excellent or a poor match.
 * No rescaling of the output can recover a semantic similarity floor. After
 * this fix `minScore` is a channel-agreement / rank-quality gate, not a
 * relevance floor — the documented "similarity score" framing in the README
 * is not accurate for fused results. Producing a true relevance floor would
 * require scoring on similarity rather than rank, which is a larger change.
 *
 * This transform is **monotonic**, so ranking and tie order are unchanged —
 * it affects only the threshold comparison.
 *
 * @param hits - Merged RRF hits, sorted by score descending.
 * @param k - The RRF constant used for merging (default `RRF_K`).
 * @returns Hits with scores rescaled to 0–1 against the structural bound.
 */
export function normalizeRrfScores(
  hits: readonly SearchHit[],
  k: number = RRF_K,
): SearchHit[] {
  if (hits.length === 0) return [];

  // Structural maximum: a record ranked first in both channels.
  const bound = 2 / (k + 1);
  if (!(bound > 0)) return [...hits];

  return hits.map((h) => ({ ...h, score: h.score / bound }));
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
