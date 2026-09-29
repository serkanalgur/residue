/**
 * Post-retrieval selection — applies maxFacts, minScore, MMR diversity,
 * maxChars budget, and recency decay to search hits.
 *
 * ## Design
 *
 * After hybrid retrieval returns a candidate set, `select()` refines it:
 *
 * 1. **minScore filter** — discard low-relevance hits.
 * 2. **MMR (Maximal Marginal Relevance)** — balance relevance and diversity
 *    to avoid returning near-duplicate records.
 * 3. **maxFacts cap** — hard limit on count.
 * 4. **maxChars budget** — never exceed the character budget; trim via
 *    sentence-aware truncation.
 * 5. **Recency decay** — lightly penalise frequently accessed / old records.
 *
 * All operations are deterministic: same input → same output.
 *
 * @module retrieval/select
 */

import type { SearchHit } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options controlling selection behaviour. */
export interface SelectOptions {
  /** Maximum number of facts to return. */
  readonly maxFacts: number;
  /** Minimum score threshold (0–1). */
  readonly minScore: number;
  /** Maximum total characters across all selected facts. */
  readonly maxChars: number;
}

/** Access metadata for recency decay (optional enrichment). */
export interface AccessMeta {
  /** Number of times this record has been accessed. */
  readonly accessCount: number;
  /** Timestamp of last access (ms since epoch). */
  readonly lastAccess: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MMR lambda — trade-off between relevance (1.0) and diversity (0.0). */
const MMR_LAMBDA = 0.7;

/** Similarity threshold above which the second record is demoted. */
const MMR_DEDUP_THRESHOLD = 0.92;

/** Recency decay: percentage decrease per day since last access. */
const DECAY_PER_DAY = 0.005; // 0.5% per day

/** Minimum recency score (floor). */
const DECAY_FLOOR = 0.005; // 0.5%

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

/**
 * Select the best subset of search hits.
 *
 * Applies minScore, MMR diversity, maxFacts cap, maxChars budget,
 * and recency decay. Deterministic: ties broken by (score desc, id asc).
 *
 * @param hits - Candidate search hits from hybrid retrieval.
 * @param options - Selection configuration.
 * @param accessMap - Optional map of record ID → access metadata.
 * @returns Selected hits, sorted by final score descending.
 */
export function select(
  hits: readonly SearchHit[],
  options: SelectOptions,
  accessMap?: Map<string, AccessMeta>,
): SearchHit[] {
  if (hits.length === 0 || options.maxFacts <= 0 || options.maxChars <= 0) {
    return [];
  }

  // 1. Filter by minScore
  let candidates = hits.filter((h) => h.score >= options.minScore);

  // 2. Sort deterministically: score desc, then id asc for ties
  candidates = [...candidates].sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.record.id.localeCompare(b.record.id);
  });

  // 3. MMR diversity selection
  const selected = mmrSelect(candidates, options.maxFacts, MMR_LAMBDA);

  // 4. Apply recency decay
  const now = Date.now();
  const decayed = selected.map((hit) => {
    const meta = accessMap?.get(hit.record.id);
    if (!meta) return hit;

    const daysSinceAccess = Math.max(0, (now - meta.lastAccess) / (24 * 60 * 60 * 1000));
    const decayFactor = Math.max(DECAY_FLOOR, 1 - daysSinceAccess * DECAY_PER_DAY);

    // Apply access frequency penalty: more accesses → slightly lower priority
    const freqPenalty = Math.max(0.9, 1 - meta.accessCount * 0.001);

    return {
      ...hit,
      score: hit.score * decayFactor * freqPenalty,
    };
  });

  // Re-sort after decay
  decayed.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.record.id.localeCompare(b.record.id);
  });

  // 5. Enforce maxChars budget via token-aware trimming
  const budgeted = clampToBudget(decayed, options.maxChars);

  return budgeted;
}

