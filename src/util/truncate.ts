/**
 * Shared truncation utilities.
 *
 * Canonical implementation of `truncateAtSentence` — used by render.ts,
 * select.ts, and estimate.ts. Single source of truth.
 *
 * @module util/truncate
 */

/**
 * Truncate text at the last sentence boundary that fits within maxLen.
 *
 * Sentence boundaries are `.`, `!`, `?` followed by whitespace or end of string.
 * If no sentence boundary fits, truncates at the last word boundary.
 *
 * @param text - Text to truncate.
 * @param maxLen - Maximum character length.
 * @returns Truncated text, ending with "..." if truncated mid-sentence.
 */
export function truncateAtSentence(text: string, maxLen: number): string {
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
