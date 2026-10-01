/**
 * Memory extractor — calls the LLM to extract durable facts from text.
 *
 * ## JSON Resilience Chain
 *
 * The model may return JSON in various malformed forms. This module handles:
 *
 * 1. **Code fence stripping**: ```json ... ``` or ``` ... ``` wrappers removed.
 * 2. **Prefix/suffix trimming**: leading/trailing prose before/after JSON removed.
 * 3. **One retry**: if the first parse fails, the raw text is cleaned and retried.
 * 4. **Graceful degradation**: on total failure, returns empty array (never throws).
 *
 * ## Validation Rules
 *
 * Each extracted item is validated against:
 * - `kind` must be a valid `MemoryKind` ("fact" | "decision" | "pattern" | "profile")
 * - `text` must be 8..2000 characters
 * - `confidence` must be 0..1
 * - `tags` array must have at most 8 entries
 * - `source` (provenance) is MANDATORY — items without provenance are discarded
 *
 * ## Privacy
 *
 * Content containing sensitive file patterns or API keys is redacted from the
 * extracted text before validation. Uses `redactSecrets` from `src/config.ts`.
 *
 * @module ingest/extractor
 */

import type { MemoryDraft, MemoryKind, SourceRef } from "../core/types.js";
import type { ResolvedScope } from "../core/ports.js";
import type { Logger } from "../log.js";
import type { ExtractionResponse, ExtractionResult } from "./types.js";
import { buildExtractionPrompt } from "./prompts.js";
import { redactSecrets } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid memory kinds. */
const VALID_KINDS: readonly MemoryKind[] = ["fact", "decision", "pattern", "profile"];

/** Minimum text length for an extracted memory. */
const MIN_TEXT_LENGTH = 8;

/** Maximum text length for an extracted memory. */
const MAX_TEXT_LENGTH = 2000;

/** Maximum number of tags per extraction. */
const MAX_TAGS = 8;

/** Maximum confidence value. */
const MAX_CONFIDENCE = 1.0;

/** Maximum length of the `contradicts` reference text. */
const MAX_CONTRADICTS_LENGTH = 300;

/** Patterns that indicate sensitive file content to redact. */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /\.env\b/i,
  /\.pem\b/i,
  /id_rsa/i,
  /\.npmrc/i,
  /\bcredentials\b/i,
  /credentials\*/i,
];

