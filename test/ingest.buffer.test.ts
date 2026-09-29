/**
 * Tests for the session turn buffer.
 *
 * Covers:
 * - Ring buffer capacity enforcement (oldest evicted)
 * - Character limit enforcement
 * - Content hash deduplication (same text not stored twice)
 * - minIntervalMs debounce (take returns null if too soon)
 * - take clears the buffer
 * - Session isolation (different sessions are independent)
 * - push ignores empty text
 * - size returns correct count
 * - clear empties the buffer
 *
 * @module test/ingest.buffer
 */

import { describe, it, expect } from "bun:test";
import { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "../src/ingest/buffer.js";
import type { TurnBuffer, TurnBufferConfig } from "../src/ingest/buffer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a buffer with custom config and a controllable clock. */
function makeBuffer(
  configOverrides: Partial<TurnBufferConfig> = {},
  startTime: number = 100_000, // Start well above minIntervalMs
): { buffer: TurnBuffer; advance: (ms: number) => void } {
  let currentTime = startTime;
  const now = () => currentTime;
  const buffer = createTurnBuffer(
    { ...DEFAULT_BUFFER_CONFIG, minIntervalMs: 0, ...configOverrides },
    now,
  );

  return {
    buffer,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Ring buffer capacity
// ---------------------------------------------------------------------------

describe("TurnBuffer — ring buffer capacity", () => {
  it("evicts oldest entries when capacity is reached", () => {
    const { buffer } = makeBuffer({ capacity: 3 });

    buffer.push("s1", "m1", "first message");
    buffer.push("s1", "m2", "second message");
    buffer.push("s1", "m3", "third message");
    buffer.push("s1", "m4", "fourth message"); // should evict "first"

    expect(buffer.size("s1")).toBe(3);

    const text = buffer.take("s1");
    expect(text).not.toContain("first message");
    expect(text).toContain("second message");
    expect(text).toContain("fourth message");
  });

  it("respects default capacity of 200", () => {
    const { buffer } = makeBuffer({ capacity: 200 });

    for (let i = 0; i < 200; i++) {
      buffer.push("s1", `m${i}`, `message ${i}`);
    }

    expect(buffer.size("s1")).toBe(200);

    buffer.push("s1", "m200", "message 200");
    expect(buffer.size("s1")).toBe(200); // still 200, oldest evicted
  });
});

// ---------------------------------------------------------------------------
// Character limit
// ---------------------------------------------------------------------------

describe("TurnBuffer — character limit", () => {
  it("evicts oldest entries when character limit is exceeded", () => {
    const { buffer } = makeBuffer({ maxChars: 100 });

    buffer.push("s1", "m1", "a".repeat(50)); // 50 chars
    buffer.push("s1", "m2", "b".repeat(50)); // 100 chars total
    buffer.push("s1", "m3", "c".repeat(50)); // would be 150 — evicts oldest

    const text = buffer.take("s1");
    expect(text).not.toContain("aaa"); // first evicted
    expect(text).toContain("bbb"); // second kept
    expect(text).toContain("ccc"); // third kept
  });
});

// ---------------------------------------------------------------------------
// Content hash deduplication
// ---------------------------------------------------------------------------

describe("TurnBuffer — content hash deduplication", () => {
  it("rejects duplicate content (same text)", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "identical message");
    buffer.push("s1", "m2", "identical message"); // duplicate

    expect(buffer.size("s1")).toBe(1);
  });

  it("allows different content", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "message one");
    buffer.push("s1", "m2", "message two");

    expect(buffer.size("s1")).toBe(2);
  });

  it("allows same text in different sessions", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "shared message");
    buffer.push("s2", "m1", "shared message"); // different session

    expect(buffer.size("s1")).toBe(1);
    expect(buffer.size("s2")).toBe(1);
  });

  it("allows re-add after take (buffer is cleared)", () => {
    const { buffer, advance } = makeBuffer({ minIntervalMs: 100 });

    buffer.push("s1", "m1", "message");
    buffer.take("s1"); // clears buffer
    advance(200);

    buffer.push("s1", "m2", "message"); // same text, but buffer was cleared
    expect(buffer.size("s1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// minIntervalMs debounce
// ---------------------------------------------------------------------------

describe("TurnBuffer — minIntervalMs debounce", () => {
  it("returns null if taken too soon after last take", () => {
    const { buffer, advance } = makeBuffer({ minIntervalMs: 1000 });

    buffer.push("s1", "m1", "message");
    const first = buffer.take("s1");
    expect(first).toBe("message");

    buffer.push("s1", "m2", "another message");
    advance(500); // only 500ms elapsed
    const second = buffer.take("s1");
    expect(second).toBe(null); // too soon
  });

  it("allows take after minIntervalMs has elapsed", () => {
    const { buffer, advance } = makeBuffer({ minIntervalMs: 1000 });

    buffer.push("s1", "m1", "first batch");
    buffer.take("s1");

    buffer.push("s1", "m2", "second batch");
    advance(1500); // 1500ms elapsed
    const second = buffer.take("s1");
    expect(second).toBe("second batch");
  });

  it("returns null on first take if buffer is empty", () => {
    const { buffer } = makeBuffer();
    expect(buffer.take("s1")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// take clears the buffer
// ---------------------------------------------------------------------------

describe("TurnBuffer — take clears buffer", () => {
  it("take returns all buffered text and clears", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "line one");
    buffer.push("s1", "m2", "line two");

    const text = buffer.take("s1");
    expect(text).toContain("line one");
    expect(text).toContain("line two");

    // Buffer should be empty now
    expect(buffer.size("s1")).toBe(0);
  });

  it("take returns text joined with double newline", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "alpha");
    buffer.push("s1", "m2", "beta");

    const text = buffer.take("s1");
    expect(text).toBe("alpha\n\nbeta");
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("TurnBuffer — session isolation", () => {
  it("different sessions are completely isolated", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "session 1 content");
    buffer.push("s2", "m1", "session 2 content");

    expect(buffer.size("s1")).toBe(1);
    expect(buffer.size("s2")).toBe(1);

    const text1 = buffer.take("s1");
    const text2 = buffer.take("s2");

    expect(text1).toBe("session 1 content");
    expect(text2).toBe("session 2 content");
  });

  it("clearing one session does not affect another", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "s1 content");
    buffer.push("s2", "m1", "s2 content");

    buffer.clear("s1");

    expect(buffer.size("s1")).toBe(0);
    expect(buffer.size("s2")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("TurnBuffer — edge cases", () => {
  it("push ignores empty string", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "");
    buffer.push("s1", "m2", "   ");

    expect(buffer.size("s1")).toBe(0);
  });

  it("size returns 0 for unknown session", () => {
    const { buffer } = makeBuffer();
    expect(buffer.size("nonexistent")).toBe(0);
  });

  it("clear on unknown session is a no-op", () => {
    const { buffer } = makeBuffer();
    expect(() => buffer.clear("nonexistent")).not.toThrow();
  });

  it("take after clear returns null", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "content");
    buffer.clear("s1");

    expect(buffer.take("s1")).toBe(null);
  });

  it("single message returns that message on take", () => {
    const { buffer } = makeBuffer();

    buffer.push("s1", "m1", "only message");

    expect(buffer.take("s1")).toBe("only message");
  });
});
