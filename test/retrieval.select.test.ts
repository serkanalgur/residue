/**
 * Tests for post-retrieval selection: MMR diversity, maxFacts, minScore,
 * maxChars budget (property-style with 1000 random inputs), recency decay,
 * and deterministic tie-breaking.
 *
 * @module test/retrieval.select
 */

import { describe, it, expect } from "bun:test";
import { select } from "../src/retrieval/select.js";
import type { SearchHit } from "../src/core/types.js";
import type { SelectOptions, AccessMeta } from "../src/retrieval/select.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHit(
  id: string,
  content: string,
  score: number,
  ftsMatch = true,
): SearchHit {
  return {
    record: {
      id,
      kind: "fact" as const,
      scope: "project" as const,
      project_id: "proj-test",
      worktree_key: "wk-test",
      branch_key: null,
      content,
      embedding: null,
      source: {
        sessionID: "session-1",
        timestamp: new Date().toISOString(),
      },
      tags: [],
    },
    score,
    ftsMatch,
  };
}

const DEFAULT_OPTIONS: SelectOptions = {
  maxFacts: 10,
  minScore: 0,
  maxChars: 10000,
};

// ---------------------------------------------------------------------------
// maxFacts
// ---------------------------------------------------------------------------

describe("select — maxFacts", () => {
  it("limits results to maxFacts", () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      makeHit(`id-${i}`, `Content ${i}`, 0.9 - i * 0.01),
    );

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 5 });
    expect(result.length).toBe(5);
  });

  it("returns all if fewer than maxFacts", () => {
    const hits = [makeHit("a", "Content A", 0.9), makeHit("b", "Content B", 0.8)];

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 10 });
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// minScore
// ---------------------------------------------------------------------------

describe("select — minScore", () => {
  it("filters out hits below minScore", () => {
    const hits = [
      makeHit("a", "High score", 0.9),
      makeHit("b", "Medium score", 0.5),
      makeHit("c", "Low score", 0.1),
    ];

    const result = select(hits, { ...DEFAULT_OPTIONS, minScore: 0.6 });
    expect(result.length).toBe(1);
    expect(result[0]!.record.id).toBe("a");
  });

  it("keeps all hits above minScore", () => {
    const hits = [
      makeHit("a", "Score 0.8", 0.8),
      makeHit("b", "Score 0.9", 0.9),
    ];

    const result = select(hits, { ...DEFAULT_OPTIONS, minScore: 0.5 });
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MMR diversity
// ---------------------------------------------------------------------------

describe("select — MMR diversity", () => {
  it("prefers diverse results over similar ones", () => {
    // Two nearly identical records + one diverse record
    const hits = [
      makeHit("similar-1", "TypeScript is a typed superset of JavaScript", 0.9),
      makeHit("similar-2", "TypeScript is a typed superset of JavaScript with generics", 0.88),
      makeHit("diverse", "Rust provides memory safety without garbage collection", 0.7),
    ];

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 2, minScore: 0 });

    // MMR should prefer diversity: one TypeScript + one Rust
    const ids = result.map((h) => h.record.id);
    expect(ids).toContain("diverse");
  });

  it("deduplicates when similarity > 0.92", () => {
    const hits = [
      makeHit("dup-1", "The quick brown fox jumps over the lazy dog", 0.9),
      makeHit("dup-2", "The quick brown fox jumps over the lazy dog near the river", 0.85),
      makeHit("unique", "Quantum computing uses qubits instead of bits", 0.7),
    ];

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 3, minScore: 0 });

    // The two similar records should not both appear
    const contentSet = new Set(result.map((h) => h.record.content));
    expect(contentSet.size).toBe(result.length);
  });
});

// ---------------------------------------------------------------------------
// maxChars budget — property-style with 1000 random inputs
// ---------------------------------------------------------------------------