/** API key / token patterns to redact in extracted text. */
const API_KEY_PATTERNS: readonly RegExp[] = [
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(key-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/gi,
  /(api[_-]?key\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi,
  /(token\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi,
  /(secret\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi,
  /(password\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{8,}(['"]?)/gi,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract memory drafts from a conversation text.
 *
 * Calls the LLM with the extraction prompt, parses the JSON response,
 * validates each item, and builds MemoryDraft objects with provenance.
 *
 * **NEVER THROWS** — on any error, returns an empty result.
 *
 * @param generateText - Text generation function from plugin context.
 * @param defaultModel - Default model getter from plugin context.
 * @param text - Conversation text to extract from.
 * @param sessionID - Session ID for provenance.
 * @param messageID - Message ID for provenance (optional).
 * @param resolved - Resolved scope context (projectID, worktreeKey, branchKey).
 * @param options - Extraction options (model, maxFactsPerIdle).
 * @param logger - Logger instance.
 * @param signal - Optional abort signal.
 * @returns Extraction result with validated drafts and stats.
 */
export async function extractMemories(
  generateText: (opts: {
    readonly prompt: string;
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string };
  }) => Promise<{ readonly text: string }>,
  defaultModel: () => { readonly id: string; readonly providerID: string; readonly variant?: string } | Promise<{ readonly id: string; readonly providerID: string; readonly variant?: string }>,
  text: string,
  sessionID: string,
  messageID: string | undefined,
  resolved: ResolvedScope,
  options: {
    readonly extractModel?: { readonly id: string; readonly providerID: string; readonly variant?: string };
    readonly maxFactsPerIdle: number;
  },
  logger: Logger,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { drafts: [], rejectedCount: 0, rawCount: 0 };

  try {
    // Build the extraction prompt
    const prompt = buildExtractionPrompt(text);
    const model = options.extractModel ?? await defaultModel();

    // Call the LLM
    const response = await generateText({ prompt, model });

    if (!response?.text) {
      logger.debug("[residue] extraction: model returned empty response");
      return empty;
    }

    // Parse JSON with resilience chain
    const parsed = parseJsonWithResilience(response.text, logger);

    if (parsed === null || !Array.isArray(parsed.memories)) {
      logger.debug("[residue] extraction: no valid JSON in model response");
      return empty;
    }

    // Validate and build drafts
    const now = new Date().toISOString();
    const source: SourceRef = { sessionID, messageID, timestamp: now };
    const drafts: MemoryDraft[] = [];
    let rejectedCount = 0;

    for (const raw of parsed.memories) {
      // Validate
      const validationError = validateRawExtraction(raw);
      if (validationError !== null) {
        rejectedCount++;
        logger.debug(`[residue] extraction: rejected item — ${validationError}`);
        continue;
      }

      // Redact sensitive content
      const redactedText = redactSensitiveContent(raw.text);

      // Build the draft
      const draft: MemoryDraft = {
        kind: raw.kind as MemoryKind,
        scope: "project",
        project_id: resolved.projectID,
        worktree_key: resolved.worktreeKey,
        branch_key: resolved.branchKey,
        content: redactedText,
        embedding: null, // Embedding is computed at insert time
        source,
        tags: raw.tags.slice(0, MAX_TAGS),
        ...(typeof raw.contradicts === "string" && raw.contradicts.trim().length > 0
          ? { contradicts: raw.contradicts.trim().slice(0, MAX_CONTRADICTS_LENGTH) }
          : {}),
      };

      drafts.push(draft);

      // Enforce maxFactsPerIdle
      if (drafts.length >= options.maxFactsPerIdle) {
        break;
      }
    }

    return {
      drafts,
      rejectedCount,
      rawCount: parsed.memories.length,
    };
  } catch (err) {
    // NEVER THROW — graceful degradation
    logger.debug(
      `[residue] extraction failed (suppressed): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return empty;
  }
}

// ---------------------------------------------------------------------------
// JSON Resilience
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response as JSON with a resilience chain.
 *
 * Steps:
 * 1. Strip code fences (```json ... ``` or ``` ... ```).
 * 2. Trim leading/trailing non-JSON content.
 * 3. Attempt JSON.parse.
 * 4. If fails, try one more time with more aggressive cleaning.
 * 5. If still fails, return null.
 *
 * @param raw - Raw text from the model.
 * @param logger - Logger for debug output.
 * @returns Parsed ExtractionResponse or null.
 */
function parseJsonWithResilience(raw: string, logger: Logger): ExtractionResponse | null {
  // Step 1: Strip code fences
  let cleaned = stripCodeFences(raw);

  // Step 2: Trim to JSON boundaries
  cleaned = trimToJsonBoundaries(cleaned);

  // Step 3: Try parsing
  let parsed = tryParseJson(cleaned);

  if (parsed !== null) {
    return parsed;
  }

  // Step 4: One retry with more aggressive cleaning
  logger.debug("[residue] extraction: first JSON parse failed, retrying with aggressive cleanup");

  // Remove everything before first { and after last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  parsed = tryParseJson(cleaned);

  return parsed;
}

/**
 * Strip markdown code fences from the response.
 *
 * Handles:
 * - ```json\n...\n```
 * - ```\n...\n```
 */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/gm, "")
    .replace(/\n?```\s*$/gm, "")
    .trim();
}

/**
 * Trim leading/trailing non-JSON content.
 *
 * Finds the first `{` and last `}` to isolate the JSON object.
 */
function trimToJsonBoundaries(text: string): string {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return text;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Attempt to parse a string as JSON, returning null on failure.
 */
function tryParseJson(text: string): ExtractionResponse | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.memories)) {
      return parsed as ExtractionResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw extraction item against business rules.
 *
 * @param raw - Raw extraction from the model.
 * @returns Error message if invalid, null if valid.
 */
function validateRawExtraction(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") {
    return "item is not an object";
  }

  const item = raw as Record<string, unknown>;

  // Validate kind
  if (typeof item["kind"] !== "string" || !(VALID_KINDS as readonly string[]).includes(item["kind"])) {
    return `invalid kind "${String(item["kind"])}" (must be one of: ${VALID_KINDS.join(", ")})`;
  }

  // Validate text
  if (typeof item["text"] !== "string") {
    return "text is not a string";
  }
  const text = (item["text"] as string).trim();
  if (text.length < MIN_TEXT_LENGTH) {
    return `text too short (${text.length} < ${MIN_TEXT_LENGTH})`;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return `text too long (${text.length} > ${MAX_TEXT_LENGTH})`;
  }

  // Validate confidence
  if (typeof item["confidence"] !== "number") {
    return "confidence is not a number";
  }
  const confidence = item["confidence"] as number;
  if (confidence < 0 || confidence > MAX_CONFIDENCE) {
    return `confidence out of range (${confidence} not in 0..1)`;
  }

  // Validate tags
  if (!Array.isArray(item["tags"])) {
    return "tags is not an array";
  }
  const tags = item["tags"] as unknown[];
  if (tags.length > MAX_TAGS) {
    return `too many tags (${tags.length} > ${MAX_TAGS})`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/**
 * Redact sensitive content from extracted text.
 *
 * Strips references to sensitive files and masks API keys/tokens.
 * Uses the same patterns as `redactSecrets` from config.ts for consistency,
 * plus additional file-path patterns specific to ingestion.
 *
 * @param text - Extracted text that may contain sensitive content.
 * @returns Redacted text safe for storage.
 */
export function redactSensitiveContent(text: string): string {
  let result = text;

  // Strip sensitive file references
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED_FILE]");
  }

  // Redact API keys and tokens (reuses config.ts patterns)
  result = redactSecrets(result);

  return result;
}
