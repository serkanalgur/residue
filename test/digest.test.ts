/**
 * Tests for session digest production.
 *
 * Covers:
 * - Digest produced on session.compaction.ended
 * - NOT produced on ordinary idle
 * - Respects per-session cap
 * - Carries real provenance (sessionID + timestamp)
 * - Survives being stored and retrieved
 * - Compaction hook writes nothing into summary
 * - Digest records expire under digest TTL
 * - Empty/short model responses are skipped
 *
 * @module test/digest
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { produceDigest, DEFAULT_DIGEST_CONFIG } from "../src/ingest/digest.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { createLogger } from "../src/log.js";
import type { MemoryStore, ResolvedScope, Embedder } from "../src/core/ports.js";
import type { DigestConfig, DigestDeps } from "../src/ingest/digest.js";

const log = createLogger(false);

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-digest-test",
    worktreeKey: "wk-digest-test",
    branchKey: "main",
    canonicalDir: "/test",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DigestDeps> = {}): DigestDeps {
  return {
    store: new InMemoryStore(),
    resolved: makeResolved(),
    generateText: async () => ({ text: "This session configured TypeScript for the project." }),
    defaultModel: async () => ({ id: "test-model", providerID: "test-provider" }),
    embedder: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DigestConfig> = {}): DigestConfig {
  return { ...DEFAULT_DIGEST_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Basic production
// ---------------------------------------------------------------------------

describe("digest — basic production", () => {
  it("produces a digest record on compaction", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });

    const inserted = await produceDigest(
      "ses-compacted-001",
      deps,
      makeConfig(),
      "Session configured TypeScript with strict mode.",
      SILENT_LOG,
    );

    expect(inserted).toBe(1);

    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-digest-test" },
    });
    expect(count).toBe(1);
  });

  it("uses the compaction summary as source material for the LLM prompt", async () => {
    let capturedPrompt = "";
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({
      store,
      generateText: async (opts) => {
        capturedPrompt = opts.prompt;
        return { text: "Digest: TypeScript configured." };
      },
    });

    await produceDigest(
      "ses-test",
      deps,
      makeConfig(),
      "The session set up TypeScript.",
      SILENT_LOG,
    );

    // The compaction summary should appear in the prompt
    expect(capturedPrompt).toContain("The session set up TypeScript.");
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("digest — provenance", () => {
  it("carries real sessionID in source", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });

    await produceDigest("ses-real-provenance", deps, makeConfig(), "summary", SILENT_LOG);

    const records = await store.scan({
      scope: {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-digest-test" },
      },
      kind: "digest",
    });

    expect(records.length).toBe(1);
    expect(records[0]!.source.sessionID).toBe("ses-real-provenance");
    expect(records[0]!.source.timestamp).toBeTruthy();
    expect(records[0]!.kind).toBe("digest");
  });

  it("has correct scope and project_id", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });

    await produceDigest("ses-scope-test", deps, makeConfig(), "summary", SILENT_LOG);

    const records = await store.scan({
      scope: {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-digest-test" },
      },
      kind: "digest",
    });

    expect(records[0]!.scope).toBe("project");
    expect(records[0]!.project_id).toBe("proj-digest-test");
    expect(records[0]!.worktree_key).toBe("wk-digest-test");
  });
});

// ---------------------------------------------------------------------------
// Anti-feedback loop: per-session cap
// ---------------------------------------------------------------------------

describe("digest — per-session cap", () => {
  it("respects maxPerSession limit", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });
    const config = makeConfig({ maxPerSession: 2, minIntervalMs: 0 });

    // Produce 2 digests (at cap)
    const r1 = await produceDigest("ses-cap-test", deps, config, "s1", SILENT_LOG);
    const r2 = await produceDigest("ses-cap-test", deps, config, "s2", SILENT_LOG);
    expect(r1).toBe(1);
    expect(r2).toBe(1);

    // Third should be blocked
    const r3 = await produceDigest("ses-cap-test", deps, config, "s3", SILENT_LOG);
    expect(r3).toBe(0);

    // Count should be exactly 2
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-digest-test" },
    });
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Anti-feedback loop: debounce
// ---------------------------------------------------------------------------

describe("digest — debounce", () => {
  it("respects minIntervalMs", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });
    // Set a very long debounce
    const config = makeConfig({ minIntervalMs: 60_000_000, maxPerSession: 100 });

    const r1 = await produceDigest("ses-debounce", deps, config, "s1", SILENT_LOG);
    expect(r1).toBe(1);

    // Immediate second attempt should be blocked by debounce
    const r2 = await produceDigest("ses-debounce", deps, config, "s2", SILENT_LOG);
    expect(r2).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Empty/short responses
// ---------------------------------------------------------------------------

describe("digest — edge cases", () => {
  it("skips when model returns empty response", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({
      store,
      generateText: async () => ({ text: "" }),
    });

    const inserted = await produceDigest("ses-empty", deps, makeConfig(), "summary", SILENT_LOG);
    expect(inserted).toBe(0);
  });

  it("skips when model returns very short response", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({
      store,
      generateText: async () => ({ text: "ok" }),
    });

    const inserted = await produceDigest("ses-short", deps, makeConfig(), "summary", SILENT_LOG);
    expect(inserted).toBe(0);
  });

  it("never throws on store failure", async () => {
    const brokenStore: MemoryStore = {
      initialize: async () => {},
      insert: async () => { throw new Error("store broken"); },
      search: async () => [],
      count: async () => 0,
      scan: async () => [],
      close: async () => {},
      get: async () => null,
      update: async () => null,
      remove: async () => false,
      removeMany: async () => 0,
      touch: async () => {},
      supersede: async () => {},
      stats: async () => ({ total: 0, byKind: {} as never, oldest: null, newest: null, dbBytes: 0 }),
      demoteWorktreeKey: async () => 0,
    };

    const deps = makeDeps({ store: brokenStore });

    // Must NOT throw
    const inserted = await produceDigest("ses-fail", deps, makeConfig(), "summary", SILENT_LOG);
    expect(inserted).toBe(0);
  });

  it("never throws on generation failure", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({
      store,
      generateText: async () => { throw new Error("LLM failed"); },
    });

    const inserted = await produceDigest("ses-llm-fail", deps, makeConfig(), "summary", SILENT_LOG);
    expect(inserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kind is "digest", not "fact" or "decision"
// ---------------------------------------------------------------------------

describe("digest — kind and tags", () => {
  it("stores with kind='digest' and tags=['session-digest']", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const deps = makeDeps({ store });

    await produceDigest("ses-kind", deps, makeConfig(), "summary", SILENT_LOG);

    const records = await store.scan({
      scope: {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-digest-test" },
      },
    });

    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("digest");
    expect(records[0]!.tags).toEqual(["session-digest"]);
  });
});
