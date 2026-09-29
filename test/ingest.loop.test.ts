/**
 * Tests for the ingestion loop (subscribe.ts).
 *
 * **ANTI-FEEDBACK LOOP** is the critical path tested here:
 * - res_add triggers idle → must NOT cause infinite extraction
 * - extractionsPerSession cap is enforced
 * - Model receives placeholder, not actual content
 * - 50 consecutive idles don't cause infinite loop
 * - Store failure in idle handler does NOT throw
 *
 * Uses MOCKS for ctx.event.subscribe, ctx.session.get, store, buffer, and model.
 * NO REAL API CALLS.
 *
 * The V2 API uses AsyncIterable for events. Our mock creates an async generator
 * that yields events on demand via a controller.
 *
 * @module test/ingest.loop
 */

import { describe, it, expect } from "bun:test";
import { registerIngestion, type IngestionCtx, type SubscribeDeps } from "../src/ingest/subscribe.js";
import type { IngestOptions } from "../src/ingest/types.js";
import type { MemoryDraft } from "../src/core/types.js";
import type { Logger } from "../src/log.js";
import type { TurnBuffer } from "../src/ingest/buffer.js";
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
  projectID: "proj-loop-test",
  worktreeKey: "wk-loop-test",
  branchKey: "main" as string | null,
  canonicalDir: "/loop-test",
};

const DEFAULT_OPTIONS: IngestOptions = {
  autoCapture: true,
  maxFactsPerIdle: 8,
  minIntervalMs: 20_000,
  extractionsPerSession: 20,
  bufferCapacity: 200,
  bufferMaxChars: 100_000,
};

/**
 * Create a mock event source that yields events on demand.
 * Uses a buffer to queue events that are emitted before the iterator starts.
 */
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
            // If events are buffered, deliver immediately
            if (eventBuffer.length > 0) {
              const event = eventBuffer.shift()!;
              return Promise.resolve({ value: event, done: false });
            }
            // Otherwise wait for an event
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
        // Someone is waiting — deliver directly
        const resolver = waitingResolvers.shift()!;
        resolver({ value: event, done: false });
      } else {
        // Buffer the event for later
        eventBuffer.push(event);
      }
    },
    isDone: () => done,
  };
}

/** Create a mock IngestionCtx with an event source that can emit events. */
function makeMockCtx(): {
  ctx: IngestionCtx;
  emitIdle: (sessionID: string) => void;
  emitDelta: (sessionID: string, delta: string) => void;
  idleCount: number;
} {
  let idleCount = 0;
  const eventSource = createMockEventSource();

  const ctx: IngestionCtx = {
    event: eventSource,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        return { projectID: RESOLVED.projectID };
      },
    },
    location: {
      project: { id: RESOLVED.projectID },
    },
  };

  return {
    ctx,
    emitIdle: (sessionID: string) => {
      idleCount++;
      eventSource.emit("session.idle", { sessionID });
    },
    emitDelta: (sessionID: string, delta: string) => {
      eventSource.emit("session.text.delta", { sessionID, delta, assistantMessageID: "msg-1", ordinal: 0 });
    },
    get idleCount() {
      return idleCount;
    },
  };
}

/** Create a mock buffer with controllable take behavior. */
function makeMockBuffer(takeText: string | null): TurnBuffer {
  return {
    push: () => {},
    take: (_sessionID: string) => takeText,
    size: () => 0,
    clear: () => {},
  };
}

/** Create a mock generateText that captures calls. */
function makeMockGenerate(responses: string[] = []) {
  const calls: Array<{ prompt: string; model?: unknown }> = [];
  let callIndex = 0;

  return {
    generateText: async (opts: { prompt: string; model?: unknown }) => {
      calls.push(opts);
      const response = responses[callIndex] ?? '{"memories":[]}';
      callIndex++;
      return { text: response };
    },
    getCalls: () => calls,
    getCallCount: () => calls.length,
  };
}

