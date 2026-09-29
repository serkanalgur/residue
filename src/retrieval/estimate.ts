/**
 * Token estimation and budget management for injection.
 *
 * No external tokenizer is available, so we use a character-based heuristic:
 * `Math.ceil(chars / 3.6)` — this approximates English text at ~4 chars/token
 * with a slight conservative bias (3.6) to avoid over-injection.
 *
 * Sapra (measurement) is reported: every estimate includes the method and
 * observed error margin so callers can assess confidence.
 *
 * @module retrieval/estimate
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cost tier for pricing different model families. */
export type CostTier = "small" | "medium" | "large";

/** Cost per 1M tokens by tier. */
interface CostTable {
  readonly input: number;
  readonly output: number;
}

/** Result of token estimation with measurement metadata. */
export interface TokenEstimate {
  /** Estimated token count. */
  readonly tokens: number;
  /** Method used for estimation. */
  readonly method: "char_heuristic";
  /** Characters per token ratio used. */
  readonly charsPerToken: number;
  /** Observed error margin (±percentage). */
  readonly errorMargin: number;
}

/** Result of cost estimation. */
export interface CostEstimate {
  /** Estimated cost in USD. */
  readonly costUsd: number;
  /** Number of input tokens. */
  readonly inputTokens: number;
  /** Cost tier used. */
  readonly tier: CostTier;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters per token heuristic. English text averages ~4 chars/token;
 *  3.6 gives a conservative (slightly high) estimate to prevent over-injection. */
const CHARS_PER_TOKEN = 3.6;

/** Observed error margin for the char heuristic (±20%). */
const ERROR_MARGIN = 0.20;

/** Cost per 1M input tokens by tier (USD). */
const COST_TABLE: Record<CostTier, CostTable> = {
  small: { input: 0.15, output: 0.60 },   // e.g. GPT-4o-mini
  medium: { input: 2.50, output: 10.00 },  // e.g. GPT-4o
  large: { input: 10.00, output: 30.00 },  // e.g. Claude Opus
};

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a text string.
 *
 * Uses a character-based heuristic: ceil(chars / 3.6).
 * This is approximate but sufficient for budget enforcement.
 *
 * Measurement report: the heuristic has ~±20% error margin on English text,
 * ~±30% on code or non-Latin scripts. For production use, a real tokenizer
 * (tiktoken, etc.) should be substituted.
 *
 * @param text - Text to estimate tokens for.
 * @returns Token estimate with measurement metadata.
 */
export function estimateTokens(text: string): TokenEstimate {
  const chars = text.length;
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);

  return {
    tokens,
    method: "char_heuristic",
    charsPerToken: CHARS_PER_TOKEN,
    errorMargin: ERROR_MARGIN,
  };
}

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of a given number of input tokens.
 *
 * @param tokens - Number of tokens.
 * @param modelCost - Optional custom cost per 1M tokens (overrides tier).
 * @param tier - Cost tier for pricing (default: "small").
 * @returns Cost estimate in USD.
 */
export function estimateCost(
  tokens: number,
  modelCost: number | null,
  tier: CostTier = "small",
): CostEstimate {
  const costPerMillion = modelCost ?? COST_TABLE[tier].input;
  const costUsd = (tokens / 1_000_000) * costPerMillion;

  return {
    costUsd,
    inputTokens: tokens,
    tier,
  };
}

// ---------------------------------------------------------------------------
// clampToBudget
// ---------------------------------------------------------------------------

/**
 * Clamp text to a maximum character budget using sentence-aware truncation.
 *
 * Returns the truncated text and metadata about how much was trimmed.
 *
 * @param text - Text to clamp.
 * @param maxChars - Maximum characters allowed.
 * @returns Object with clamped text and trimming metadata.
 */
export function clampToBudget(
  text: string,
  maxChars: number,
): { text: string; trimmed: boolean; originalChars: number; finalChars: number } {
  if (text.length <= maxChars) {
    return { text, trimmed: false, originalChars: text.length, finalChars: text.length };
  }

  const truncated = text.slice(0, maxChars);

  // Try to find last sentence boundary
  const lastSentence = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );

  let result: string;
  if (lastSentence > maxChars * 0.3) {
    result = truncated.slice(0, lastSentence + 1).trimEnd();
  } else {
    // Fall back to last word boundary
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.3) {
      result = truncated.slice(0, lastSpace).trimEnd() + "...";
    } else {
      result = truncated.trimEnd() + "...";
    }
  }

  return {
    text: result,
    trimmed: true,
    originalChars: text.length,
    finalChars: result.length,
  };
}
