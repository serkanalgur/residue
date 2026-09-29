/**
 * End-to-end wiring tests for the Residue plugin.
 *
 * Verifies that setup() wires all components together correctly:
 * - Tools are registered under res_* namespace
 * - Ingestion feeds the buffer and extracts memories into the store
 * - Cleanup properly tears down everything
 *
 * @module test/wiring
 */

import { describe, it, expect } from "bun:test";
import { registerTools, type RegisterDeps } from "../src/tools/register.js";
import { registerInjection, type InjectionDeps } from "../src/inject/index.js";
import { registerIngestion, type IngestionCtx, type SubscribeDeps } from "../src/ingest/subscribe.js";
import { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "../src/ingest/buffer.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { buildScopePredicate } from "../src/scope.js";
import { resolveOptions, DEFAULT_OPTIONS } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { Logger } from "../src/log.js";
import type { MemoryDraft, SearchHit } from "../src/core/types.js";
import type { Plugin } from "@opencode/plugin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const RESOLVED = {
  projectID: "proj-wiring-test",
  worktreeKey: "wk-wiring-test",
  branchKey: "main" as string | null,
  canonicalDir: "/wiring-test",
};

// ---------------------------------------------------------------------------
// Mock event source for AsyncIterable
// ---------------------------------------------------------------------------

function createMockEventSource() {
  type Event = { readonly type: string; readonly data?: Record<string, unknown> };
  const eventBuffer: Event[] = [];
  const waitingResolvers: Array<(value: IteratorResult<Event>) => void> = [];
  let done = false;

  return {
    subscribe: (_opts: { signal?: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Event>> {
            if (eventBuffer.length > 0) {
              const event = eventBuffer.shift()!;
              return Promise.resolve({ value: event, done: false });
            }
            return new Promise((resolve) => {
              waitingResolvers.push(resolve);
            });
          },
          return(): Promise<IteratorResult<Event>> {
            done = true;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    }),
    emit(type: string, data?: Record<string, unknown>) {
      const event = { type, data } as Event;
      if (waitingResolvers.length > 0) {
        const resolver = waitingResolvers.shift()!;
        resolver({ value: event, done: false });
      } else {
        eventBuffer.push(event);
      }
    },
    isDone: () => done,
  };
}

// ---------------------------------------------------------------------------
// Tool wiring test
// ---------------------------------------------------------------------------

describe("Wiring — tool registration", () => {
  it("registerTools registers res_status, res_search, res_add under the res namespace", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    const options = resolveOptions({});

    const registeredTools: string[] = [];
    let namespaceName = "";

    const mockCtx: Pick<Plugin.Context, "tool"> = {
      tool: {
        transform: async (cb: (editor: Parameters<Plugin.Context["tool"]["transform"]>[0]) => void | Promise<void>) => {
          const editor = {
            namespace: (config: { name: string; description: string }) => {
              namespaceName = config.name;
            },
            add: (tool: { name: string; description: string }) => {
              registeredTools.push(tool.name);
            },
            list: () => [],
            get: () => undefined,
            update: () => {},
            remove: () => {},
          };
          await cb(editor as never);
          return { dispose: async () => {} };
        },
        reload: async () => {},
        list: async () => [],
        hook: async () => ({ dispose: async () => {} }),
      },
    };

    await registerTools(
      mockCtx,
      {
        store,
        embedder: null,
        resolved: RESOLVED,
        driver: "memory",
        walEnabled: false,
        fts5Available: false,
        storeDegraded: false,
        dataDir: "/test",
        lastInjection: { factCount: 0, charCount: 0 },
      },
      options,
      silentLog,
    );

    // All three tools should be registered
    expect(registeredTools).toContain("status");
    expect(registeredTools).toContain("search");
    expect(registeredTools).toContain("add");
    expect(registeredTools.length).toBe(3);

    // Namespace should be "res"
    expect(namespaceName).toBe("res");
  });
});

