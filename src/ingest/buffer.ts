/**
 * Session turn buffer — accumulates conversation text for extraction.
 *
 * Each session gets a ring buffer that:
 * - Stores recent messages (bounded by capacity and character limit).
 * - Deduplicates via content hash (same text won't be stored twice).
 * - Debounces rapid turns (minIntervalMs between takes).
 * - Provides a `take` method that clears the buffer for a session.
 *
 * ## Design
 *
 * The buffer is per-session: messages from different sessions are completely
 * isolated. The ring buffer evicts the oldest messages when capacity is reached.
 * Content hash deduplication prevents the same message from being counted
 * multiple times (e.g., on retries or compacted sessions).
 *
 * @module ingest/buffer
 */

import { contentHash } from "../util/hash.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single buffered turn entry. */
interface BufferEntry {
  /** Text content of the turn. */
  readonly text: string;
  /** Message ID for provenance. */
  readonly messageID: string | undefined;
  /** Content hash for deduplication. */
  readonly hash: string;
  /** Timestamp when this entry was added (for debounce). */
  readonly timestamp: number;
}

/** Per-session buffer state. */
interface SessionBuffer {
  /** Ring buffer of entries (oldest first). */
  entries: BufferEntry[];
  /** Total character count across all entries. */
  totalChars: number;
  /** Set of content hashes for O(1) dedup check. */
  hashes: Set<string>;
  /** Timestamp of the last `take` operation (for debounce). */
  lastTakeTimestamp: number;
}

/** The buffer interface exposed to consumers. */
export interface TurnBuffer {
  /**
   * Add a message to the session's buffer.
   *
   * @param sessionID - Session identifier.
   * @param messageID - Message identifier (for provenance).
   * @param text - Message text content.
   */
  push(sessionID: string, messageID: string | undefined, text: string): void;

  /**
   * Take all buffered text for a session and clear the buffer.
   *
   * Returns null if:
   * - Buffer is empty.
   * - minIntervalMs has not elapsed since the last take.
   *
   * @param sessionID - Session identifier.
   * @returns Combined text from all buffered turns, or null.
   */
  take(sessionID: string): string | null;

  /**
   * Get the number of entries in a session's buffer.
   *
   * @param sessionID - Session identifier.
   * @returns Number of buffered entries.
   */
  size(sessionID: string): number;

  /**
   * Clear all buffered content for a session.
   *
   * @param sessionID - Session identifier.
   */
  clear(sessionID: string): void;
}

/** Configuration for the turn buffer. */
export interface TurnBufferConfig {
  /** Maximum number of messages per session ring buffer. */
  readonly capacity: number;
  /** Maximum total characters per session. */
  readonly maxChars: number;
  /** Minimum interval between take operations (ms). */
  readonly minIntervalMs: number;
}

/** Default buffer configuration. */
export const DEFAULT_BUFFER_CONFIG: TurnBufferConfig = {
  capacity: 200,
  maxChars: 100_000,
  minIntervalMs: 20_000,
};

// ---------------------------------------------------------------------------
// createTurnBuffer
// ---------------------------------------------------------------------------

/**
 * Create a turn buffer instance.
 *
 * @param config - Buffer configuration (capacity, maxChars, minIntervalMs).
 * @param now - Injectable clock for testing (defaults to Date.now).
 * @returns TurnBuffer instance.
 */
export function createTurnBuffer(
  config: TurnBufferConfig = DEFAULT_BUFFER_CONFIG,
  now: () => number = Date.now,
): TurnBuffer {
  const sessions = new Map<string, SessionBuffer>();

  function getOrCreate(sessionID: string): SessionBuffer {
    let buf = sessions.get(sessionID);
    if (buf === undefined) {
      buf = {
        entries: [],
        totalChars: 0,
        hashes: new Set(),
        lastTakeTimestamp: 0,
      };
      sessions.set(sessionID, buf);
    }
    return buf;
  }

  return {
    push(sessionID: string, messageID: string | undefined, text: string): void {
      if (typeof text !== "string" || text.trim().length === 0) return;

      const buf = getOrCreate(sessionID);
      const hash = contentHash(text);

      // Content hash deduplication: skip if already present
      if (buf.hashes.has(hash)) return;

      const entry: BufferEntry = {
        text,
        messageID,
        hash,
        timestamp: now(),
      };

      // Evict oldest if at capacity
      while (buf.entries.length >= config.capacity) {
        const evicted = buf.entries.shift();
        if (evicted !== undefined) {
          buf.totalChars -= evicted.text.length;
          buf.hashes.delete(evicted.hash);
        }
      }

      // Evict if over character limit (remove oldest until under limit)
      while (buf.totalChars + text.length > config.maxChars && buf.entries.length > 0) {
        const evicted = buf.entries.shift();
        if (evicted !== undefined) {
          buf.totalChars -= evicted.text.length;
          buf.hashes.delete(evicted.hash);
        }
      }

      buf.entries.push(entry);
      buf.totalChars += text.length;
      buf.hashes.add(hash);
    },

    take(sessionID: string): string | null {
      const buf = sessions.get(sessionID);
      if (buf === undefined || buf.entries.length === 0) return null;

      const currentTime = now();

      // Debounce: check if enough time has elapsed since last take
      if (currentTime - buf.lastTakeTimestamp < config.minIntervalMs) {
        return null;
      }

      // Combine all buffered text
      const combined = buf.entries.map((e) => e.text).join("\n\n");

      // Clear the buffer
      buf.entries = [];
      buf.totalChars = 0;
      buf.hashes.clear();
      buf.lastTakeTimestamp = currentTime;

      return combined;
    },

    size(sessionID: string): number {
      const buf = sessions.get(sessionID);
      return buf?.entries.length ?? 0;
    },

    clear(sessionID: string): void {
      const buf = sessions.get(sessionID);
      if (buf !== undefined) {
        buf.entries = [];
        buf.totalChars = 0;
        buf.hashes.clear();
        buf.lastTakeTimestamp = 0;
      }
    },
  };
}
