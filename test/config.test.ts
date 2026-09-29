/**
 * Tests for config resolution and secret redaction.
 *
 * @module test/config
 */

import { describe, it, expect } from "bun:test";
import { resolveOptions, redactSecrets, DEFAULT_OPTIONS } from "../src/config.js";

describe("resolveOptions", () => {
  it("returns defaults for null/undefined input", () => {
    expect(resolveOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions(undefined)).toEqual(DEFAULT_OPTIONS);
  });

  it("returns defaults for non-object input", () => {
    expect(resolveOptions("string")).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions(42)).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions(true)).toEqual(DEFAULT_OPTIONS);
  });

  it("does NOT throw on malformed input", () => {
    expect(() => resolveOptions({ autoCapture: "not-a-bool" })).not.toThrow();
    expect(() => resolveOptions({ embedding: 123 })).not.toThrow();
    expect(() => resolveOptions({ inject: "bad" })).not.toThrow();
    expect(() => resolveOptions({ report: [1, 2, 3] })).not.toThrow();
  });

  it("deep merges valid nested inject options", () => {
    const result = resolveOptions({
      inject: {
        maxChars: 1000,
        minScore: 0.5,
      },
    });

    expect(result.inject.maxChars).toBe(1000);
    expect(result.inject.minScore).toBe(0.5);
    // Preserved from defaults
    expect(result.inject.enabled).toBe(true);
    expect(result.inject.maxFacts).toBe(6);
    expect(result.inject.shareAcrossWorktrees).toBe(true);
  });

  it("deep merges valid nested report options", () => {
    const result = resolveOptions({
      report: {
        enabled: true,
        maxPerSessionPer5min: 3,
      },
    });

    expect(result.report.enabled).toBe(true);
    expect(result.report.maxPerSessionPer5min).toBe(3);
  });

  it("validates embedding mode against allowed values", () => {
    const valid = resolveOptions({ embedding: "remote" });
    expect(valid.embedding).toBe("remote");

    const invalid = resolveOptions({ embedding: "invalid-mode" });
    expect(invalid.embedding).toBe("auto"); // falls back to default
  });

  it("validates dataDir mode against allowed values", () => {
    const valid = resolveOptions({ dataDir: "project" });
    expect(valid.dataDir).toBe("project");

    const invalid = resolveOptions({ dataDir: "invalid" });
    expect(invalid.dataDir).toBe("xdg"); // falls back to default
  });

  it("rejects negative maxChars with warning", () => {
    const result = resolveOptions({ inject: { maxChars: -100 } });
    expect(result.inject.maxChars).toBe(DEFAULT_OPTIONS.inject.maxChars);
  });

  it("rejects out-of-range minScore with warning", () => {
    const result = resolveOptions({ inject: { minScore: 1.5 } });
    expect(result.inject.minScore).toBe(DEFAULT_OPTIONS.inject.minScore);
  });

  it("warns about unknown top-level keys", () => {
    const warnings: string[] = [];
    resolveOptions({ unknownKey: true }, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("unknownKey"))).toBe(true);
  });

  it("preserves valid options", () => {
    const result = resolveOptions({
      autoCapture: false,
      embedding: "none",
      debug: true,
      store: "sqlite",
    });

    expect(result.autoCapture).toBe(false);
    expect(result.embedding).toBe("none");
    expect(result.debug).toBe(true);
    expect(result.store).toBe("sqlite");
  });
});

describe("redactSecrets", () => {
  it("masks OpenAI-style API keys", () => {
    const input = "Using key sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcde");
  });

  it("masks Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const result = redactSecrets(input);
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("masks api_key= patterns", () => {
    const input = 'api_key=sk-1234567890abcdef1234567890abcdef';
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
  });

  it("masks token= patterns", () => {
    const input = "token=my-secret-token-value-1234567890";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
  });

  it("masks secret= patterns", () => {
    const input = "secret=supersecretvalue12345678901234";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
  });

  it("masks password= patterns", () => {
    const input = "password=Hunter2IsNotAGoodPassword!";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
  });

  it("does not touch normal text", () => {
    const input = "This is a normal log message with no secrets.";
    expect(redactSecrets(input)).toBe(input);
  });
});
