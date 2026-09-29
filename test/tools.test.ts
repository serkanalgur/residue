/**
 * Tests for tool schemas, execute functions, and security invariants.
 *
 * Covers:
 * - JSON Schema validity (additionalProperties, required fields)
 * - execute returns {content} (flat string, not nested)
 * - Signal cancellation
 * - res_add provenance requirement
 *
 * @module test/tools
 */

import { describe, it, expect } from "bun:test";
import {
  STATUS_TOOL_SCHEMA,
  SEARCH_TOOL_SCHEMA,
  ADD_TOOL_SCHEMA,
} from "../src/tools/schemas.js";
import { executeSearch } from "../src/tools/search.js";
import { executeAdd, validateAddInput, AddValidationError } from "../src/tools/add.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { createLogger } from "../src/log.js";
import type { Embedder, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft, SearchHit } from "../src/core/types.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { buildScopePredicate } from "../src/scope.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = createLogger(false);

function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-tool-test",
    worktreeKey: "wk-tool-test",
    branchKey: "main",
    canonicalDir: "/test",
    ...overrides,
  };
}

const OPTIONS = {
  inject: {
    shareAcrossWorktrees: false,
    maxChars: 2400,
    maxFacts: 6,
  },
};

async function makeStoreWithRecords(
  contents: string[],
): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.initialize();
  const resolved = makeResolved();

  for (const content of contents) {
    const draft: MemoryDraft = {
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content,
      embedding: null,
      source: {
        sessionID: "test-session",
        timestamp: new Date().toISOString(),
      },
      tags: [],
    };
    await store.insert(draft);
  }

  return store;
}

// ---------------------------------------------------------------------------
// JSON Schema validity
// ---------------------------------------------------------------------------

