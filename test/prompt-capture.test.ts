/**
 * Tests for user-prompt capture (prompt-buffer.ts + session.inbox.enqueued).
 *
 * The capture path is opt-in (`capturePrompts`, default false) because it
 * widens what the plugin persists. These tests pin both halves of that
 * contract: the gate, and the parsing of the inbox event payload.
 *
 * Event shape verified empirically against a live opencode session:
 *   { sessionID, inboxID, item: { type: "user", payload: { text }, delivery } }
 *
 * NO REAL API CALLS — all deps are mocks.
 *
 * @module test/prompt-capture
 */

import { describe, it, expect } from "bun:test";
import {
  createPromptBuffer,
  isTrivialPrompt,
  DEFAULT_PROMPT_BUFFER_CONFIG,
} from "../src/ingest/prompt-buffer.js";
import { registerIngestion, type IngestionCtx, type SubscribeDeps } from "../src/ingest/subscribe.js";
import type { IngestOptions } from "../src/ingest/types.js";
import type { TurnBuffer } from "../src/ingest/buffer.js";
import type { PromptBuffer } from "../src/ingest/prompt-buffer.js";
import type { Logger } from "../src/log.js";

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const RESOLVED = {
  projectID: "proj-prompt-capture",
  worktreeKey: "wk-prompt-capture",
  branchKey: "main" as string | null,
  canonicalDir: "/prompt-capture",
};

function options(overrides: Partial<IngestOptions> = {}): IngestOptions {
  return {
    autoCapture: true,
    capturePrompts: false,
    maxFactsPerIdle: 8,
    minIntervalMs: 0,
    extractionsPerSession: 20,
    bufferCapacity: 200,
    bufferMaxChars: 100_000,
    ...overrides,
  };
}

function mockBuffer(): TurnBuffer {
  return { push: () => {}, take: () => null, size: () => 0, clear: () => {} };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

/** Build a realistic inbox.enqueued payload. */
function inboxUser(text: string, delivery = "steer") {
  return {
    sessionID: "ses-1",
    inboxID: "msg_1",
    item: { type: "user", payload: { text }, delivery },
  };
}

function makeCtx() {
  const queue: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const waiting: Array<(v: IteratorResult<{ type: string; data?: Record<string, unknown> }>) => void> = [];
  const ctx = {
    event: {
      subscribe: (_o: { signal?: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ type: string; data?: Record<string, unknown> }>> {
              const ev = queue.shift();
              if (ev) return Promise.resolve({ value: ev, done: false });
              return new Promise((resolve) => waiting.push(resolve));
            },
            return: () => Promise.resolve({ value: undefined as never, done: true }),
          };
        },
      }),
    },
    session: { get: async () => ({ projectID: RESOLVED.projectID }) },
    location: { project: { id: RESOLVED.projectID } },
  } as unknown as IngestionCtx;
  return {
    ctx,
    emit(type: string, data?: Record<string, unknown>) {
      const ev = { type, data };
      if (waiting.length > 0) waiting.shift()!({ value: ev, done: false });
      else queue.push(ev);
    },
  };
}

// ---------------------------------------------------------------------------
// isTrivialPrompt
// ---------------------------------------------------------------------------

