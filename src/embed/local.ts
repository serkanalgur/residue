/**
 * Local embedding adapter using @huggingface/transformers.
 *
 * Dynamically imports `@huggingface/transformers` at initialization time.
 * If the package is not installed, the import fails gracefully. The model
 * (`Xenova/all-MiniLM-L6-v2`) is downloaded on first use, NOT at import time.
 *
 * This adapter is opt-in: only activated when `embedding: "local"` is set
 * explicitly. The `auto` mode never triggers a model download.
 *
 * @module embed/local
 */

import type { Embedder } from "../core/ports.js";
import type { Logger } from "../log.js";
import { l2Normalize } from "./normalize.js";

/** Expected dimension for all-MiniLM-L6-v2. */
const MINILM_DIMENSION = 384;

/** The HuggingFace model identifier. */
const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Embedder ID following the convention "model@dimension". */
const LOCAL_EMBEDDER_ID = "all-MiniLM-L6-v2@384";

/**
 * Type for a HuggingFace pipeline function (the result of `pipeline()`).
 *
 * Takes text input and options, returns a tensor-like object with `data`.
 */
type HFPipeline = (
  input: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ readonly data: Float32Array }>;

/**
 * Type for the `pipeline()` factory function from @huggingface/transformers.
 *
 * Takes a task name and model identifier, returns a pipeline function.
 */
type HFPipelineFactory = (task: string, model: string) => Promise<HFPipeline>;

/**
 * Check if `@huggingface/transformers` can be imported.
 *
 * This does NOT download any models — it only verifies the package is installed.
 *
 * @returns true if the package is importable.
 */
export async function isTransformersAvailable(): Promise<boolean> {
  try {
    // @ts-expect-error — optional dynamic import of uninstalled package
    const mod: unknown = await import("@huggingface/transformers");
    if (typeof mod !== "object" || mod === null) return false;
    const m = mod as Record<string, unknown>;
    return typeof m["pipeline"] === "function";
  } catch {
    return false;
  }
}

/**
 * Create a local embedding adapter using @huggingface/transformers.
 *
 * @param log - Logger instance.
 * @returns An Embedder implementation, or null if the package is unavailable.
 */
export async function createLocalEmbedder(
  log: Logger,
): Promise<Embedder | null> {
  let pipelineFactory: HFPipelineFactory;
  try {
    // @ts-expect-error — optional dynamic import of uninstalled package
    const mod: unknown = await import("@huggingface/transformers");
    if (typeof mod !== "object" || mod === null) {
      log.warn("[residue] local embed: @huggingface/transformers module is not an object");
      return null;
    }
    const m = mod as Record<string, unknown>;
    const fn = m["pipeline"];
    if (typeof fn !== "function") {
      log.warn("[residue] local embed: @huggingface/transformers has no pipeline export");
      return null;
    }
    pipelineFactory = fn as HFPipelineFactory;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[residue] local embed: @huggingface/transformers not available — ${msg}`);
    return null;
  }

  // Lazy-initialized pipeline instance (created on first embed call)
  let pipe: HFPipeline | null = null;
  let pipeError: string | null = null;

  async function getPipeline(): Promise<HFPipeline> {
    if (pipeError !== null) {
      throw new Error(`[residue] local embed: pipeline unavailable — ${pipeError}`);
    }
    if (pipe !== null) return pipe;
    try {
      log.info("[residue] local embed: loading Xenova/all-MiniLM-L6-v2 (first use)...");
      pipe = await pipelineFactory("feature-extraction", MINILM_MODEL);
      log.info("[residue] local embed: model loaded successfully");
      return pipe;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pipeError = msg;
      log.error(`[residue] local embed: failed to load model — ${msg}`);
      throw new Error(`[residue] local embed: failed to load model — ${msg}`);
    }
  }

  /** Internal embed function shared by embed() and embedBatch(). */
  async function doEmbed(text: string): Promise<Float32Array | null> {
    try {
      const p = await getPipeline();
      const output = await p(text, { pooling: "mean", normalize: true });
      // transformers.js returns a Tensor with .data as Float32Array
      const raw = output.data;
      // Copy to avoid holding reference to tensor internals
      const vec = new Float32Array(raw);
      l2Normalize(vec);
      return vec;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[residue] local embed: failed — ${msg}`);
      return null;
    }
  }

  return {
    id: LOCAL_EMBEDDER_ID,
    dimension: MINILM_DIMENSION,
    degraded: false,

    embed: doEmbed,

    async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
      if (texts.length === 0) return [];
      // Process sequentially — transformers.js pipeline doesn't support batch well
      const results: (Float32Array | null)[] = [];
      for (const text of texts) {
        results.push(await doEmbed(text));
      }
      return results;
    },
  };
}
