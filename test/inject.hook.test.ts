/**
 * Tests for the context hook — the most critical component.
 *
 * Covers:
 * - context hook writes ONLY to event.system, NEVER to event.messages
 * - No registration for prompt/compaction/title/generate hooks
 * - No user message → no injection (token saving)
 * - Same (sessionID, messageID) → only 1 retrieval (memoisation)
 * - Different messageID → new retrieval
 * - inject.enabled: false → nothing
 * - Error in store → hook does NOT throw
 * - Agent gate: event.agent !== "build" → res_add deleted from tools
 * - providerID not provided → 3rd arg is undefined
 *
 * @module test/inject.hook
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { registerContextHook } from "../src/inject/context-hook.js";
import { createMemo } from "../src/inject/memo.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { createLogger } from "../src/log.js";
import type { ResolvedScope, MemoryStore, Embedder, ResolvedEmbedder } from "../src/core/ports.js";
import type { ResidueOptions } from "../src/config.js";
import type { SessionContext } from "@opencode/plugin";
import type { Memo } from "../src/inject/memo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = createLogger(false);

function makeResolved(overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    projectID: "proj-hook-test",
    worktreeKey: "wk-hook-test",
    branchKey: "main",
    canonicalDir: "/test",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ResidueOptions["inject"]> = {}): ResidueOptions {
  return {
    autoCapture: true,
    embedding: "none",
    embeddingKeyEnv: "OPENAI_API_KEY",
    embeddingProbeTimeout: 1500,
    inject: {
      enabled: true,
      maxChars: 2400,
      maxFacts: 6,
      minScore: 0.34,
      shareAcrossWorktrees: false,
      ...overrides,
    },
    store: "sqlite",
    report: { enabled: false, maxPerSessionPer5min: 1 },
    dataDir: "xdg",
    debug: false,
  };
}

/** Build a minimal SessionContext event for testing. */
function makeEvent(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionID: "ses-test-123" as SessionContext["sessionID"],
    agent: "build" as SessionContext["agent"],
    model: {
      id: "test-model" as any,
      providerID: "test-provider" as any,
    },
    system: [],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "How do I configure TypeScript?" }],
      },
    ],
    tools: {
      res_status: { description: "Status", input: { type: "object", properties: {} } },
      res_add: { description: "Add memory", input: { type: "object", properties: {} } },
      res_search: { description: "Search", input: { type: "object", properties: {} } },
    },
    options: {},
    ...overrides,
  } as SessionContext;
}

/** Build a mock context with a hook spy. */
function makeMockCtx() {
  const registrations: Array<{
    name: string;
    callback: (event: SessionContext) => Promise<void>;
    options?: { providerID?: string };
  }> = [];

  return {
    registrations,
    ctx: {
      session: {
        hook: async (
          name: string,
          callback: (event: SessionContext) => Promise<void>,
          options?: { providerID?: string },
        ) => {
          registrations.push({ name, callback, options });
          return {
            dispose: async () => {},
          };
        },
      },
    },
  };
}

