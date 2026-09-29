/**
 * Tests for utility functions (hash, IDs).
 *
 * @module test/util
 */

import { describe, it, expect, vi } from "bun:test";
import { sha256, shortHash, contentHash } from "../src/util/hash.js";
import { newId, encodeTime } from "../src/util/ids.js";

describe("sha256", () => {
  it("produces consistent 64-char hex digest", () => {
    const result = sha256("hello world");
    expect(result).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(result)).toBe(true);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = sha256("hello");
    const hash2 = sha256("world");
    expect(hash1).not.toBe(hash2);
  });

  it("is deterministic", () => {
    expect(sha256("test")).toBe(sha256("test"));
  });
});

describe("shortHash", () => {
  it("truncates to specified length", () => {
    const result = shortHash("hello world", 8);
    expect(result).toHaveLength(8);
    expect(/^[a-f0-9]{8}$/.test(result)).toBe(true);
  });

  it("defaults to 12 characters", () => {
    const result = shortHash("hello world");
    expect(result).toHaveLength(12);
  });
});

describe("contentHash", () => {
  it("normalizes whitespace before hashing", () => {
    const hash1 = contentHash("hello   world");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("trims leading/trailing whitespace", () => {
    const hash1 = contentHash("  hello world  ");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("produces 64-char hex digest", () => {
    const result = contentHash("test content");
    expect(result).toHaveLength(64);
  });
});

describe("newId", () => {
  it("produces 26-character IDs", () => {
    const id = newId();
    expect(id).toHaveLength(26);
  });

  it("produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newId());
    }
    expect(ids.size).toBe(1000);
  });

  it("uses only valid Base32 characters", () => {
    const validChars = /^[0-9A-Z]{26}$/;
    for (let i = 0; i < 100; i++) {
      expect(validChars.test(newId())).toBe(true);
    }
  });

  it("has deterministic timestamp prefix for same millisecond", () => {
    const FROZEN_MS = 1700000000000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(FROZEN_MS);

    const id1 = newId();
    const id2 = newId();

    spy.mockRestore();

    // Same frozen time → first 10 chars (timestamp) must be identical
    const prefix = id1.slice(0, 10);
    expect(id2.slice(0, 10)).toBe(prefix);
    // Prefix must match encodeTime output for the frozen timestamp
    expect(prefix).toBe(encodeTime(FROZEN_MS));
  });

  it("produces time-sortable IDs across different timestamps", () => {
    const TIME_A = 1700000000000;
    const TIME_B = TIME_A + 1; // one millisecond later

    const spy = vi.spyOn(Date, "now").mockReturnValue(TIME_A);
    const idA = newId();
    spy.mockRestore();

    const spy2 = vi.spyOn(Date, "now").mockReturnValue(TIME_B);
    const idB = newId();
    spy2.mockRestore();

    // Timestamp prefix at TIME_B must be lexicographically greater
    expect(idB.slice(0, 10) > idA.slice(0, 10)).toBe(true);
    // Full ID at later time must be lexicographically greater
    expect(idB > idA).toBe(true);
  });
});

describe("newId contract (10k)", () => {
  it("all 10k IDs are length 26, Crockford Base32, and unique", () => {
    const COUNT = 10_000;
    const charset = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford Base32 (excludes I, L, O, U)
    const ids = new Set<string>();

    for (let i = 0; i < COUNT; i++) {
      const id = newId();
      expect(id).toHaveLength(26);
      expect(charset.test(id)).toBe(true);
      ids.add(id);
    }

    expect(ids.size).toBe(COUNT);
  });
});