// ---------------------------------------------------------------------------
// MMR selection
// ---------------------------------------------------------------------------

/**
 * Maximal Marginal Relevance selection.
 *
 * Greedily selects documents that balance relevance to the query with
 * diversity from already-selected documents.
 *
 * MMR = λ · sim(q, d) − (1−λ) · max sim(d, selected_j)
 *
 * @param candidates - Pre-sorted candidates (score desc).
 * @param maxCount - Maximum documents to select.
 * @param lambda - Relevance vs diversity trade-off (0–1).
 * @returns Selected documents.
 */
function mmrSelect(
  candidates: readonly SearchHit[],
  maxCount: number,
  lambda: number,
): SearchHit[] {
  if (candidates.length <= maxCount) {
    return [...candidates];
  }

  const selected: SearchHit[] = [];
  const remaining = [...candidates];

  while (selected.length < maxCount && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;

      // Max similarity to any already-selected document
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = contentSimilarity(candidate.record.content, sel.record.content);
        if (sim > maxSimToSelected) {
          maxSimToSelected = sim;
        }
      }

      // MMR score
      const mmr = lambda * candidate.score - (1 - lambda) * maxSimToSelected;

      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    const chosen = remaining[bestIdx]!;

    // Deduplication: if chosen is > 0.92 similar to any already-selected, skip it
    let isDuplicate = false;
    for (const sel of selected) {
      if (contentSimilarity(chosen.record.content, sel.record.content) > MMR_DEDUP_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    remaining.splice(bestIdx, 1);

    if (!isDuplicate) {
      selected.push(chosen);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Content similarity (for MMR dedup)
// ---------------------------------------------------------------------------

/**
 * Simple Jaccard similarity on word-level tokens.
 *
 * Used for MMR dedup — not for relevance scoring. Fast and deterministic.
 *
 * @param a - First content string.
 * @param b - Second content string.
 * @returns Jaccard similarity in [0, 1].
 */
function contentSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenize text into lowercase word tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

/**
 * Clamp selected hits to a character budget.
 *
 * Uses sentence-aware truncation: if a fact would exceed the remaining
 * budget, it is truncated at the last sentence boundary that fits.
 *
 * @param hits - Selected hits (already sorted by score).
 * @param maxChars - Maximum total characters.
 * @returns Hits that fit within the budget.
 */
function clampToBudget(hits: readonly SearchHit[], maxChars: number): SearchHit[] {
  const result: SearchHit[] = [];
  let remaining = maxChars;

  for (const hit of hits) {
    const content = hit.record.content;

    if (content.length <= remaining) {
      result.push(hit);
      remaining -= content.length;
    } else if (remaining > 20) {
      // Truncate at sentence boundary
      const truncated = truncateAtSentence(content, remaining);
      if (truncated.length > 0) {
        result.push({
          ...hit,
          record: { ...hit.record, content: truncated },
        });
        remaining = 0;
      }
    }

    if (remaining <= 0) break;
  }

  return result;
}

/**
 * Truncate text at the last sentence boundary that fits within maxLen.
 *
 * Sentence boundaries are `.`, `!`, `?` followed by whitespace or end of string.
 * If no sentence boundary fits, truncates at the last word boundary.
 *
 * @param text - Text to truncate.
 * @param maxLen - Maximum character length.
 * @returns Truncated text.
 */
function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const truncated = text.slice(0, maxLen);

  // Try to find last sentence boundary
  const lastSentence = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );

  if (lastSentence > maxLen * 0.3) {
    return truncated.slice(0, lastSentence + 1).trimEnd();
  }

  // Fall back to last word boundary — cap at maxLen - 3 to leave room for "..."
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.3) {
    const base = truncated.slice(0, lastSpace).trimEnd();
    return base.length + 3 <= maxLen ? base + "..." : base.slice(0, maxLen - 3) + "...";
  }

  return truncated.slice(0, maxLen - 3).trimEnd() + "...";
}
