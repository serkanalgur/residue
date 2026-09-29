/**
 * Tests for token estimation, cost calculation, and budget clamping.
 *
 * @module test/retrieval.estimate
 */

import { describe, it, expect } from "bun:test";
import { estimateTokens, estimateCost, clampToBudget } from "../src/retrieval/estimate.js";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates tokens for empty string", () => {
    const result = estimateTokens("");
    expect(result.tokens).toBe(0);
    expect(result.method).toBe("char_heuristic");
  });

  it("estimates tokens for short text", () => {
    const result = estimateTokens("Hello world");
    // 11 chars / 3.6 = 3.06 → ceil = 4
    expect(result.tokens).toBe(4);
  });

  it("estimates tokens for longer text", () => {
    const result = estimateTokens("TypeScript is a typed superset of JavaScript");
    // 44 chars / 3.6 = 12.22 → ceil = 13
    expect(result.tokens).toBe(13);
  });

  it("reports measurement metadata", () => {
    const result = estimateTokens("test");
    expect(result.method).toBe("char_heuristic");
    expect(result.charsPerToken).toBe(3.6);
    expect(result.errorMargin).toBe(0.20);
  });

  it("is monotonically increasing with text length", () => {
    const short = estimateTokens("abc");
    const medium = estimateTokens("abc".repeat(10));
    const long = estimateTokens("abc".repeat(100));

    expect(short.tokens).toBeLessThan(medium.tokens);
    expect(medium.tokens).toBeLessThan(long.tokens);
  });
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  it("calculates cost for small tier", () => {
    const result = estimateCost(1000, null, "small");
    // 1000 tokens * $0.15 / 1_000_000 = $0.00015
    expect(result.costUsd).toBeCloseTo(0.00015, 6);
    expect(result.tier).toBe("small");
    expect(result.inputTokens).toBe(1000);
  });

  it("calculates cost for medium tier", () => {
    const result = estimateCost(10000, null, "medium");
    // 10000 tokens * $2.50 / 1_000_000 = $0.025
    expect(result.costUsd).toBeCloseTo(0.025, 4);
  });

  it("calculates cost for large tier", () => {
    const result = estimateCost(100000, null, "large");
    // 100000 tokens * $10.00 / 1_000_000 = $1.00
    expect(result.costUsd).toBeCloseTo(1.0, 2);
  });

  it("uses custom model cost when provided", () => {
    const result = estimateCost(1000, 5.0, "small");
    // 1000 tokens * $5.00 / 1_000_000 = $0.005
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });

  it("returns zero cost for zero tokens", () => {
    const result = estimateCost(0, null, "small");
    expect(result.costUsd).toBe(0);
  });

  it("defaults to small tier", () => {
    const result = estimateCost(1000, null);
    expect(result.tier).toBe("small");
  });
});

// ---------------------------------------------------------------------------
// clampToBudget
// ---------------------------------------------------------------------------

describe("clampToBudget", () => {
  it("returns original text when within budget", () => {
    const text = "Short text";
    const result = clampToBudget(text, 100);
    expect(result.text).toBe(text);
    expect(result.trimmed).toBe(false);
    expect(result.originalChars).toBe(10);
    expect(result.finalChars).toBe(10);
  });

  it("truncates at sentence boundary", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const result = clampToBudget(text, 30);
    expect(result.trimmed).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(30);
    expect(result.text).toMatch(/[.!?]$/);
  });

  it("falls back to word boundary when no sentence fits", () => {
    const text = "NoPeriodOrQuestionOrExclamation marks here at all";
    const result = clampToBudget(text, 30);
    expect(result.trimmed).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(33); // + "..."
  });

  it("adds ellipsis when truncating at word boundary", () => {
    const text = "This is a very long string without any punctuation marks";
    const result = clampToBudget(text, 25);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("...");
  });

  it("handles very small budget gracefully", () => {
    const text = "Hello world this is a test";
    const result = clampToBudget(text, 5);
    expect(result.trimmed).toBe(true);
    expect(result.finalChars).toBeLessThanOrEqual(8); // 5 + "..."
  });

  it("handles empty text", () => {
    const result = clampToBudget("", 100);
    expect(result.text).toBe("");
    expect(result.trimmed).toBe(false);
  });
});
