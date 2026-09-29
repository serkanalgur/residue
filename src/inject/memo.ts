/**
 * Memoisation cache for context injection.
 *
 * The `context` hook runs for EVERY model call in the agent loop, including
 * tool-driven continuations. Without memoisation, each continuation would
 * trigger a redundant hybrid search + render — wasting tokens and latency.
 *
 * Key design: keyed by (sessionID, lastUserMessageID). A tool-driven
 * continuation reuses the same user message, so the same key → cache hit.
 * When the user sends a new message, the messageID changes → cache miss →
 * fresh retrieval.
 *
 * Error results are NOT cached — a transient store failure shouldn't prevent
 * a successful retry on the next model call.
 *
 * @module inject/memo
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The result stored in the memo cache (successful retrieval + render). */
export interface MemoEntry {
  /** The rendered SystemPart to push into event.system. */
  readonly systemPart: import("@opencode/ai").SystemPart;
  /** Number of facts included. */
  readonly factCount: number;
  /** Total characters in the rendered text. */
  readonly charCount: number;
  /** Timestamp when this entry was created (for LRU eviction). */
  readonly timestamp: number;
}

/** The memo interface exposed to the context hook. */
export interface Memo {
  /**
   * Get a cached result or compute and cache a new one.
   *
   * @param key - Cache key (typically `sessionID:messageID`).
   * @param compute - Function to produce the result on cache miss.
   * @returns The cached or freshly computed result, or null if compute returns null.
   */
  get(key: string, compute: () => Promise<MemoEntry | null>): Promise<MemoEntry | null>;

  /**
   * Clear all entries for a given session.
   *
   * @param sessionID - Session to clear.
   */
  clear(sessionID: string): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of sessions to keep in the memo cache. */
const MAX_SESSIONS = 50;

// ---------------------------------------------------------------------------
// createMemo
// ---------------------------------------------------------------------------

/**
 * Create a memoisation cache for context injection.
 *
 * Uses a Map keyed by `sessionID:messageID` for O(1) lookup. When the
 * cache exceeds MAX_SESSIONS distinct sessions, the oldest session's
 * entries are evicted (LRU by timestamp).
 *
 * @returns Memo instance with get and clear methods.
 */
export function createMemo(): Memo {
  const cache = new Map<string, MemoEntry>();

  // Track session access order for LRU eviction
  const sessionAccess = new Map<string, number>(); // sessionID → timestamp

  return {
    async get(
      key: string,
      compute: () => Promise<MemoEntry | null>,
    ): Promise<MemoEntry | null> {
      const existing = cache.get(key);
      if (existing !== undefined) {
        return existing;
      }

      // Extract sessionID from key (format: "sessionID:messageID")
      const sessionID = key.split(":")[0] ?? key;
      sessionAccess.set(sessionID, Date.now());

      // Evict oldest sessions if over limit
      evictOldestSessions(sessionAccess, cache, MAX_SESSIONS);

      // Compute fresh result
      const result = await compute();

      // Only cache successful results (not errors or null)
      if (result !== null) {
        cache.set(key, result);
      }

      return result;
    },

    clear(sessionID: string): void {
      // Remove all entries for this session
      const prefix = sessionID + ":";
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
          cache.delete(key);
        }
      }
      sessionAccess.delete(sessionID);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Evict oldest sessions when the cache exceeds maxSessions.
 *
 * Sessions are evicted in LRU order (oldest access timestamp first).
 */
function evictOldestSessions(
  sessionAccess: Map<string, number>,
  cache: Map<string, MemoEntry>,
  maxSessions: number,
): void {
  if (sessionAccess.size <= maxSessions) return;

  // Sort sessions by access timestamp ascending (oldest first)
  const sorted = [...sessionAccess.entries()].sort((a, b) => a[1] - b[1]);

  const toEvict = sorted.slice(0, sorted.length - maxSessions);
  for (const [sessionID] of toEvict) {
    const prefix = sessionID + ":";
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
    sessionAccess.delete(sessionID);
  }
}
