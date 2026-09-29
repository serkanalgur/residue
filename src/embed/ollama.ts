/**
 * Ollama local embedding adapter.
 *
 * Calls the Ollama HTTP API at `http://127.0.0.1:11434/api/embeddings`
 * using `nomic-embed-text` by default. All network calls are abortable.
 *
 * @module embed/ollama
 */

import type { Embedder } from "../core/ports.js";
import type { Logger } from "../log.js";
import { l2Normalize } from "./normalize.js";

/** Configuration for the Ollama embedding adapter. */
export interface OllamaEmbedderOptions {
  /** Ollama base URL (default: "http://127.0.0.1:11434"). */
  readonly baseUrl: string;
  /** Model name (default: "nomic-embed-text"). */
  readonly model: string;
  /** Expected output dimension (1024 for nomic-embed-text). */
  readonly dimension: number;
}

/**
 * Response shape from the Ollama `/api/embeddings` endpoint.
 */
interface OllamaEmbeddingResponse {
  readonly embedding: readonly number[];
}

/**
 * Create an Ollama embedding adapter.
 *
 * @param opts - Ollama adapter configuration.
 * @param log - Logger instance for error reporting.
 * @returns An Embedder implementation backed by Ollama.
 */
export function createOllamaEmbedder(
  opts: OllamaEmbedderOptions,
  log: Logger,
): Embedder {
  const { baseUrl, model, dimension } = opts;
  const id = `${model}@${dimension}`;

  return {
    id,
    dimension,
    degraded: false,

    async embed(text: string): Promise<Float32Array | null> {
      const results = await callOllamaApi(baseUrl, model, [text], undefined);
      if (results.length === 0) return null;
      return results[0]!;
    },

    async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
      if (texts.length === 0) return [];
      return await callOllamaApi(baseUrl, model, texts, undefined);
    },
  };
}

/**
 * Probe whether Ollama is reachable and the model is available.
 *
 * @param baseUrl - Ollama base URL.
 * @param signal - Optional abort signal.
 * @returns true if Ollama responds successfully.
 */
export async function probeOllama(
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  try {
    const response = await fetch(url, { method: "GET", signal });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Call the Ollama embeddings API for an array of texts.
 *
 * @param baseUrl - Ollama base URL.
 * @param model - Model name.
 * @param texts - Texts to embed.
 * @param signal - Optional abort signal.
 * @returns Array of Float32Array vectors (null for failed items).
 */
export async function callOllamaApi(
  baseUrl: string,
  model: string,
  texts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<(Float32Array | null)[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/embeddings`;

  // Ollama doesn't support batch natively — call once per text
  const results: (Float32Array | null)[] = [];
  for (const text of texts) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[residue] ollama embed: network error — ${msg}`);
    }

    if (!response.ok) {
      const status = response.status;
      let body = "";
      try {
        body = await response.text();
      } catch {
        // body read failure is non-fatal
      }
      throw new Error(
        `[residue] ollama embed: HTTP ${status} — ${body.slice(0, 200)}`,
      );
    }

    let json: OllamaEmbeddingResponse;
    try {
      json = (await response.json()) as OllamaEmbeddingResponse;
    } catch {
      throw new Error("[residue] ollama embed: failed to parse JSON response");
    }

    if (!json.embedding || !Array.isArray(json.embedding)) {
      results.push(null);
      continue;
    }

    const vec = new Float32Array(json.embedding);
    results.push(l2Normalize(vec));
  }

  return results;
}