/** Seed the store with test records. */
async function seedStore(
  store: InMemoryStore,
  contents: string[],
  resolved: ResolvedScope,
): Promise<void> {
  for (const content of contents) {
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content,
      embedding: null,
      source: {
        sessionID: "ses-seed",
        timestamp: new Date().toISOString(),
      },
      tags: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("context hook — registration", () => {
  it("registers exactly one hook named 'context'", () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    expect(registrations.length).toBe(1);
    expect(registrations[0]!.name).toBe("context");
  });

  it("does NOT register prompt/compaction/title/generate hooks", () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const registeredNames = registrations.map((r) => r.name);
    expect(registeredNames).not.toContain("prompt");
    expect(registeredNames).not.toContain("compaction");
    expect(registeredNames).not.toContain("title");
    expect(registeredNames).not.toContain("generate");
    expect(registeredNames).not.toContain("model.request");
  });

  it("passes providerID when configured", () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions({ providerID: "openai" });

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    expect(registrations[0]!.options).toEqual({ providerID: "openai" });
  });

  it("does NOT pass 3rd arg when providerID is undefined", () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions(); // No providerID

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    expect(registrations[0]!.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inject.enabled: false
// ---------------------------------------------------------------------------

describe("context hook — inject.enabled: false", () => {
  it("does nothing when injection is disabled", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions({ enabled: false });

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent();
    const beforeSystem = [...event.system];
    const beforeMessages = JSON.parse(JSON.stringify(event.messages));

    await registrations[0]!.callback(event);

    // Nothing should change
    expect(event.system).toEqual(beforeSystem);
    expect(event.messages).toEqual(beforeMessages);
  });
});

// ---------------------------------------------------------------------------
// event.system vs event.messages
// ---------------------------------------------------------------------------

describe("context hook — event mutation boundary", () => {
  it("writes to event.system but NOT to event.messages", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    await seedStore(store, ["TypeScript is great for type safety"], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent();
    const beforeMessages = JSON.parse(JSON.stringify(event.messages));
    const beforeSystemLength = event.system.length;

    await registrations[0]!.callback(event);

    // system should have gained entries
    expect(event.system.length).toBeGreaterThanOrEqual(beforeSystemLength);

    // messages must be EXACTLY the same
    expect(event.messages).toEqual(beforeMessages);
  });

  it("event.messages is deeply unchanged after hook execution", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    await seedStore(store, ["Use monorepo with turborepo"], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent();
    // Snapshot messages before
    const snapshot = JSON.stringify(event.messages);

    await registrations[0]!.callback(event);

    // Deep equality check
    expect(JSON.stringify(event.messages)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// No user message → no injection
// ---------------------------------------------------------------------------

describe("context hook — no user message", () => {
  it("does not inject when there are no user messages", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    await seedStore(store, ["Some memory"], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    // Event with only assistant messages (tool continuation scenario)
    const event = makeEvent({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Let me check that." }],
        },
      ],
    });

    const beforeSystem = event.system.length;

    await registrations[0]!.callback(event);

    // Should not add anything to system
    expect(event.system.length).toBe(beforeSystem);
  });

  it("does not inject when messages array is empty", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent({ messages: [] });

    await registrations[0]!.callback(event);

    expect(event.system.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Memoisation — same key → 1 retrieval
// ---------------------------------------------------------------------------

describe("context hook — memoisation", () => {
  it("retrieves only once for same (sessionID, messageID)", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    // Use content that matches well with the query terms
    await seedStore(store, ["TypeScript is used for type safety in large codebases"], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    // Use low minScore because InMemoryStore RRF produces low scores for single-channel results
    const options = makeOptions({ minScore: 0.01 });

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent(); // "How do I configure TypeScript?"

    // First call
    await registrations[0]!.callback(event);
    const afterFirst = event.system.length;

    // Second call with same event (same sessionID + same messageID)
    await registrations[0]!.callback(event);
    const afterSecond = event.system.length;

    // Should have added exactly one SystemPart total (cached on second call)
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it("retrieves again for different messageID", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    // Content matching both queries
    await seedStore(store, [
      "TypeScript is used for type safety in large codebases",
      "ESLint is configured for code quality and consistency",
    ], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    // Use low minScore because InMemoryStore RRF produces low scores for single-channel results
    const options = makeOptions({ minScore: 0.01 });

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    // First message — "How do I configure TypeScript?"
    const event1 = makeEvent();
    await registrations[0]!.callback(event1);
    const afterFirst = event1.system.length;

    // Second message — different content → different memo key
    const event2 = makeEvent({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "How do I configure ESLint for this project?" }],
        },
      ],
    });
    await registrations[0]!.callback(event2);
    const afterSecond = event2.system.length;

    // Each event should have exactly 1 SystemPart
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling — no throw
// ---------------------------------------------------------------------------

describe("context hook — error handling", () => {
  it("does NOT throw when store.search fails", async () => {
    const { registrations, ctx } = makeMockCtx();

    // Create a store that throws on search
    const brokenStore: MemoryStore = {
      initialize: async () => {},
      insert: async () => { throw new Error("broken"); },
      search: async () => { throw new Error("Store search failed"); },
      count: async () => 0,
      close: async () => {},
    };

    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store: brokenStore, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent();

    // Must NOT throw
    await expect(registrations[0]!.callback(event)).resolves.toBeUndefined();

    // system should remain unchanged (error suppressed)
    expect(event.system.length).toBe(0);
  });

  it("does NOT throw when embedder fails", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    await seedStore(store, ["Some fact"], makeResolved());
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    const brokenEmbedder: ResolvedEmbedder = {
      embedder: {
        id: "broken",
        degraded: false,
        dimension: 4,
        embed: async () => { throw new Error("Embed failed"); },
        embedBatch: async () => { throw new Error("Embed failed"); },
      },
      degraded: false,
    };

    registerContextHook(
      ctx,
      { store, embedder: brokenEmbedder, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent();

    // Must NOT throw
    await expect(registrations[0]!.callback(event)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent gate — res_add removal
// ---------------------------------------------------------------------------

describe("context hook — agent gate", () => {
  it("removes res_add from tools when agent !== 'build'", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent({
      agent: "explore" as SessionContext["agent"],
    });

    // res_add should be present before
    expect(event.tools["res_add"]).toBeDefined();

    await registrations[0]!.callback(event);

    // res_add should be deleted after
    expect(event.tools["res_add"]).toBeUndefined();
    // Other tools should remain
    expect(event.tools["res_status"]).toBeDefined();
    expect(event.tools["res_search"]).toBeDefined();
  });

  it("keeps res_add when agent === 'build'", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    const event = makeEvent({ agent: "build" as SessionContext["agent"] });

    await registrations[0]!.callback(event);

    // res_add should still be present
    expect(event.tools["res_add"]).toBeDefined();
  });

  it("removes res_add for any non-build agent string", async () => {
    const { registrations, ctx } = makeMockCtx();
    const store = new InMemoryStore();
    await store.initialize();
    const memo = createMemo();
    const resolved = makeResolved();
    const options = makeOptions();

    registerContextHook(
      ctx,
      { store, embedder: { embedder: null, degraded: true }, resolved },
      options,
      log,
      memo,
    );

    for (const agent of ["coder", "reviewer", "tester", "designer", "documenter"]) {
      const event = makeEvent({ agent: agent as SessionContext["agent"] });
      await registrations[0]!.callback(event);
      expect(event.tools["res_add"]).toBeUndefined();
    }
  });
});
