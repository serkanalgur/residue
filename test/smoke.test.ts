/**
 * End-to-end smoke test for Residue.
 *
 * Exercises the whole pipeline: insert → search → inject → verify.
 * This is NOT a unit test — it uses a real InMemoryStore and real
 * components wired together.
 *
 * @module test/smoke
 */

import { describe, it, expect } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { buildScopePredicate, resolveScope } from "../src/scope.js";
import { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "../src/ingest/buffer.js";
import { registerIngestion, type IngestionCtx, type SubscribeDeps } from "../src/ingest/subscribe.js";
import { registerContextHook } from "../src/inject/context-hook.js";
import { createMemo } from "../src/inject/memo.js";
import { hybridSearch } from "../src/retrieval/search.js";
import { select } from "../src/retrieval/select.js";
import { renderBlock } from "../src/inject/render.js";
import { resolveOptions } from "../src/config.js";
import type { Logger } from "../src/log.js";
import type { MemoryDraft, SearchHit } from "../src/core/types.js";
import type { Plugin } from "@opencode/plugin";

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const RESOLVED = {
  projectID: "proj-smoke-test",
  worktreeKey: "wk-smoke-test",
  branchKey: "main" as string | null,
  canonicalDir: "/smoke-test",
};

// ---------------------------------------------------------------------------
// Mock event source for AsyncIterable
// ---------------------------------------------------------------------------

function createMockEventSource() {
  type Event = { readonly type: string; readonly data?: Record<string, unknown> };
  const eventBuffer: Event[] = [];
  const waitingResolvers: Array<(value: IteratorResult<Event>) => void> = [];

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
  };
}

// ---------------------------------------------------------------------------
// Smoke test: insert → search → inject → verify
// ---------------------------------------------------------------------------

describe("Smoke test — end-to-end pipeline", () => {
  it("insert record → search for it → context injection contains the record", async () => {
    // 1. Create a real store
    const store = new InMemoryStore();
    await store.initialize();

    const options = resolveOptions({});
    const scope = buildScopePredicate("both", RESOLVED, options);

    // 2. Insert a known memory record
    const draft: MemoryDraft = {
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "The plugin uses SQLite with WAL mode for concurrent access",
      embedding: null,
      source: {
        sessionID: "ses-smoke-001",
        messageID: "msg-1",
        timestamp: new Date().toISOString(),
      },
      tags: ["database", "sqlite"],
    };

    const inserted = await store.insert(draft);
    expect(inserted.id).toBeTruthy();
    expect(inserted.content).toBe("The plugin uses SQLite with WAL mode for concurrent access");

    // 3. Verify the record is in the store
    const count = await store.count(scope);
    expect(count).toBe(1);

    // 4. Search for it (FTS5 not available in InMemoryStore, but text match works)
    const hits = await store.search(
      "SQLite WAL concurrent",
      null,
      scope,
      10,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.content).toContain("SQLite");

    // 5. Select and render
    const selected = select(hits, {
      maxFacts: 6,
      minScore: 0,
      maxChars: 2400,
    });
    expect(selected.length).toBeGreaterThan(0);

    const rendered = renderBlock(selected, {
      maxChars: 2400,
      minScore: 0,
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.factCount).toBeGreaterThan(0);
    expect(rendered!.charCount).toBeGreaterThan(0);

    // 6. Verify the rendered SystemPart contains the memory content
    const systemPart = rendered!.part;
    expect(systemPart.type).toBe("text");
    const text = (systemPart as { type: string; text: string }).text;
    expect(text).toContain("SQLite");
    expect(text).toContain("WAL");
    expect(text).toContain("recalled_notes");
    expect(text).toContain("residue_memory");

    // 7. Verify context hook injection
    const mockCtx: Pick<Plugin.Context, "session"> = {
      session: {
        hook: async (name, callback, opts) => {
          // Immediately invoke the callback to test injection
          // We need to construct a mock SessionContext
          const event = {
            sessionID: "ses-smoke-001",
            model: { id: "test", providerID: "test" },
            agent: "build",
            system: [] as Array<{ type: string; text: string }>,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Tell me about the SQLite database setup" }],
                id: "user-msg-1",
              },
            ],
            options: {},
            tools: {
              res_add: { description: "Add memory", input: {} },
            },
          };

          // @ts-expect-error — testing callback invocation
          await callback(event);

          // Verify: system array should have the residue memory injected
          const injectedParts = event.system.filter(
            (p: { metadata?: Record<string, unknown> }) =>
              p.metadata !== undefined && (p.metadata as Record<string, unknown>).source === "residue.memory",
          );
          expect(injectedParts.length).toBe(1);
          const injectedText = (injectedParts[0] as { text: string }).text;
          expect(injectedText).toContain("SQLite");
          expect(injectedText).toContain("recalled_notes");

          return { dispose: async () => {} };
        },
      },
    };

    const memo = createMemo();
    const cleanup = registerContextHook(
      mockCtx,
      {
        store,
        embedder: { embedder: null, degraded: true, reason: "no embedder in test" },
        resolved: RESOLVED,
      },
      options,
      silentLog,
      memo,
    );

    cleanup();
  });
});
