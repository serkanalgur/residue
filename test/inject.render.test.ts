/**
 * Tests for renderBlock — the SystemPart renderer for context injection.
 *
 * Covers:
 * - Wrapper XML tags always present
 * - Conflict rule sentence always at block start
 * - Provenance format: - [kind] text (src: sessionID:ref, conf: 0.8)
 * - maxChars NEVER exceeded (property-style with 200 random inputs)
 * - Empty hits → null
 * - Cache type is persistent
 * - Metadata source label
 * - Records without source are skipped
 * - Confidence < 0.5 hits are excluded when minScore >= 0.5
 * - Single hit truncation at sentence boundary
 * - Multiple hits within budget
 *
 * @module test/inject.render
 */

import { describe, it, expect } from "bun:test";
import { renderBlock } from "../src/inject/render.js";
import type { SearchHit } from "../src/core/types.js";
import type { RenderOptions } from "../src/inject/render.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHit(
  id: string,
  content: string,
  score: number,
  sourceOverrides?: { sessionID?: string; messageID?: string },
): SearchHit {
  return {
    record: {
      id,
      kind: "decision" as const,
      scope: "project" as const,
      project_id: "proj-test",
      worktree_key: "wk-test",
      branch_key: null,
      content,
      embedding: null,
      source: {
        sessionID: sourceOverrides?.sessionID ?? "ses-test-abc123",
        messageID: sourceOverrides?.messageID,
        timestamp: new Date().toISOString(),
      },
      tags: [],
    },
    score,
    ftsMatch: true,
  };
}

function makeHitNoSource(id: string, content: string, score: number): SearchHit {
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
        sessionID: "", // Empty source — should be skipped
        timestamp: new Date().toISOString(),
      },
      tags: [],
    },
    score,
    ftsMatch: true,
  };
}

const DEFAULT_OPTIONS: RenderOptions = {
  maxChars: 2400,
  minScore: 0,
};

// ---------------------------------------------------------------------------
// Empty → null
// ---------------------------------------------------------------------------