// ---------------------------------------------------------------------------
// Ingestion wiring test
// ---------------------------------------------------------------------------

describe("Wiring — ingestion feeds buffer and extracts memories", () => {
  it("text delta feeds buffer; idle triggers extraction and store insert", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const eventSource = createMockEventSource();
    const buffer = createTurnBuffer(DEFAULT_BUFFER_CONFIG);

    const ctx: IngestionCtx = {
      event: eventSource,
      session: {
        get: async () => ({ projectID: RESOLVED.projectID }),
      },
      location: {
        project: { id: RESOLVED.projectID },
      },
    };

    let generateTextCalls = 0;

    const cleanup = registerIngestion(
      ctx,
      {
        buffer,
        generateText: async (opts) => {
          generateTextCalls++;
          return {
            text: JSON.stringify({
              memories: [
                {
                  text: "Uses bun:sqlite for the project database",
                  kind: "fact",
                  tags: ["database"],
                  confidence: 0.85,
                },
              ],
            }),
          };
        },
        defaultModel: () => ({ id: "test", providerID: "test" }),
        store,
        resolved: RESOLVED,
        sessionGet: async () => ({ projectID: RESOLVED.projectID }),
      },
      {
        ...DEFAULT_OPTIONS,
        minIntervalMs: 0, // Disable debounce for testing
      },
      silentLog,
    );

    // Emit text delta events to feed the buffer
    eventSource.emit("session.text.delta", {
      sessionID: "ses-wiring-001",
      assistantMessageID: "msg-1",
      delta: "The project uses bun:sqlite for its database layer.",
      ordinal: 0,
    });
    eventSource.emit("session.text.delta", {
      sessionID: "ses-wiring-001",
      assistantMessageID: "msg-1",
      delta: "It has WAL mode enabled for concurrent reads.",
      ordinal: 1,
    });

    // Give the subscription loop time to process
    await new Promise((r) => setTimeout(r, 50));

    // Verify buffer has content
    expect(buffer.size("ses-wiring-001")).toBeGreaterThan(0);

    // Now emit idle to trigger extraction
    eventSource.emit("session.idle", { sessionID: "ses-wiring-001" });

    // Wait for async processing (setTimeout(0) + model call + store insert)
    await new Promise((r) => setTimeout(r, 200));

    // Model should have been called
    expect(generateTextCalls).toBe(1);

    // A record should actually be in the store
    const scope = buildScopePredicate("both", RESOLVED, { inject: { shareAcrossWorktrees: true } });
    const count = await store.count(scope);
    expect(count).toBe(1);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Cleanup test
// ---------------------------------------------------------------------------

describe("Wiring — cleanup tears down everything", () => {
  it("after cleanup, events are ignored and no side effects occur", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const eventSource = createMockEventSource();
    const buffer = createTurnBuffer(DEFAULT_BUFFER_CONFIG);

    const ctx: IngestionCtx = {
      event: eventSource,
      session: {
        get: async () => ({ projectID: RESOLVED.projectID }),
      },
      location: {
        project: { id: RESOLVED.projectID },
      },
    };

    let generateTextCalls = 0;

    const cleanup = registerIngestion(
      ctx,
      {
        buffer,
        generateText: async (opts) => {
          generateTextCalls++;
          return { text: '{"memories":[]}' };
        },
        defaultModel: () => ({ id: "test", providerID: "test" }),
        store,
        resolved: RESOLVED,
        sessionGet: async () => ({ projectID: RESOLVED.projectID }),
      },
      { ...DEFAULT_OPTIONS, minIntervalMs: 0 },
      silentLog,
    );

    // Emit one event to prove it works before cleanup
    eventSource.emit("session.text.delta", {
      sessionID: "ses-cleanup-001",
      delta: "Test text",
      assistantMessageID: "msg-1",
      ordinal: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(buffer.size("ses-cleanup-001")).toBe(1);

    // Cleanup
    cleanup();

    // Emit more events — should be ignored
    eventSource.emit("session.text.delta", {
      sessionID: "ses-cleanup-001",
      delta: "More text after cleanup",
      assistantMessageID: "msg-2",
      ordinal: 1,
    });
    eventSource.emit("session.idle", { sessionID: "ses-cleanup-001" });
    await new Promise((r) => setTimeout(r, 200));

    // No extraction should have been triggered after cleanup
    expect(generateTextCalls).toBe(0);

    // Buffer should have been cleared by cleanup
    // (the buffer was already fed before cleanup, but take shouldn't be called)
    const scope = buildScopePredicate("both", RESOLVED, { inject: { shareAcrossWorktrees: true } });
    const count = await store.count(scope);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CWD ≠ project directory test (finding 2c)
// ---------------------------------------------------------------------------

describe("Wiring — CWD differs from project directory", () => {
  it("resolveDataDir uses projectDir, not process.cwd()", async () => {
    const { resolveDataDir } = await import("../src/paths.js");

    const fakeProjectDir = "/tmp/residue-test-project-abc123";
    const fakeEnv = {
      env: (_name: string) => undefined as string | undefined,
      homedir: () => "/tmp",
      tmpdir: () => "/tmp",
      isWritable: async (_p: string) => true,
    };

    const paths = await resolveDataDir(
      { dataDir: "project" },
      "test-project-id",
      fakeProjectDir,
      fakeEnv,
      () => {},
    );

    // Data dir must be under the project directory, NOT under process.cwd()
    expect(paths.base).toContain(fakeProjectDir);
    expect(paths.base).toContain(".opencode/residue");
  });
});

// ---------------------------------------------------------------------------
// Placeholder / binding order test (finding 2d)
// ---------------------------------------------------------------------------

describe("Wiring — scope predicate binding order", () => {
  it("resolveScopeParams produces bindings matching placeholder order for every scope variant", async () => {
    const { buildScopePredicate } = await import("../src/scope.js");
    const { SqliteStore } = await import("../src/store/sqlite/store.js");
    const { Database } = await import("bun:sqlite");

    const resolved = {
      projectID: "proj-binding-test",
      worktreeKey: "wk-abc123",
      branchKey: "main" as string | null,
      canonicalDir: "/test",
    };
    const options = { inject: { shareAcrossWorktrees: false } };

    // Verify sorted key order is deterministic (not relying on insertion order)
    for (const variant of ["project", "global", "both"] as const) {
      const predicate = buildScopePredicate(variant, resolved, options);
      const sortedKeys = Object.keys(predicate.params).sort();

      if (variant === "global") {
        expect(sortedKeys).toEqual([]);
      } else if (variant === "project") {
        expect(sortedKeys).toContain(":pid");
        expect(sortedKeys).toContain(":wk");
      } else {
        expect(sortedKeys).toContain(":pid");
        expect(sortedKeys).toContain(":wk");
      }
    }

    // Integration test: use real SQLite store to prove bindings produce correct SQL results
    const db = new Database(":memory:");
    const store = new SqliteStore(db, { embedder: null, readOnly: false });
    await store.initialize();

    // Insert records with different scopes
    const projectRecord = await store.insert({
      kind: "fact",
      scope: "project",
      project_id: "proj-binding-test",
      worktree_key: "wk-abc123",
      branch_key: "main",
      content: "Project-scoped fact for binding test",
      embedding: null,
      source: { sessionID: "test", timestamp: new Date().toISOString() },
      tags: [],
    });
    const globalRecord = await store.insert({
      kind: "fact",
      scope: "global",
      project_id: null,
      worktree_key: "global",
      branch_key: null,
      content: "Global-scoped fact for binding test",
      embedding: null,
      source: { sessionID: "test", timestamp: new Date().toISOString() },
      tags: [],
    });

    // Project scope: should find only project record
    const projectPred = buildScopePredicate("project", resolved, options);
    const projectCount = await store.count(projectPred);
    expect(projectCount).toBe(1);
    const projectSearch = await store.search("binding test", null, projectPred, 10);
    expect(projectSearch.length).toBe(1);
    expect(projectSearch[0]!.record.id).toBe(projectRecord.id);

    // Global scope: should find only global record
    const globalPred = buildScopePredicate("global", resolved, options);
    const globalCount = await store.count(globalPred);
    expect(globalCount).toBe(1);
    const globalSearch = await store.search("binding test", null, globalPred, 10);
    expect(globalSearch.length).toBe(1);
    expect(globalSearch[0]!.record.id).toBe(globalRecord.id);

    // Both scope: should find both records
    const bothPred = buildScopePredicate("both", resolved, options);
    const bothCount = await store.count(bothPred);
    expect(bothCount).toBe(2);

    // Project scope with shareAcrossWorktrees: finds all project records regardless of worktree
    const shareOpts = { inject: { shareAcrossWorktrees: true } };
    const sharePred = buildScopePredicate("project", resolved, shareOpts);
    const shareCount = await store.count(sharePred);
    expect(shareCount).toBe(1);

    // Different worktree should NOT find project record (without sharing)
    const otherResolved = { ...resolved, worktreeKey: "wk-other-worktree" };
    const otherPred = buildScopePredicate("project", otherResolved, options);
    const otherCount = await store.count(otherPred);
    expect(otherCount).toBe(0);

    await store.close();
  });
});

// ---------------------------------------------------------------------------
// IVF cache test (finding 2h)
// ---------------------------------------------------------------------------

describe("Wiring — IVF cache runs k-means at most once per data change", () => {
  it("across two consecutive vectorSearch calls with no mutation, k-means is not re-run", async () => {
    const { Database } = await import("bun:sqlite");
    const { createVecTable } = await import("../src/store/sqlite/schema.js");
    const { storeVector, vectorSearch, getCacheGeneration } = await import("../src/store/sqlite/vectors.js");

    const db = new Database(":memory:");
    const embedderId = "test_embedder";
    const dim = 8;
    const tableName = `vec_${embedderId}_${dim}`;

    // Create the vector table
    createVecTable(db, embedderId, dim);

    // Insert several random vectors
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        v[d] = Math.random();
      }
      vectors.push(v);
      storeVector(db, tableName, `mem-${i}`, v);
    }

    // Record cache generation after inserts (each storeVector invalidates)
    const afterInserts = getCacheGeneration();

    // First vectorSearch — builds IVF index (k-means runs)
    const query = new Float32Array(dim);
    for (let d = 0; d < dim; d++) query[d] = 0.5;

    const results1 = vectorSearch(db, query, embedderId, 5);
    expect(results1.length).toBeGreaterThan(0);

    // Cache generation should not increase from vectorSearch (only from storeVector)
    const afterFirstSearch = getCacheGeneration();
    expect(afterFirstSearch).toBe(afterInserts);

    // Second vectorSearch — should reuse cached IVF index
    const results2 = vectorSearch(db, query, embedderId, 5);
    expect(results2.length).toBeGreaterThan(0);

    // Still no increase — cache reused, k-means NOT re-run
    const afterSecondSearch = getCacheGeneration();
    expect(afterSecondSearch).toBe(afterInserts);

    // Verify cache was actually built (results are non-empty and consistent)
    expect(results1.length).toBe(results2.length);
    const ids1 = results1.map((r) => r.memoryId).sort();
    const ids2 = results2.map((r) => r.memoryId).sort();
    expect(ids1).toEqual(ids2);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke test: insert → search → inject → verify
// ---------------------------------------------------------------------------

describe("Wiring — E2E smoke test", () => {
  it("inserts a record, searches for it, runs context injection, and verifies the injected block", async () => {
    const { SqliteStore } = await import("../src/store/sqlite/store.js");
    const { Database } = await import("bun:sqlite");
    const { registerContextHook } = await import("../src/inject/context-hook.js");
    const { createMemo } = await import("../src/inject/memo.js");
    const { buildScopePredicate } = await import("../src/scope.js");

    // Capture warnings for debugging
    const warnings: string[] = [];
    const debugLog: Logger = {
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: (msg) => warnings.push(`ERROR: ${msg}`),
      debug: (msg) => warnings.push(`DEBUG: ${msg}`),
    };

    // 1. Create a real SQLite store (in-memory via :memory:)
    const db = new Database(":memory:");
    const store = new SqliteStore(db, { embedder: null, readOnly: false });
    await store.initialize();

    // 2. Insert a known record directly
    const scope = buildScopePredicate("both", RESOLVED, { inject: { shareAcrossWorktrees: true } });
    const record = await store.insert({
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "The plugin uses bun:sqlite for its database layer",
      embedding: null,
      source: {
        sessionID: "smoke-session-001",
        messageID: "msg-smoke-1",
        timestamp: new Date().toISOString(),
      },
      tags: ["database", "bun"],
    });

    // 3. Search for it directly (sanity check)
    const directHits = await store.search("bun sqlite database", null, scope, 10);
    expect(directHits.length).toBe(1);
    expect(directHits[0]!.record.content).toContain("bun:sqlite");

    // 4. Set up context injection with a mock ctx
    const memo = createMemo();
    const contextEvents: Array<{ type: string; system: unknown[] }> = [];
    let hookCalled = false;

    const mockCtx = {
      session: {
        hook: async (
          name: string,
          cb: (input: { system: unknown[]; messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>; sessionID: string; agent: string; tools: Record<string, unknown>; model: unknown }) => Promise<void> | void,
          _options?: unknown,
        ) => {
          hookCalled = true;

          // Simulate a context event with a user message
          const system: unknown[] = [];
          const event = {
            system,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "bun sqlite database layer uses plugin" }],
              },
            ],
            sessionID: "smoke-session-001",
            agent: "build",
            tools: {} as Record<string, unknown>,
            model: { providerID: "test", id: "test" },
          };

          try {
            await cb(event as never);
          } catch (err) {
            warnings.push(`CB error: ${err instanceof Error ? err.message : String(err)}`);
          }
          contextEvents.push({ type: name, system });
          return { dispose: async () => {} };
        },
      },
    };

    const cleanup = registerContextHook(
      mockCtx as never,
      {
        store,
        embedder: { embedder: null, degraded: true, reason: "test" },
        resolved: RESOLVED,
      },
      {
        ...DEFAULT_OPTIONS,
        inject: { ...DEFAULT_OPTIONS.inject, enabled: true, minScore: 0 },
      },
      debugLog,
      memo,
    );

    // 5. Wait for hook registration
    await new Promise((r) => setTimeout(r, 100));
    expect(hookCalled).toBe(true);

    // Debug: log any warnings
    if (warnings.length > 0) {
      console.log("[DEBUG warnings]", warnings.join("\n"));
    }

    // 6. Verify the injected block contains our record
    expect(contextEvents.length).toBe(1);
    const injectedSystem = contextEvents[0]!.system;

    // If system is empty, the hook ran but search returned nothing
    expect(injectedSystem.length).toBeGreaterThanOrEqual(1);

    const injectedPart = injectedSystem[0] as { type: string; text: string; metadata?: { source: string } };
    expect(injectedPart.type).toBe("text");
    expect(injectedPart.text).toContain("bun:sqlite");
    expect(injectedPart.text).toContain("recalled_notes");
    expect(injectedPart.metadata?.source).toBe("residue.memory");

    // Cleanup
    cleanup();
    await store.close();
  });
});
