/**
 * Ingestion module — public API surface.
 *
 * Re-exports the buffer, extractor, and subscription components.
 * The `registerIngestion` function is the single entry point called
 * from the plugin's setup to wire the ingestion pipeline.
 *
 * @module ingest
 */

export { createTurnBuffer, DEFAULT_BUFFER_CONFIG } from "./buffer.js";
export type { TurnBuffer, TurnBufferConfig } from "./buffer.js";

export { extractMemories, redactSensitiveContent } from "./extractor.js";

export {
  createPromptBuffer,
  isTrivialPrompt,
  DEFAULT_PROMPT_BUFFER_CONFIG,
} from "./prompt-buffer.js";
export type { PromptBuffer, PromptBufferConfig } from "./prompt-buffer.js";

export { registerIngestion } from "./subscribe.js";
export type { IngestionCtx, SubscribeDeps } from "./subscribe.js";

export { buildExtractionPrompt, buildExtractionPromptWithPlaceholder, TRANSCRIPT_PLACEHOLDER } from "./prompts.js";

export type {
  RawExtraction,
  ExtractionResponse,
  ExtractionResult,
  IngestOptions,
  IngestDeps,
  DEFAULT_INGEST_OPTIONS,
} from "./types.js";