describe("JSON Schema validity", () => {
  it("STATUS_TOOL_SCHEMA has additionalProperties: false", () => {
    expect(STATUS_TOOL_SCHEMA.additionalProperties).toBe(false);
  });

  it("SEARCH_TOOL_SCHEMA has additionalProperties: false", () => {
    expect(SEARCH_TOOL_SCHEMA.additionalProperties).toBe(false);
  });

  it("SEARCH_TOOL_SCHEMA has required query", () => {
    expect(SEARCH_TOOL_SCHEMA.required).toContain("query");
  });

  it("SEARCH_TOOL_SCHEMA has valid enums", () => {
    expect(SEARCH_TOOL_SCHEMA.properties.scope.enum).toEqual(["project", "global", "all"]);
    expect(SEARCH_TOOL_SCHEMA.properties.kind.enum).toEqual([
      "fact", "decision", "pattern", "digest", "profile", "all",
    ]);
  });

  it("SEARCH_TOOL_SCHEMA has limit range", () => {
    expect(SEARCH_TOOL_SCHEMA.properties.limit.minimum).toBe(1);
    expect(SEARCH_TOOL_SCHEMA.properties.limit.maximum).toBe(20);
  });

  it("SEARCH_TOOL_SCHEMA has minScore range", () => {
    expect(SEARCH_TOOL_SCHEMA.properties.minScore.minimum).toBe(0);
    expect(SEARCH_TOOL_SCHEMA.properties.minScore.maximum).toBe(1);
  });

  it("ADD_TOOL_SCHEMA has additionalProperties: false", () => {
    expect(ADD_TOOL_SCHEMA.additionalProperties).toBe(false);
  });

  it("ADD_TOOL_SCHEMA has required content", () => {
    expect(ADD_TOOL_SCHEMA.required).toContain("content");
  });

  it("ADD_TOOL_SCHEMA has valid kind enum", () => {
    expect(ADD_TOOL_SCHEMA.properties.kind.enum).toEqual([
      "fact", "decision", "pattern", "profile",
    ]);
  });

  it("ADD_TOOL_SCHEMA has valid scope enum", () => {
    expect(ADD_TOOL_SCHEMA.properties.scope.enum).toEqual(["project", "global"]);
  });

  it("ADD_TOOL_SCHEMA has tags maxItems", () => {
    expect(ADD_TOOL_SCHEMA.properties.tags.maxItems).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// executeSearch — output format
// ---------------------------------------------------------------------------

describe("executeSearch — output format", () => {
  it("returns {content: string} with metadata", async () => {
    const store = await makeStoreWithRecords(["TypeScript is great"]);
    const resolved = makeResolved();
    const scope = buildScopePredicate("both", resolved, { inject: { shareAcrossWorktrees: false } });

    const result = await executeSearch(
      { query: "TypeScript" },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS as any,
        logger: log,
      },
    );

    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata.count).toBe("number");
    expect(typeof result.metadata.elapsedMs).toBe("number");
    expect(result.metadata.mode).toBe("lexical");
  });

  it("returns friendly message when no results", async () => {
    const store = await makeStoreWithRecords(["TypeScript is great"]);
    const resolved = makeResolved();

    const result = await executeSearch(
      { query: "quantum physics" },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: OPTIONS as any,
        logger: log,
      },
    );

    expect(result.content).toContain("No matching memory records");
    expect(result.metadata.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// executeSearch — signal cancellation
// ---------------------------------------------------------------------------

describe("executeSearch — signal cancellation", () => {
  it("throws on pre-aborted signal", async () => {
    const store = await makeStoreWithRecords(["test content"]);
    const resolved = makeResolved();
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    await expect(
      executeSearch(
        { query: "test" },
        { signal: controller.signal },
        {
          store,
          embedder: null,
          resolved,
          options: OPTIONS as any,
          logger: log,
        },
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateAddInput — provenance requirement
// ---------------------------------------------------------------------------

describe("validateAddInput — provenance requirement", () => {
  it("rejects add without source", () => {
    expect(() =>
      validateAddInput({ content: "This is a valid memory content" }),
    ).toThrow(AddValidationError);

    try {
      validateAddInput({ content: "This is a valid memory content" });
    } catch (e) {
      expect(e).toBeInstanceOf(AddValidationError);
      expect((e as AddValidationError).field).toBe("source");
    }
  });

  it("rejects content shorter than 8 characters", () => {
    expect(() =>
      validateAddInput({ content: "short", source: { path: "test.ts" } }),
    ).toThrow(AddValidationError);
  });

  it("rejects more than 8 tags", () => {
    expect(() =>
      validateAddInput({
        content: "Valid content here",
        source: { path: "test.ts" },
        tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      }),
    ).toThrow(AddValidationError);
  });

  it("accepts valid input with source", () => {
    expect(() =>
      validateAddInput({
        content: "This is valid memory content",
        source: { path: "test.ts", line: 42 },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeAdd — output format
// ---------------------------------------------------------------------------

describe("executeAdd — output format", () => {
  it("returns {content: string} with metadata", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    const result = await executeAdd(
      {
        content: "TypeScript is a typed superset of JavaScript",
        source: { path: "README.md", line: 10 },
      },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: { inject: { shareAcrossWorktrees: false } },
        logger: log,
        sessionID: "test-session",
      },
    );

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Memory stored:");
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata.id).toBe("string");
    expect(result.metadata.kind).toBe("fact");
    expect(result.metadata.scope).toBe("project");
  });

  it("does NOT write without source (provenance)", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    await expect(
      executeAdd(
        { content: "Content without provenance" },
        {},
        {
          store,
          embedder: null,
          resolved,
          options: { inject: { shareAcrossWorktrees: false } },
          logger: log,
          sessionID: "test-session",
        },
      ),
    ).rejects.toThrow("Source information is required");
  });

  it("persists to store with correct scope", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();

    await executeAdd(
      {
        content: "Global memory record for testing",
        scope: "global",
        source: { path: "config.ts" },
      },
      {},
      {
        store,
        embedder: null,
        resolved,
        options: { inject: { shareAcrossWorktrees: false } },
        logger: log,
        sessionID: "test-session",
      },
    );

    // Verify the record was stored with global scope
    const globalScope = buildScopePredicate("global", resolved, { inject: { shareAcrossWorktrees: false } });
    const count = await store.count(globalScope);
    expect(count).toBe(1);
  });

  it("rejects signal cancellation", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const resolved = makeResolved();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeAdd(
        { content: "Content with valid source", source: { path: "test.ts" } },
        { signal: controller.signal },
        {
          store,
          embedder: null,
          resolved,
          options: { inject: { shareAcrossWorktrees: false } },
          logger: log,
          sessionID: "test-session",
        },
      ),
    ).rejects.toThrow();
  });
});
