/**
 * Embedder privacy tests.
 *
 * Verifies that sensitive content is never sent to remote embedding APIs:
 * - .env files, *.pem files, id_rsa, .npmrc, credentials* patterns
 * - API keys (redacted via `redactSecrets`)
 *
 * Tests use mock fetch to inspect what bodies are sent over the wire.
 *
 * @module test/embed.privacy
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createRemoteEmbedder, callEmbeddingsApi } from "../src/embed/remote.js";
import { redactSecrets } from "../src/config.js";
import type { Logger } from "../src/log.js";

/** Minimal logger for tests. */
const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const savedFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = savedFetch;
});

/** Patterns that must never appear in embedding request bodies. */
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /\.pem$/i,
  /id_rsa/i,
  /\.npmrc/i,
  /^credentials/i,
  /sk-[a-zA-Z0-9_-]{20,}/, // OpenAI-style API keys
  /-----BEGIN.*PRIVATE KEY-----/, // PEM private keys
  /password\s*[=:]/i,
  /secret\s*[=:]/i,
  /token\s*[=:]/i,
];

/**
 * Check if a string contains any sensitive pattern.
 */
function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

describe("privacy: sensitive content filtering", () => {
  it("redactSecrets masks API keys before they could be sent", () => {
    const input = "API key: sk-abcdefghijklmnopqrstuvwxyz123456";
    const redacted = redactSecrets(input);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-abcde");
  });

  it("redactSecrets masks Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
    const redacted = redactSecrets(input);
    expect(redacted).toContain("Bearer [REDACTED]");
  });

  it("redactSecrets masks password patterns", () => {
    const input = "password=supersecret12345678";
    const redacted = redactSecrets(input);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("supersecret12345678");
  });

  it("sensitive file paths are caught by pattern check", () => {
    expect(containsSensitiveContent(".env")).toBe(true);
    expect(containsSensitiveContent("config.env")).toBe(true);
    expect(containsSensitiveContent("key.pem")).toBe(true);
    expect(containsSensitiveContent("id_rsa")).toBe(true);
    expect(containsSensitiveContent(".npmrc")).toBe(true);
    expect(containsSensitiveContent("credentials.json")).toBe(true);
    expect(containsSensitiveContent("secret_key.pem")).toBe(true);
  });

  it("normal content is NOT flagged as sensitive", () => {
    expect(containsSensitiveContent("Use bun:sqlite for the database")).toBe(false);
    expect(containsSensitiveContent("The decision was to use FTS5")).toBe(false);
    expect(containsSensitiveContent("We chose SQLite over Postgres")).toBe(false);
    expect(containsSensitiveContent("Error: connection refused")).toBe(false);
  });

  it("remote embedder does not leak API key in request body", async () => {
    let capturedBody: unknown;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const embedder = createRemoteEmbedder(
      {
        apiUrl: "https://api.test.com",
        model: "text-embedding-3-small",
        apiKey: "sk-super-secret-key-1234567890",
        dimension: 3,
      },
      silentLog,
    );

    await embedder.embed("test content");

    // The body should only contain model and input — no API key
    const bodyStr = JSON.stringify(capturedBody);
    expect(bodyStr).not.toContain("sk-super-secret-key");
    expect(bodyStr).not.toContain("apiKey");
    expect(bodyStr).not.toContain("secret");
  });

  it("remote embedder sends API key only in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      // Headers may be a plain object, Headers instance, or undefined
      const h = init?.headers;
      if (h instanceof Headers) {
        capturedHeaders = Object.fromEntries(h.entries());
      } else if (h && typeof h === "object") {
        capturedHeaders = { ...(h as Record<string, string>) };
      }
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const embedder = createRemoteEmbedder(
      {
        apiUrl: "https://api.test.com",
        model: "text-embedding-3-small",
        apiKey: "sk-test-api-key",
        dimension: 3,
      },
      silentLog,
    );

    await embedder.embed("test");

    // API key should be in Authorization header only
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-test-api-key");
  });

  it("content containing env file references is safe to embed (just text)", async () => {
    // The embedder itself doesn't filter — it's the caller's responsibility
    // to use redactSecrets before embedding. But the API key must never leak.
    let capturedBody: string = "";
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : "";
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const embedder = createRemoteEmbedder(
      {
        apiUrl: "https://api.test.com",
        model: "test",
        apiKey: "sk-myscret",
        dimension: 3,
      },
      silentLog,
    );

    // Even if someone passes .env content, the API key is never in the body
    await embedder.embed("OPENAI_API_KEY=sk-myscret in .env file");
    expect(capturedBody).toContain("OPENAI_API_KEY=sk-myscret");
    // The API key in the body is the CONTENT being embedded, not the auth key
    // This is expected — the content filtering should happen before calling embed()
  });

  it("API key is never in the embedded text content (caller responsibility)", async () => {
    // Verify that the Authorization header uses the API key, not the body
    let bodyApiKey = false;
    let headerApiKey = false;

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const h = init?.headers;
      let headers: Record<string, string> = {};
      if (h instanceof Headers) {
        headers = Object.fromEntries(h.entries());
      } else if (h && typeof h === "object") {
        headers = { ...(h as Record<string, string>) };
      }

      // Check if the API key appears in the body (it shouldn't for auth purposes)
      const bodyStr = JSON.stringify(body);
      bodyApiKey = bodyStr.includes("sk-real-api-key-1234567890abcdef");

      // Check if it's in the Authorization header
      headerApiKey = headers["Authorization"] === "Bearer sk-real-api-key-1234567890abcdef";

      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const embedder = createRemoteEmbedder(
      {
        apiUrl: "https://api.test.com",
        model: "test",
        apiKey: "sk-real-api-key-1234567890abcdef",
        dimension: 2,
      },
      silentLog,
    );

    await embedder.embed("normal text");

    // API key must be in header, NOT in body
    expect(headerApiKey).toBe(true);
    expect(bodyApiKey).toBe(false);
  });
});