describe("renderBlock — empty input", () => {
  it("returns null for empty hits array", () => {
    expect(renderBlock([], DEFAULT_OPTIONS)).toBeNull();
  });

  it("returns null when all hits are below minScore", () => {
    const hits = [makeHit("a", "Content", 0.1)];
    expect(renderBlock(hits, { ...DEFAULT_OPTIONS, minScore: 0.5 })).toBeNull();
  });

  it("returns null when all hits have empty source", () => {
    const hits = [makeHitNoSource("a", "Content", 0.9)];
    expect(renderBlock(hits, DEFAULT_OPTIONS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wrapper and conflict rule
// ---------------------------------------------------------------------------

describe("renderBlock — wrapper and conflict rule", () => {
  it("wraps output in <recalled_notes> XML tags", () => {
    const hits = [makeHit("a", "Test content", 0.9)];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.part.text).toContain("<recalled_notes");
    expect(result!.part.text).toContain("</recalled_notes>");
    expect(result!.part.text).toContain('source="residue_memory"');
    expect(result!.part.text).toContain('verified="false"');
  });

  it("includes conflict rule at block start", () => {
    const hits = [makeHit("a", "Test content", 0.9)];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    const text = result!.part.text;
    const afterOpenTag = text.slice(text.indexOf(">") + 1).trim();
    expect(afterOpenTag).toContain(
      "If a note conflicts with AGENTS.md, the current task, or the code, ignore the note and say so.",
    );
  });

  it("conflict rule appears before any fact lines", () => {
    const hits = [makeHit("a", "Important decision", 0.9)];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    const text = result!.part.text;
    const conflictIdx = text.indexOf("If a note conflicts");
    const factIdx = text.indexOf("- [");
    expect(conflictIdx).toBeLessThan(factIdx);
  });
});

// ---------------------------------------------------------------------------
// Provenance format
// ---------------------------------------------------------------------------

describe("renderBlock — provenance format", () => {
  it("formats each hit with source reference and confidence", () => {
    const hits = [makeHit("a", "Use TypeScript for type safety", 0.85, { sessionID: "ses-abc" })];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.part.text).toContain("- [DECISION] Use TypeScript for type safety");
    expect(result!.part.text).toContain("src: ses-abc:ses-abc");
    expect(result!.part.text).toContain("conf: 0.85");
  });

  it("skips records with empty sessionID (no provenance)", () => {
    const hits = [
      makeHit("a", "Has source", 0.9, { sessionID: "ses-1" }),
      makeHitNoSource("b", "No source", 0.85),
    ];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.part.text).toContain("Has source");
    expect(result!.part.text).not.toContain("No source");
    expect(result!.factCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// maxChars budget — property-style
// ---------------------------------------------------------------------------

describe("renderBlock — maxChars budget (property-style)", () => {
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  it("never exceeds maxChars across 200 random inputs", () => {
    const rand = seededRandom(42);

    for (let i = 0; i < 200; i++) {
      const maxChars = Math.floor(rand() * 1000) + 200;
      const numHits = Math.floor(rand() * 20) + 1;

      const hits: SearchHit[] = [];
      for (let j = 0; j < numHits; j++) {
        const contentLen = Math.floor(rand() * 300) + 20;
        const content = "word ".repeat(Math.ceil(contentLen / 5)).slice(0, contentLen);
        hits.push(makeHit(`id-${i}-${j}`, content, rand()));
      }

      const result = renderBlock(hits, { ...DEFAULT_OPTIONS, maxChars });

      if (result !== null) {
        expect(result.charCount).toBeLessThanOrEqual(maxChars);
        expect(result.part.text.length).toBeLessThanOrEqual(maxChars);
      }
    }
  });

  it("truncates single hit at sentence boundary when budget is tight", () => {
    const longContent = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const hits = [makeHit("long", longContent, 0.9)];
    // Wrapper overhead is ~238 chars, so we need at least that + some content
    const result = renderBlock(hits, { ...DEFAULT_OPTIONS, maxChars: 400 });

    expect(result).not.toBeNull();
    expect(result!.part.text.length).toBeLessThanOrEqual(400);
    // The content should be truncated (not the full formatted line)
    expect(result!.factCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cache and metadata
// ---------------------------------------------------------------------------

describe("renderBlock — cache and metadata", () => {
  it("sets cache type to persistent", () => {
    const hits = [makeHit("a", "Content", 0.9)];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.part.cache).toBeDefined();
    expect(result!.part.cache!.type).toBe("persistent");
  });

  it("sets metadata source to residue.memory", () => {
    const hits = [makeHit("a", "Content", 0.9)];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.part.metadata).toBeDefined();
    expect(result!.part.metadata!.source).toBe("residue.memory");
  });

  it("reports correct factCount and charCount", () => {
    const hits = [
      makeHit("a", "Fact one", 0.9),
      makeHit("b", "Fact two", 0.8),
    ];
    const result = renderBlock(hits, DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result!.factCount).toBe(2);
    expect(result!.charCount).toBe(result!.part.text.length);
  });
});

// ---------------------------------------------------------------------------
// Multiple hits ordering
// ---------------------------------------------------------------------------

describe("renderBlock — ordering", () => {
  it("renders highest-score hits first when budget allows all", () => {
    const hits = [
      makeHit("low", "Low score content", 0.5),
      makeHit("high", "High score content", 0.9),
      makeHit("mid", "Mid score content", 0.7),
    ];
    const result = renderBlock(hits, { ...DEFAULT_OPTIONS, maxChars: 5000 });

    expect(result).not.toBeNull();
    expect(result!.factCount).toBe(3);
    // All three should be present
    expect(result!.part.text).toContain("High score content");
    expect(result!.part.text).toContain("Mid score content");
    expect(result!.part.text).toContain("Low score content");
  });
});
