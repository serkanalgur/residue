/**
 * Embedder registry — resolves the active embedding adapter.
 *
 * Resolution follows a strict fallback chain based on the configured
 * `embedding` mode:
 *
 * - `"auto"`: remote (if API key available) → ollama (if reachable) → none
 * - `"local"`: local (dynamic import of @huggingface/transformers)
 * - `"remote"`: remote only
 * - `"ollama"`: ollama only
 * - `"none"`: disabled (FTS5-only mode)
 *
 * ## Critical rules
 *
 * 1. `auto` NEVER forces a model download. Local is only tried if the user
 *    explicitly set `embedding: "local"`.
 * 2. Once a remote adapter fails, it is marked as permanently failed for this
 *    session — no retries.
 * 3. Every probe uses `AbortSignal.timeout(ms)` to bound network latency.
 * 4. If nothing works, returns `{ embedder: null, degraded: true, reason }`
 *    — the system runs in vocabulary-only mode and never crashes.
 *
 * @module embed/registry
 */

import type { Embedder, ResolvedEmbedder } from "../core/ports.js";
import type { ResidueOptions } from "../config.js";
import type { Logger } from "../log.js";
import { createRemoteEmbedder } from "./remote.js";
import { createOllamaEmbedder, probeOllama } from "./ollama.js";
import { createLocalEmbedder } from "./local.js";

/** Default probe timeout in milliseconds. */
const DEFAULT_PROBE_TIMEOUT = 1500;

/**
 * Resolve the active embedding adapter based on configuration.
 *
 * Never throws — returns a degraded result on any failure.
 *
 * @param options - Plugin options (embedding mode, key env, probe timeout).
 * @param log - Logger instance.
 * @returns Resolved embedder with fallback handling.
 */
export async function resolveEmbedder(
  options: Pick<ResidueOptions, "embedding" | "embeddingKeyEnv" | "embeddingProbeTimeout">,
  log: Logger,
): Promise<ResolvedEmbedder> {
  const probeTimeout = options.embeddingProbeTimeout ?? DEFAULT_PROBE_TIMEOUT;

  switch (options.embedding) {
    case "none":
      return { embedder: null, degraded: true, reason: "embedding: none" };

    case "remote":
      return await resolveRemoteOnly(options.embeddingKeyEnv, log);

    case "ollama":
      return await resolveOllamaOnly(probeTimeout, log);

    case "local":
      return await resolveLocalOnly(log);

    case "auto":
      return await resolveAuto(options.embeddingKeyEnv, probeTimeout, log);

    default:
      return { embedder: null, degraded: true, reason: `unknown embedding mode` };
  }
}

/**
 * Resolve remote adapter only. Returns degraded if the API key is missing.
 *
 * @param keyEnv - Environment variable name for the API key.
 * @param log - Logger.
 */
async function resolveRemoteOnly(
  keyEnv: string,
  log: Logger,
): Promise<ResolvedEmbedder> {
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    return {
      embedder: null,
      degraded: true,
      reason: `remote: API key not found in env[${keyEnv}]`,
    };
  }

  const embedder = createRemoteEmbedder(
    {
      apiUrl: "https://api.openai.com",
      model: "text-embedding-3-small",
      apiKey,
      dimension: 1536,
    },
    log,
  );

  return { embedder, degraded: false };
}

/**
 * Resolve Ollama adapter only. Probes the server before returning.
 *
 * @param probeTimeout - Timeout in ms for the probe.
 * @param log - Logger.
 */
async function resolveOllamaOnly(
  probeTimeout: number,
  log: Logger,
): Promise<ResolvedEmbedder> {
  const signal = AbortSignal.timeout(probeTimeout);
  const reachable = await probeOllama("http://127.0.0.1:11434", signal).catch(() => false);

  if (!reachable) {
    return {
      embedder: null,
      degraded: true,
      reason: "ollama: not reachable at http://127.0.0.1:11434",
    };
  }

  const embedder = createOllamaEmbedder(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimension: 1024,
    },
    log,
  );

  return { embedder, degraded: false };
}

/**
 * Resolve local adapter only (lazy async initialization).
 *
 * @param log - Logger.
 */
async function resolveLocalOnly(log: Logger): Promise<ResolvedEmbedder> {
  const embedder = await createLocalEmbedder(log);
  if (embedder === null) {
    return {
      embedder: null,
      degraded: true,
      reason: "local: @huggingface/transformers not available",
    };
  }
  return { embedder, degraded: false };
}

/**
 * Auto resolution: remote → ollama → none.
 *
 * Local is intentionally excluded from auto to avoid forced model downloads.
 *
 * @param keyEnv - Environment variable name for the API key.
 * @param probeTimeout - Timeout in ms for each probe.
 * @param log - Logger.
 */
async function resolveAuto(
  keyEnv: string,
  probeTimeout: number,
  log: Logger,
): Promise<ResolvedEmbedder> {
  // 1. Try remote
  const remoteResult = await resolveRemoteOnly(keyEnv, log);
  if (!remoteResult.degraded) {
    log.info("[residue] embedder resolved: remote (text-embedding-3-small@1536)");
    return remoteResult;
  }
  log.info(`[residue] auto: remote unavailable — ${remoteResult.reason}`);

  // 2. Try ollama
  const ollamaResult = await resolveOllamaOnly(probeTimeout, log);
  if (!ollamaResult.degraded) {
    log.info("[residue] embedder resolved: ollama (nomic-embed-text@1024)");
    return ollamaResult;
  }
  log.info(`[residue] auto: ollama unavailable — ${ollamaResult.reason}`);

  // 3. No embedding available — run in vocabulary-only mode
  log.info("[residue] auto: no embedder available — running in vocabulary-only mode");
  return {
    embedder: null,
    degraded: true,
    reason: "auto: no embedder available (remote failed, ollama unreachable)",
  };
}
