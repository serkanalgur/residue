/**
 * Regression tests for the `contradicts` → `superseded_by` path.
 *
 * The extraction prompt (src/ingest/prompts.ts) asks the model for a brief
 * textual reference to the fact a new memory supersedes. Before this was wired,
 * `RawExtraction.contradicts` was parsed and then silently discarded, so
 * `MemoryRecord.superseded_by` was never populated and the retention engine's
 * superseded-first eviction (src/retention.ts evictionScore → score 0) could
 * never fire.
 *
 * These tests pin:
 * - A contradicting fact marks the earlier record superseded (end to end).
 * - A contradiction that matches nothing is dropped, not guessed.
 * - A store without supersede/search support degrades safely.
 * - A record never supersedes itself.
 *
 * NO REAL API CALLS — all deps are mocks or InMemoryStore.
 *
 * @module test/contradicts
 */

import { describe, it, expect } from "bun:test";
import { registerIngestion, type IngestionCtx, type SubscribeDeps } from "../src/ingest/subscribe.js";
import { extractMemories } from "../src/ingest/extractor.js";
import type { IngestOptions } from "../src/ingest/types.js";
import type { TurnBuffer } from "../src/ingest/buffer.js";
import type { Logger } from "../src/log.js";
import { InMemoryStore } from "../src/store/memory-store.js";

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
  projectID: "proj-contradicts",
  worktreeKey: "wk-contradicts",
  branchKey: "main" as string | null,
  canonicalDir: "/contradicts",
};

const OPTIONS: IngestOptions = {
  autoCapture: true,
  maxFactsPerIdle: 8,
  minIntervalMs: 0,
  extractionsPerSession: 20,
  bufferCapacity: 200,
  bufferMaxChars: 100_000,
};

function makeMockEventSource() {
  type Event = { readonly type: string; readonly data?: Record<string, unknown> };
  const queue: Event[] = [];
  const waiting: Array<(v: IteratorResult<Event>) => void> = [];

  return {
    subscribe: (_o: { signal?: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Event>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            return new Promise((resolve) => waiting.push(resolve));
          },
          return(): Promise<IteratorResult<Event>> {
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    }),
    emit(type: string, data?: Record<string, unknown>) {
      const ev = { type, data } as Event;
      if (waiting.length > 0) waiting.shift()!({ value: ev, done: false });
      else queue.push(ev);
    },
  };
}

function makeCtx(): IngestionCtx {
  const src = makeMockEventSource();
  return {
    event: src,
    session: { get: async () => ({ projectID: RESOLVED.projectID }) },
    location: { project: { id: RESOLVED.projectID } },
  } as unknown as IngestionCtx;
}

function makeBuffer(takeText: string | null): TurnBuffer {
  return { push: () => {}, take: () => takeText, size: () => 0, clear: () => {} };
}

const generateText = async () => ({ text: '{"memories":[]}' });
const defaultModel = async () => ({ id: "test-model", providerID: "test-provider" });

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 100));
}

/** Register ingestion and drive one idle cycle, returning the store. */
async function runIdleCycle(
  store: InMemoryStore,
  extractResponse: string,
): Promise<void> {
  const ctx = makeCtx();
  const deps: SubscribeDeps = {
    buffer: makeBuffer("some conversation text"),
    generateText: async () => ({ text: extractResponse }),
    defaultModel,
    store: store as unknown as SubscribeDeps["store"],
    resolved: RESOLVED,
    sessionGet: async () => ({ projectID: RESOLVED.projectID }),
  };

  const cleanup = registerIngestion(ctx, deps, OPTIONS, silentLog);

  // Feed a delta so the buffer would have content, then trigger extraction.
  (ctx.event as unknown as { emit: (t: string, d?: Record<string, unknown>) => void })
    .emit("session.text.delta", { sessionID: "ses-1", delta: "x", assistantMessageID: "m1" });
  (ctx.event as unknown as { emit: (t: string, d?: Record<string, unknown>) => void })
    .emit("session.idle", { sessionID: "ses-1" });

  await flush();
  cleanup();
}

