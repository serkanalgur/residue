/**
 * OpenAI-compatible remote embedding adapter.
 *
 * Calls a `/v1/embeddings` endpoint (OpenAI, Azure, or compatible)
 * using `text-embedding-3-small` by default. All network calls are
 * abortable via the `signal` parameter.
 *
 * API key is sourced exclusively from `process.env[embeddingKeyEnv]`.
 * No credentials are written to `ctx.storage` or any file.
 *
 * @module embed/remote
 */

import type { Embedder } from "../core/ports.js";
import type { Logger } from "../log.js";
import { l2Normalize } from "./normalize.js";

/** Configuration for the remote embedding adapter. */
export interface RemoteEmbedderOptions {
  /** Base URL for the embeddings API (e.g., "https://api.openai.com"). */
  readonly apiUrl: string;
  /** Model identifier (e.g., "text-embedding-3-small"). */
  readonly model: string;
  /** API key (read from env by caller, never written to disk). */
  readonly apiKey: string;
  /** Expected output dimension. */
  readonly dimension: number;
}

/**
 * Create a remote embedding adapter.
 *
 * @param opts - Remote adapter configuration.
 * @param log - Logger instance for error reporting.
 * @returns An Embedder implementation backed by the remote API.
 */
export function createRemoteEmbedder(
  opts: RemoteEmbedderOptions,
  log: Logger,
): Embedder {
  const { apiUrl, model, apiKey, dimension } = opts;
  const id = `${model}@${dimension}`;

  return {
    id,
    dimension,
    degraded: false,

    async embed(text: string): Promise<Float32Array | null> {
      const results = await callEmbeddingsApi(apiUrl, model, apiKey, [text], undefined);
      if (results.length === 0) return null;
      return results[0]!;
    },

    async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
      if (texts.length === 0) return [];
      return await callEmbeddingsApi(apiUrl, model, apiKey, texts, undefined);
    },
  };
}

/**
 * Response shape from the OpenAI-compatible `/v1/embeddings` endpoint.
 */
interface EmbeddingsApiResponse {
  readonly data: ReadonlyArray<{ readonly embedding: readonly number[] }>;
}

/**
 * Call the embeddings API and return parsed vectors.
 *
 * @param apiUrl - Base URL of the API.
 * @param model - Model identifier.
 * @param apiKey - API key for authorization.
 * @param texts - Array of text strings to embed.
 * @param signal - Optional abort signal.
 * @returns Array of Float32Array vectors (null for failed items).
 */
export async function callEmbeddingsApi(
  apiUrl: string,
  model: string,
  apiKey: string,
  texts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<(Float32Array | null)[]> {
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[residue] remote embed: network error — ${msg}`);
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
      `[residue] remote embed: HTTP ${status} — ${body.slice(0, 200)}`,
    );
  }

  let json: EmbeddingsApiResponse;
  try {
    json = (await response.json()) as EmbeddingsApiResponse;
  } catch {
    throw new Error("[residue] remote embed: failed to parse JSON response");
  }

  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("[residue] remote embed: response missing 'data' array");
  }

  // Map response vectors in order, L2-normalize each
  return texts.map((_text, i) => {
    const item = json.data[i];
    if (!item || !item.embedding || !Array.isArray(item.embedding)) {
      return null;
    }
    const vec = new Float32Array(item.embedding);
    return l2Normalize(vec);
  });
}