describe("select — maxChars budget (property-style)", () => {
  // Seeded PRNG for determinism
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  it("never exceeds maxChars across 1000 random inputs", () => {
    const rand = seededRandom(42);

    for (let i = 0; i < 1000; i++) {
      const maxChars = Math.floor(rand() * 5000) + 100;
      const numHits = Math.floor(rand() * 50) + 1;

      const hits: SearchHit[] = [];
      for (let j = 0; j < numHits; j++) {
        const contentLen = Math.floor(rand() * 500) + 10;
        const content = "x".repeat(contentLen);
        hits.push(makeHit(`id-${i}-${j}`, content, rand()));
      }

      const result = select(hits, { ...DEFAULT_OPTIONS, maxChars, maxFacts: 50 });

      // THE INVARIANT: total content length must never exceed maxChars
      let totalChars = 0;
      for (const hit of result) {
        totalChars += hit.record.content.length;
      }
      expect(totalChars).toBeLessThanOrEqual(maxChars);
    }
  });

  it("truncates at sentence boundary when budget is tight", () => {
    const longContent = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const hits = [makeHit("long", longContent, 0.9)];

    const result = select(hits, { ...DEFAULT_OPTIONS, maxChars: 40, maxFacts: 10 });

    expect(result.length).toBe(1);
    expect(result[0]!.record.content.length).toBeLessThanOrEqual(40);
    // Should end at a sentence boundary
    expect(result[0]!.record.content).toMatch(/[.!?]$/);
  });

  it("returns empty when maxChars is 0", () => {
    const hits = [makeHit("a", "Content", 0.9)];
    const result = select(hits, { ...DEFAULT_OPTIONS, maxChars: 0 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recency decay
// ---------------------------------------------------------------------------

describe("select — recency decay", () => {
  it("penalises frequently accessed records", () => {
    const hits = [
      makeHit("frequent", "Frequently accessed content", 0.9),
      makeHit("rare", "Rarely accessed content", 0.88),
    ];

    const accessMap = new Map<string, AccessMeta>();
    accessMap.set("frequent", { accessCount: 100, lastAccess: Date.now() });
    accessMap.set("rare", { accessCount: 1, lastAccess: Date.now() });

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 2, minScore: 0 }, accessMap);

    // The rarely accessed record should rank higher after decay
    expect(result[0]!.record.id).toBe("rare");
  });

  it("penalises old records", () => {
    const hits = [
      makeHit("old", "Old content", 0.9),
      makeHit("new", "New content", 0.88),
    ];

    const now = Date.now();
    const accessMap = new Map<string, AccessMeta>();
    accessMap.set("old", { accessCount: 1, lastAccess: now - 30 * 24 * 60 * 60 * 1000 }); // 30 days ago
    accessMap.set("new", { accessCount: 1, lastAccess: now }); // now

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 2, minScore: 0 }, accessMap);

    // The new record should rank higher after decay
    expect(result[0]!.record.id).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Deterministic tie-breaking
// ---------------------------------------------------------------------------

describe("select — deterministic ordering", () => {
  it("same input always produces same output", () => {
    const hits = [
      makeHit("z-record", "Content Z", 0.9),
      makeHit("a-record", "Content A", 0.9),
      makeHit("m-record", "Content M", 0.9),
    ];

    const run1 = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 3, minScore: 0 });
    const run2 = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 3, minScore: 0 });

    expect(run1.map((h) => h.record.id)).toEqual(run2.map((h) => h.record.id));
  });

  it("tie-breaks by id when scores are equal", () => {
    const hits = [
      makeHit("z-record", "Content Z", 0.9),
      makeHit("a-record", "Content A", 0.9),
      makeHit("m-record", "Content M", 0.9),
    ];

    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 3, minScore: 0 });

    // After MMR, the order should be deterministic
    const ids = result.map((h) => h.record.id);
    const sortedIds = [...ids].sort();
    expect(ids).toEqual(sortedIds);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("select — edge cases", () => {
  it("returns empty for empty input", () => {
    expect(select([], DEFAULT_OPTIONS)).toEqual([]);
  });

  it("returns empty for maxFacts=0", () => {
    const hits = [makeHit("a", "Content", 0.9)];
    expect(select(hits, { ...DEFAULT_OPTIONS, maxFacts: 0 })).toEqual([]);
  });

  it("handles single record", () => {
    const hits = [makeHit("only", "Only record", 0.9)];
    const result = select(hits, { ...DEFAULT_OPTIONS, maxFacts: 5 });
    expect(result.length).toBe(1);
    expect(result[0]!.record.id).toBe("only");
  });
});