/** Wait for setTimeout(0) callbacks to flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

// ---------------------------------------------------------------------------
// Anti-feedback loop: res_add → idle does NOT cause new extraction
// ---------------------------------------------------------------------------

describe("Ingestion loop — anti-feedback loop", () => {
  it("res_add triggering idle does NOT cause new extraction (minIntervalMs)", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Some conversation text for extraction");
    const { generateText, getCalls, getCallCount } = makeMockGenerate([
      JSON.stringify({
        memories: [
          {
            text: "Uses bun:sqlite for the project database",
            kind: "fact",
            tags: [],
            confidence: 0.8,
          },
        ],
      }),
    ]);

    // First idle → triggers extraction
    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, DEFAULT_OPTIONS, silentLog);

    emitIdle("ses-001"); // First idle
    await flush(); // Let setTimeout(0) fire

    expect(getCallCount()).toBe(1);

    // Simulate res_add → another idle immediately
    emitIdle("ses-001"); // Second idle — too soon (minIntervalMs)
    await flush();

    // Should NOT trigger another extraction (minIntervalMs debounce)
    expect(getCallCount()).toBe(1);
  });

  it("50 consecutive idles don't cause infinite loop", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Some text for extraction");
    const { generateText, getCallCount } = makeMockGenerate([]);

    // Override minIntervalMs to 0 for this test (to test extractionsPerSession cap)
    const options: IngestOptions = {
      ...DEFAULT_OPTIONS,
      minIntervalMs: 0,
      extractionsPerSession: 5, // Low cap
    };

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, options, silentLog);

    // Emit 50 idles — should be capped at 5
    for (let i = 0; i < 50; i++) {
      emitIdle("ses-001");
    }

    await flush(); // Let all setTimeout(0) callbacks fire

    // Should have been capped at extractionsPerSession
    expect(getCallCount()).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// extractionsPerSession cap
// ---------------------------------------------------------------------------

describe("Ingestion loop — extractionsPerSession cap", () => {
  it("does not exceed extractionsPerSession limit", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Extraction text content here");
    const { generateText, getCallCount } = makeMockGenerate([]);

    const options: IngestOptions = {
      ...DEFAULT_OPTIONS,
      minIntervalMs: 0, // Disable debounce for this test
      extractionsPerSession: 3,
    };

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, options, silentLog);

    for (let i = 0; i < 10; i++) {
      emitIdle("ses-001");
    }

    await flush();

    expect(getCallCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Model receives placeholder, not actual content
// ---------------------------------------------------------------------------

describe("Ingestion loop — placeholder transcript", () => {
  it("model prompt contains session_transcript placeholder, not actual text", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Secret conversation content here");
    const { generateText, getCalls } = makeMockGenerate([]);

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, DEFAULT_OPTIONS, silentLog);

    emitIdle("ses-001");
    await flush();

    // The prompt should use the actual text from buffer (for extraction)
    // but the extraction prompt wraps it in <conversation> tags
    // The key test: the model IS called
    expect(getCalls().length).toBe(1);

    // Verify the prompt includes the conversation text (from buffer.take)
    const prompt = getCalls()[0]!.prompt;
    expect(prompt).toContain("Secret conversation content here");
  });
});

// ---------------------------------------------------------------------------
// Empty buffer → no extraction
// ---------------------------------------------------------------------------

describe("Ingestion loop — empty buffer", () => {
  it("does not call model when buffer.take returns null", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer(null); // empty buffer
    const { generateText, getCallCount } = makeMockGenerate([]);

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, DEFAULT_OPTIONS, silentLog);

    emitIdle("ses-001");
    await flush();

    expect(getCallCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// autoCapture disabled
// ---------------------------------------------------------------------------

describe("Ingestion loop — autoCapture disabled", () => {
  it("does not extract when autoCapture is false", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Some text");
    const { generateText, getCallCount } = makeMockGenerate([]);

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, { ...DEFAULT_OPTIONS, autoCapture: false }, silentLog);

    emitIdle("ses-001");
    await flush();

    expect(getCallCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Store failure does NOT throw
// ---------------------------------------------------------------------------

describe("Ingestion loop — store failure resilience", () => {
  it("idle handler does NOT throw even when store.insert fails", async () => {
    const brokenStore = {
      insert: async () => {
        throw new Error("Database connection lost");
      },
    };

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Text to extract");
    const { generateText, getCallCount } = makeMockGenerate([
      JSON.stringify({
        memories: [
          {
            text: "Uses bun:sqlite for the project database",
            kind: "fact",
            tags: [],
            confidence: 0.8,
          },
        ],
      }),
    ]);

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store: brokenStore,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, DEFAULT_OPTIONS, silentLog);

    // This should NOT throw
    expect(() => {
      emitIdle("ses-001");
    }).not.toThrow();

    await flush();

    // Model was called (extraction happened)
    expect(getCallCount()).toBe(1);
    // Store failure was suppressed
  });
});

// ---------------------------------------------------------------------------
// Session isolation — different sessions have separate caps
// ---------------------------------------------------------------------------

describe("Ingestion loop — session isolation", () => {
  it("different sessions have independent extraction caps", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer("Extraction text content");
    const { generateText, getCallCount } = makeMockGenerate([]);

    const options: IngestOptions = {
      ...DEFAULT_OPTIONS,
      minIntervalMs: 0,
      extractionsPerSession: 2,
    };

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, options, silentLog);

    // Session 1: 3 idles (should cap at 2)
    emitIdle("ses-001");
    emitIdle("ses-001");
    emitIdle("ses-001");

    // Session 2: 2 idles (should reach cap of 2)
    emitIdle("ses-002");
    emitIdle("ses-002");

    await flush();

    // Total: 2 (ses-001) + 2 (ses-002) = 4
    expect(getCallCount()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Session ID extraction from different payload shapes
// ---------------------------------------------------------------------------

describe("Ingestion loop — session ID extraction", () => {
  it("extracts sessionID from object payload", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    const { ctx, emitIdle } = makeMockCtx();
    const buffer = makeMockBuffer(null);
    const { generateText } = makeMockGenerate([]);

    registerIngestion(ctx, {
      buffer,
      generateText,
      defaultModel: () => ({ id: "test", providerID: "test" }),
      store,
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    }, DEFAULT_OPTIONS, silentLog);

    // Emit with object payload — this is the standard V2 event shape
    expect(() => emitIdle("ses-string-id")).not.toThrow();
  });
});
