/**
 * Prompt buffer — accumulates USER prompts for optional extraction.
 *
 * Distinct from `TurnBuffer` (buffer.ts), which captures ASSISTANT text
 * deltas. Keeping them separate matters: the two streams have different
 * semantics, different retention needs, and different privacy expectations,
 * so mixing them would make it impossible to reason about (or disable) one
 * without the other.
 *
 * ## Why this exists
 *
 * Until now Residue only ever extracted from assistant output
 * (`session.text.delta`), so it remembered what the model said rather than
 * what the user asked for. User prompts arrive on a different event:
 * `session.inbox.enqueued`, where `item.type === "user"` carries the prompt
 * text in `item.payload.text`.
 *
 * ## Design
 *
 * Mirrors TurnBuffer's shape (per-session isolation, content-hash dedup,
 * bounded by count and characters) so the two are interchangeable at the call
 * site, plus one addition: a cheap `isTrivial` pre-filter. Prompt text is far
 * more repetitive than assistant prose — acknowledgements, slash commands and
 * single tokens dominate — and every buffered prompt potentially costs an LLM
 * extraction call. Filtering at capture time avoids the cost entirely rather
 * than paying to extract and then discarding.
 *
 * @module ingest/prompt-buffer
 */

import { contentHash } from "../util/hash.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single captured user prompt. */
interface PromptEntry {
  /** The prompt text. */
  readonly text: string;
  /** Message/inbox ID for provenance. */
  readonly messageID: string | undefined;
  /** Content hash for deduplication. */
  readonly hash: string;
  /** Epoch ms when captured. */
  readonly timestamp: number;
  /** How the prompt was delivered ("steer" | "queue"). */
  readonly delivery: string | undefined;
}

/** Per-session prompt state. */
interface SessionPrompts {
  entries: PromptEntry[];
  totalChars: number;
  hashes: Set<string>;
}

/** Configuration for the prompt buffer. */
export interface PromptBufferConfig {
  /** Maximum prompts retained per session. */
  readonly capacity: number;
  /** Maximum total characters retained per session. */
  readonly maxChars: number;
  /** Skip prompts that are pure acknowledgements / commands / single tokens. */
  readonly filterTrivial: boolean;
}

/** Default prompt buffer configuration. */
export const DEFAULT_PROMPT_BUFFER_CONFIG: PromptBufferConfig = {
  capacity: 50,
  maxChars: 20_000,
  filterTrivial: true,
};

/**
 * Trivial-prompt patterns: acknowledgements, continuations, and slash commands.
 *
 * These carry no durable intent — extracting from them is pure cost. Matched
 * against the trimmed lowercased prompt.
 */
const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /^(ok|okay|k|kk|yes|yep|yeah|no|nope|nah|sure|thanks?|thank you|ty|thx|cheers|np|welcome|got it|sounds good|perfect|great|cool|nice|done|good|fine|hm+|hmm+)\b[.!]?$/i,
  /^(continue|go on|keep going|proceed|next|again|retry|do it|go ahead|carry on)\b[.!]?$/i,
  /^\/?[a-z][\w-]*$/i, // single word or slash command, e.g. "/help"
];

/**
 * Whether a prompt is too trivial to be worth extracting.
 *
 * @param text - Raw prompt text.
 * @returns True when the prompt should be skipped.
 */
export function isTrivialPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Very short prompts are almost never durable intent.
  if (trimmed.length <= 3) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(trimmed));
}

/** The prompt buffer interface exposed to consumers. */
export interface PromptBuffer {
  /**
   * Capture a user prompt.
   *
   * @param sessionID - Session identifier.
   * @param text - Prompt text.
   * @param messageID - Provenance ID (inbox/message ID).
   * @param delivery - Delivery mode, if known.
   * @returns True when the prompt was retained, false when filtered or deduplicated.
   */
  push(
    sessionID: string,
    text: string,
    messageID?: string,
    delivery?: string,
  ): boolean;

  /**
   * Take and clear all buffered prompts for a session.
   *
   * @param sessionID - Session identifier.
   * @returns The buffered prompt text, or null when empty.
   */
  take(sessionID: string): string | null;

  /** Number of buffered prompts for a session. */
  size(sessionID: string): number;

  /** Clear all buffered prompts for a session. */
  clear(sessionID: string): void;
}

// ---------------------------------------------------------------------------
// createPromptBuffer
// ---------------------------------------------------------------------------

/**
 * Create a prompt buffer instance.
 *
 * @param config - Buffer configuration.
 * @param now - Injectable clock for testing (defaults to Date.now).
 * @returns PromptBuffer instance.
 */
export function createPromptBuffer(
  config: PromptBufferConfig = DEFAULT_PROMPT_BUFFER_CONFIG,
  now: () => number = Date.now,
): PromptBuffer {
  const sessions = new Map<string, SessionPrompts>();

  function getOrCreate(sessionID: string): SessionPrompts {
    let buf = sessions.get(sessionID);
    if (buf === undefined) {
      buf = { entries: [], totalChars: 0, hashes: new Set() };
      sessions.set(sessionID, buf);
    }
    return buf;
  }

  return {
    push(sessionID: string, text: string, messageID?: string, delivery?: string): boolean {
      if (typeof text !== "string" || text.trim().length === 0) return false;

      // Cheap pre-filter — avoids paying for an LLM call on noise.
      if (config.filterTrivial && isTrivialPrompt(text)) return false;

      const buf = getOrCreate(sessionID);
      const hash = contentHash(text);
      if (buf.hashes.has(hash)) return false;

      const entry: PromptEntry = {
        text: text.trim(),
        messageID,
        hash,
        timestamp: now(),
        delivery,
      };

      while (buf.entries.length >= config.capacity) {
        const evicted = buf.entries.shift();
        if (evicted !== undefined) {
          buf.totalChars -= evicted.text.length;
          buf.hashes.delete(evicted.hash);
        }
      }

      while (buf.totalChars + entry.text.length > config.maxChars && buf.entries.length > 0) {
        const evicted = buf.entries.shift();
        if (evicted !== undefined) {
          buf.totalChars -= evicted.text.length;
          buf.hashes.delete(evicted.hash);
        }
      }

      buf.entries.push(entry);
      buf.totalChars += entry.text.length;
      buf.hashes.add(hash);
      return true;
    },

    take(sessionID: string): string | null {
      const buf = sessions.get(sessionID);
      if (buf === undefined || buf.entries.length === 0) return null;

      // Label each prompt so the extractor can tell user intent from the
      // surrounding assistant chatter it may be batched with.
      const combined = buf.entries
        .map((e) => `<user_prompt>${e.text}</user_prompt>`)
        .join("\n\n");

      buf.entries = [];
      buf.totalChars = 0;
      buf.hashes.clear();

      return combined;
    },

    size(sessionID: string): number {
      return sessions.get(sessionID)?.entries.length ?? 0;
    },

    clear(sessionID: string): void {
      sessions.delete(sessionID);
    },
  };
}