// ---------------------------------------------------------------------------
// Extractor: contradicts is carried onto the draft
// ---------------------------------------------------------------------------

describe("extractMemories — contradicts field", () => {
  const resolved = {
    projectID: RESOLVED.projectID,
    worktreeKey: RESOLVED.worktreeKey,
    branchKey: RESOLVED.branchKey,
    canonicalDir: RESOLVED.canonicalDir,
  };

  it("carries a non-empty contradicts string onto the draft", async () => {
    const result = await extractMemories(
      async () => ({
        text: JSON.stringify({
          memories: [
            {
              text: "Project uses vitest for all unit tests",
              kind: "decision",
              tags: ["testing"],
              confidence: 0.9,
              contradicts: "Project uses jest for all unit tests",
            },
          ],
        }),
      }),
      defaultModel,
      "transcript",
      "ses-1",
      undefined,
      resolved,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.contradicts).toBe("Project uses jest for all unit tests");
  });

  it("omits contradicts when absent, empty, or whitespace", async () => {
    for (const contradicts of [undefined, "", "   "]) {
      const result = await extractMemories(
        async () => ({
          text: JSON.stringify({
            memories: [
              { text: "A standalone fact about the build", kind: "fact", tags: [], confidence: 0.7, contradicts },
            ],
          }),
        }),
        defaultModel,
        "transcript",
        "ses-1",
        undefined,
        resolved,
        { maxFactsPerIdle: 8 },
        silentLog,
      );

      expect(result.drafts).toHaveLength(1);
      expect(result.drafts[0]?.contradicts).toBeUndefined();
    }
  });

  it("truncates an overlong contradicts reference", async () => {
    const long = "x".repeat(5000);
    const result = await extractMemories(
      async () => ({
        text: JSON.stringify({
          memories: [
            { text: "A standalone fact that is long enough", kind: "fact", tags: [], confidence: 0.7, contradicts: long },
          ],
        }),
      }),
      defaultModel,
      "transcript",
      "ses-1",
      undefined,
      resolved,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    expect(result.drafts[0]?.contradicts).toHaveLength(300);
  });
});

// ---------------------------------------------------------------------------
// End to end: contradicting fact supersedes the earlier one
// ---------------------------------------------------------------------------

describe("contradicts → superseded_by", () => {
  it("marks the earlier record superseded when a later fact contradicts it", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    // First: the original fact.
    const first = await store.insert({
      kind: "decision",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Project uses jest for all unit tests",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: ["testing"],
    });
    expect(first.superseded_by).toBeNull();

    // Second: a contradicting fact arrives with a contradicts reference.
    await runIdleCycle(
      store,
      JSON.stringify({
        memories: [
          {
            text: "Project uses vitest for all unit tests",
            kind: "decision",
            tags: ["testing"],
            confidence: 0.9,
            contradicts: "Project uses jest for all unit tests",
          },
        ],
      }),
    );

    // The original must now be marked superseded, and point at the new record.
    const reloaded = await store.get(first.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.superseded_by).not.toBeNull();

    const supersederId = reloaded?.superseded_by ?? "";
    const superseder = await store.get(supersederId);
    expect(superseder?.content).toBe("Project uses vitest for all unit tests");
  });

  it("supersedes the prior record even when the new fact shares its terms", async () => {
    // The contradiction reference deliberately overlaps the new fact's wording
    // ("...instead of jest"), which is the case where a post-insert lookup
    // would rank the NEW record as the top hit. Resolution happens before the
    // insert, so the prior record must still win.
    const store = new InMemoryStore();
    await store.initialize();

    const first = await store.insert({
      kind: "decision",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Project uses jest for all unit tests",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    await runIdleCycle(
      store,
      JSON.stringify({
        memories: [
          {
            text: "Project uses vitest for all unit tests",
            kind: "decision",
            tags: [],
            confidence: 0.9,
            // Shares 4 of 5 terms with the new fact.
            contradicts: "jest for all unit tests",
          },
        ],
      }),
    );

    const reloaded = await store.get(first.id);
    expect(reloaded?.superseded_by).not.toBeNull();

    // The superseder must be the NEW record, and must not point at itself.
    const superseder = await store.get(reloaded?.superseded_by ?? "");
    expect(superseder?.id).not.toBe(first.id);
    expect(superseder?.content).toBe("Project uses vitest for all unit tests");
    expect(superseder?.superseded_by).toBeNull();
  });

  it("does not re-supersede an already superseded record", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const first = await store.insert({
      kind: "decision",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Project uses jest for all unit tests",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    // First contradiction supersedes the original.
    await runIdleCycle(
      store,
      JSON.stringify({
        memories: [
          {
            text: "Project uses vitest for all unit tests",
            kind: "decision",
            tags: [],
            confidence: 0.9,
            contradicts: "Project uses jest for all unit tests",
          },
        ],
      }),
    );

    const afterFirst = await store.get(first.id);
    const firstSupersededBy = afterFirst?.superseded_by ?? "";
    expect(firstSupersededBy).not.toBe("");

    // A second contradiction referencing the same text must not re-point the
    // original at yet another record — that would orphan the chain.
    await runIdleCycle(
      store,
      JSON.stringify({
        memories: [
          {
            text: "Project uses bun test for all unit tests",
            kind: "decision",
            tags: [],
            confidence: 0.9,
            contradicts: "Project uses jest for all unit tests",
          },
        ],
      }),
    );

    const afterSecond = await store.get(first.id);
    // Unchanged — still points at the original superseder.
    expect(afterSecond?.superseded_by).toBe(firstSupersededBy);
  });

  it("drops a contradiction that matches no stored record", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const existing = await store.insert({
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Completely unrelated statement about database indexing",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    await runIdleCycle(
      store,
      JSON.stringify({
        memories: [
          {
            text: "Brand new fact about the deployment pipeline",
            kind: "fact",
            tags: [],
            confidence: 0.8,
            contradicts: "zzzzqqqq nonexistent prior fact that cannot match anything real",
          },
        ],
      }),
    );

    // The unrelated record must NOT be marked superseded — no spurious link.
    const reloaded = await store.get(existing.id);
    expect(reloaded?.superseded_by).toBeNull();
  });

  it("still inserts the new record when the store cannot supersede", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    // A store that only supports insert — supersede/search absent.
    const insertOnly = {
      insert: async (draft: Parameters<InMemoryStore["insert"]>[0]) => store.insert(draft),
    };

    const ctx = makeCtx();
    const cleanup = registerIngestion(
      ctx,
      {
        buffer: makeBuffer("conversation"),
        generateText: async () => ({
          text: JSON.stringify({
            memories: [
              { text: "A fact recorded despite no supersede support", kind: "fact", tags: [], confidence: 0.8, contradicts: "anything" },
            ],
          }),
        }),
        defaultModel,
        store: insertOnly as unknown as SubscribeDeps["store"],
        resolved: RESOLVED,
        sessionGet: async () => ({ projectID: RESOLVED.projectID }),
      },
      OPTIONS,
      silentLog,
    );

    (ctx.event as unknown as { emit: (t: string, d?: Record<string, unknown>) => void })
      .emit("session.idle", { sessionID: "ses-1" });
    await flush();
    cleanup();

    // The record must still land even though the contradiction was dropped.
    const all = await store.scan({
      scope: {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": RESOLVED.projectID },
      },
      limit: 100,
    });
    expect(all.some((r) => r.content === "A fact recorded despite no supersede support")).toBe(true);
  });
});
