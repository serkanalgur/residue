/**
 * Embedder contract tests.
 *
 * Every adapter must satisfy the same contract:
 * - Correct dimension
 * - Output is L2-normalized (norm ≈ 1.0)
 * - Deterministic (same input → same output)
 * - `embed(a)` and `embed([a])` produce equivalent results (cos > 0.999)
 * - AbortSignal cancellation works
 * - Empty input doesn't crash
 * - Very long text is handled (truncated or accepted)
 *
 * These tests use a MockEmbedder and mock fetch — no real network calls.
 *
 * @module test/embed.contract
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { l2Normalize, cosine, encodeFloat32, decodeFloat32 } from "../src/embed/normalize.js";
import { createRemoteEmbedder, callEmbeddingsApi } from "../src/embed/remote.js";
import { createOllamaEmbedder, callOllamaApi, probeOllama } from "../src/embed/ollama.js";
import type { Embedder } from "../src/core/ports.js";
import type { Logger } from "../src/log.js";

/** Minimal logger for tests. */
const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// normalize.ts contract
// ---------------------------------------------------------------------------

describe("normalize utilities", () => {
  describe("l2Normalize", () => {
    it("produces unit-length vector", () => {
      const vec = new Float32Array([3, 4]);
      l2Normalize(vec);
      const norm = Math.sqrt(vec[0]! * vec[0]! + vec[1]! * vec[1]!);
      expect(norm).toBeCloseTo(1.0, 5);
    });

    it("handles zero vector without division by zero", () => {
      const vec = new Float32Array([0, 0, 0]);
      l2Normalize(vec);
      expect(vec[0]).toBe(0);
      expect(vec[1]).toBe(0);
      expect(vec[2]).toBe(0);
    });

    it("is idempotent", () => {
      const vec = new Float32Array([1, 2, 3]);
      l2Normalize(vec);
      const before = new Float32Array(vec);
      l2Normalize(vec);
      for (let i = 0; i < vec.length; i++) {
        expect(vec[i]).toBeCloseTo(before[i]!, 5);
      }
    });
  });

  describe("cosine", () => {
    it("returns 1.0 for identical vectors", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      expect(cosine(a, b)).toBeCloseTo(1.0, 5);
    });

    it("returns 0.0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([0, 1]);
      expect(cosine(a, b)).toBeCloseTo(0.0, 5);
    });

    it("returns -1.0 for opposite vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([-1, 0]);
      expect(cosine(a, b)).toBeCloseTo(-1.0, 5);
    });

    it("throws on dimension mismatch", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([1, 0, 0]);
      expect(() => cosine(a, b)).toThrow("dimension mismatch");
    });

    it("returns 0.0 for zero vectors", () => {
      const a = new Float32Array([0, 0]);
      const b = new Float32Array([0, 0]);
      expect(cosine(a, b)).toBe(0);
    });
  });

  describe("encodeFloat32 / decodeFloat32", () => {
    it("round-trips correctly", () => {
      const original = new Float32Array([1.5, -2.25, 3.125, 0]);
      const buf = encodeFloat32(original);
      const decoded = decodeFloat32(buf);
      expect(decoded.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBeCloseTo(original[i]!, 5);
      }
    });

    it("throws on buffer too short for header", () => {
      const buf = Buffer.alloc(2);
      expect(() => decodeFloat32(buf)).toThrow("buffer too short");
    });

    it("throws on buffer too short for data", () => {
      // Header says 10 floats (40 bytes) but only 8 bytes of data follow
      const buf = Buffer.alloc(12);
      buf.writeUInt32LE(10, 0);
      expect(() => decodeFloat32(buf)).toThrow("buffer too short");
    });

    it("handles empty vector", () => {
      const original = new Float32Array(0);
      const buf = encodeFloat32(original);
      const decoded = decodeFloat32(buf);
      expect(decoded.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Remote adapter contract (mock fetch)
// ---------------------------------------------------------------------------

describe("remote embedder contract", () => {
  const savedFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function mockFetchResponse(embeddings: number[][]): typeof fetch {
    return async () => {
      return new Response(JSON.stringify({ data: embeddings.map((e) => ({ embedding: e })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("returns correct dimension", () => {
    globalThis.fetch = mockFetchResponse([[1, 0, 0]]);
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );
    expect(embedder.dimension).toBe(3);
  });

  it("output is L2-normalized", async () => {
    globalThis.fetch = mockFetchResponse([[3, 4]]);
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 2 },
      silentLog,
    );
    const vec = await embedder.embed("hello");
    expect(vec).not.toBeNull();
    const norm = Math.sqrt(vec![0]! * vec![0]! + vec![1]! * vec![1]!);
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("embed(a) and embed([a]) produce equivalent results", async () => {
    // Mock returns normalized vectors, both should be identical
    const mockEmbedding = [0.6, 0.8];
    globalThis.fetch = mockFetchResponse([mockEmbedding]);
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 2 },
      silentLog,
    );
    const single = await embedder.embed("test");
    const batch = await embedder.embedBatch(["test"]);
    expect(single).not.toBeNull();
    expect(batch).toHaveLength(1);
    expect(batch[0]).not.toBeNull();
    const sim = cosine(single!, batch[0]!);
    expect(sim).toBeCloseTo(1.0, 3);
  });

  it("handles empty input without crashing", async () => {
    globalThis.fetch = mockFetchResponse([]);
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );
    const result = await embedder.embedBatch([]);
    expect(result).toHaveLength(0);
  });

  it("sends correct request body", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );
    await embedder.embed("hello world");

    expect(capturedUrl).toBe("https://api.test.com/v1/embeddings");
    expect(capturedBody).toEqual({ model: "test-model", input: ["hello world"] });
  });

  it("passes AbortSignal through to fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );

    // Use callEmbeddingsApi directly to pass signal
    const signal = AbortSignal.timeout(5000);
    await callEmbeddingsApi("https://api.test.com", "test-model", "sk-test", ["hi"], signal);

    expect(receivedSignal).toBe(signal);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );
    await expect(embedder.embed("hi")).rejects.toThrow("HTTP 401");
  });

  it("throws on network error", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const embedder = createRemoteEmbedder(
      { apiUrl: "https://api.test.com", model: "test-model", apiKey: "sk-test", dimension: 3 },
      silentLog,
    );
    await expect(embedder.embed("hi")).rejects.toThrow("network error");
  });
});

// ---------------------------------------------------------------------------
// Ollama adapter contract (mock fetch)
// ---------------------------------------------------------------------------

describe("ollama embedder contract", () => {
  const savedFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function mockOllamaResponse(embedding: number[]): typeof fetch {
    return async () => {
      return new Response(JSON.stringify({ embedding }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("returns correct dimension", () => {
    globalThis.fetch = mockOllamaResponse([1, 0, 0, 0]);
    const embedder = createOllamaEmbedder(
      { baseUrl: "http://localhost:11434", model: "nomic-embed-text", dimension: 4 },
      silentLog,
    );
    expect(embedder.dimension).toBe(4);
  });

  it("output is L2-normalized", async () => {
    globalThis.fetch = mockOllamaResponse([3, 4]);
    const embedder = createOllamaEmbedder(
      { baseUrl: "http://localhost:11434", model: "nomic-embed-text", dimension: 2 },
      silentLog,
    );
    const vec = await embedder.embed("hello");
    expect(vec).not.toBeNull();
    const norm = Math.sqrt(vec![0]! * vec![0]! + vec![1]! * vec![1]!);
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("sends correct request body (prompt field)", async () => {
    let capturedBody: unknown;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ embedding: [1, 0] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const embedder = createOllamaEmbedder(
      { baseUrl: "http://localhost:11434", model: "nomic-embed-text", dimension: 2 },
      silentLog,
    );
    await embedder.embed("test text");

    expect(capturedBody).toEqual({ model: "nomic-embed-text", prompt: "test text" });
  });

  it("passes AbortSignal through", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ embedding: [1, 0] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const signal = AbortSignal.timeout(5000);
    await callOllamaApi("http://localhost:11434", "nomic-embed-text", ["hi"], signal);
    expect(receivedSignal).toBe(signal);
  });

  it("handles empty input", async () => {
    globalThis.fetch = mockOllamaResponse([1, 0]);
    const embedder = createOllamaEmbedder(
      { baseUrl: "http://localhost:11434", model: "nomic-embed-text", dimension: 2 },
      silentLog,
    );
    const result = await embedder.embedBatch([]);
    expect(result).toHaveLength(0);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };
    const embedder = createOllamaEmbedder(
      { baseUrl: "http://localhost:11434", model: "nomic-embed-text", dimension: 2 },
      silentLog,
    );
    await expect(embedder.embed("hi")).rejects.toThrow("HTTP 404");
  });
});

// ---------------------------------------------------------------------------
// Generic contract (MockEmbedder)
// ---------------------------------------------------------------------------

/** A deterministic mock embedder for testing generic contract rules. */
function createMockEmbedder(dim: number): Embedder {
  return {
    id: `mock@${dim}`,
    dimension: dim,
    degraded: false,

    async embed(text: string): Promise<Float32Array | null> {
      const vec = new Float32Array(dim);
      // Deterministic: hash each character into the vector
      for (let i = 0; i < text.length && i < dim; i++) {
        vec[i] = (text.charCodeAt(i) % 100) / 100;
      }
      // Ensure non-zero for normalization
      if (vec.every((v) => v === 0)) vec[0] = 1;
      return l2Normalize(vec);
    },

    async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
      const results: Float32Array[] = [];
      for (const text of texts) {
        const vec = await this.embed(text);
        if (vec !== null) results.push(vec);
      }
      return results;
    },
  };
}

describe("generic embedder contract", () => {
  const embedder = createMockEmbedder(16);

  it("has correct dimension", () => {
    expect(embedder.dimension).toBe(16);
  });

  it("output is L2-normalized (norm ≈ 1.0)", async () => {
    const vec = await embedder.embed("hello world");
    expect(vec).not.toBeNull();
    const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("is deterministic (same input → same output)", async () => {
    const a = await embedder.embed("deterministic test");
    const b = await embedder.embed("deterministic test");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    for (let i = 0; i < a!.length; i++) {
      expect(a![i]).toBe(b![i]);
    }
  });

  it("embed(a) and embed([a]) produce equivalent results (cos > 0.999)", async () => {
    const single = await embedder.embed("equivalence test");
    const batch = await embedder.embedBatch(["equivalence test"]);
    expect(single).not.toBeNull();
    expect(batch).toHaveLength(1);
    expect(batch[0]).not.toBeNull();
    const sim = cosine(single!, batch[0]!);
    expect(sim).toBeGreaterThan(0.999);
  });

  it("handles empty input without crashing", async () => {
    const result = await embedder.embedBatch([]);
    expect(result).toHaveLength(0);
  });

  it("handles very long text", async () => {
    const longText = "a".repeat(100_000);
    const vec = await embedder.embed(longText);
    // Should not crash — may truncate or accept as-is
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(16);
  });
});