describe("isTrivialPrompt", () => {
  it("filters acknowledgements and continuations", () => {
    for (const t of ["ok", "OK.", "thanks", "yes", "yep", "continue", "go on", "sure", "done", "np"]) {
      expect(isTrivialPrompt(t)).toBe(true);
    }
  });

  it("filters slash commands and single tokens", () => {
    expect(isTrivialPrompt("/help")).toBe(true);
    expect(isTrivialPrompt("/compact")).toBe(true);
    expect(isTrivialPrompt("retry")).toBe(true);
  });

  it("keeps prompts that carry real intent", () => {
    for (const t of [
      "Always use vitest instead of jest in this repo",
      "The API contract must stay backward compatible",
      "Never commit directly to main",
    ]) {
      expect(isTrivialPrompt(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PromptBuffer
// ---------------------------------------------------------------------------

describe("PromptBuffer", () => {
  it("captures and takes prompts per session", () => {
    const buf = createPromptBuffer({ ...DEFAULT_PROMPT_BUFFER_CONFIG, filterTrivial: false });
    expect(buf.push("s1", "First durable statement about the build system")).toBe(true);
    expect(buf.push("s1", "Second durable statement about testing")).toBe(true);
    expect(buf.size("s1")).toBe(2);

    const taken = buf.take("s1");
    expect(taken).toContain("First durable statement");
    expect(taken).toContain("<user_prompt>");
    // take() clears.
    expect(buf.size("s1")).toBe(1 - 1);
    expect(buf.take("s1")).toBeNull();
  });

  it("isolates sessions", () => {
    const buf = createPromptBuffer({ ...DEFAULT_PROMPT_BUFFER_CONFIG, filterTrivial: false });
    buf.push("s1", "A statement belonging to session one only");
    expect(buf.size("s2")).toBe(0);
    expect(buf.take("s2")).toBeNull();
  });

  it("deduplicates identical prompts", () => {
    const buf = createPromptBuffer({ ...DEFAULT_PROMPT_BUFFER_CONFIG, filterTrivial: false });
    expect(buf.push("s1", "The same prompt repeated twice over")).toBe(true);
    expect(buf.push("s1", "The same prompt repeated twice over")).toBe(false);
    expect(buf.size("s1")).toBe(1);
  });

  it("filters trivial prompts when enabled, and keeps them when disabled", () => {
    const filtered = createPromptBuffer({ ...DEFAULT_PROMPT_BUFFER_CONFIG, filterTrivial: true });
    expect(filtered.push("s1", "ok")).toBe(false);
    expect(filtered.push("s1", "Always deploy via the staging pipeline first")).toBe(true);

    const unfiltered = createPromptBuffer({ ...DEFAULT_PROMPT_BUFFER_CONFIG, filterTrivial: false });
    expect(unfiltered.push("s1", "ok")).toBe(true);
  });

  it("bounds by capacity, evicting oldest", () => {
    const buf = createPromptBuffer({ capacity: 2, maxChars: 10_000, filterTrivial: false });
    buf.push("s1", "Prompt number one here");
    buf.push("s1", "Prompt number two here");
    buf.push("s1", "Prompt number three here");
    expect(buf.size("s1")).toBe(2);

    const taken = buf.take("s1") ?? "";
    expect(taken).not.toContain("Prompt number one here");
    expect(taken).toContain("Prompt number three here");
  });

  it("rejects empty and non-string input", () => {
    const buf = createPromptBuffer();
    expect(buf.push("s1", "")).toBe(false);
    expect(buf.push("s1", "   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session.inbox.enqueued wiring
// ---------------------------------------------------------------------------

describe("session.inbox.enqueued handling", () => {
  function wire(capturePrompts: boolean, promptBuffer?: PromptBuffer) {
    const { ctx, emit } = makeCtx();
    const deps: SubscribeDeps = {
      buffer: mockBuffer(),
      promptBuffer,
      generateText: async () => ({ text: '{"memories":[]}' }),
      defaultModel: async () => ({ id: "m", providerID: "p" }),
      store: { insert: async () => ({ id: "rec-1" }) },
      resolved: RESOLVED,
      sessionGet: async () => ({ projectID: RESOLVED.projectID }),
    };
    const cleanup = registerIngestion(ctx, deps, options({ capturePrompts }), silentLog);
    return { emit, cleanup };
  }

  it("captures a user prompt when capturePrompts is enabled", async () => {
    const buf = createPromptBuffer();
    const { emit, cleanup } = wire(true, buf);

    emit("session.inbox.enqueued", inboxUser("Always use pnpm, never npm"));
    await flush();
    cleanup();

    const taken = buf.take("ses-1") ?? "";
    expect(taken).toContain("Always use pnpm, never npm");
  });

  it("captures nothing when capturePrompts is disabled (default)", async () => {
    const buf = createPromptBuffer();
    const { emit, cleanup } = wire(false, buf);

    emit("session.inbox.enqueued", inboxUser("Always use pnpm, never npm"));
    await flush();
    cleanup();

    expect(buf.size("ses-1")).toBe(0);
    expect(buf.take("ses-1")).toBeNull();
  });

  it("ignores synthetic, compaction, and move inbox items", async () => {
    const buf = createPromptBuffer();
    const { emit, cleanup } = wire(true, buf);

    emit("session.inbox.enqueued", {
      sessionID: "ses-1",
      inboxID: "msg_s",
      item: { type: "synthetic", payload: { text: "machine generated note" }, delivery: "queue" },
    });
    emit("session.inbox.enqueued", {
      sessionID: "ses-1",
      inboxID: "msg_c",
      item: { type: "compaction", payload: {}, delivery: "queue" },
    });
    emit("session.inbox.enqueued", {
      sessionID: "ses-1",
      inboxID: "msg_m",
      item: { type: "move", payload: {}, delivery: "queue" },
    });
    await flush();
    cleanup();

    expect(buf.size("ses-1")).toBe(0);
  });

  it("ignores malformed payloads without throwing", async () => {
    const buf = createPromptBuffer();
    const { emit, cleanup } = wire(true, buf);

    emit("session.inbox.enqueued", undefined);
    emit("session.inbox.enqueued", {});
    emit("session.inbox.enqueued", { sessionID: "ses-1" });
    emit("session.inbox.enqueued", { sessionID: "ses-1", item: null });
    emit("session.inbox.enqueued", { sessionID: "ses-1", item: { type: "user" } });
    emit("session.inbox.enqueued", { sessionID: "ses-1", item: { type: "user", payload: {} } });
    emit("session.inbox.enqueued", { sessionID: "ses-1", item: { type: "user", payload: { text: 42 } } });
    await flush();
    cleanup();

    expect(buf.size("ses-1")).toBe(0);
  });

  it("is inert when no prompt buffer is supplied", async () => {
    const { emit, cleanup } = wire(true, undefined);
    emit("session.inbox.enqueued", inboxUser("Some prompt with no buffer attached"));
    await flush();
    cleanup();
    // Reaching here without throwing is the assertion.
  });
});
