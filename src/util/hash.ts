/**
 * Cryptographic hashing utilities using Node.js built-in crypto.
 *
 * @module util/hash
 */

import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of a string, returned as lowercase hex.
 *
 * @param str - Input string to hash.
 * @returns 64-character lowercase hex digest.
 */
export function sha256(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/**
 * Compute a shortened SHA-256 hash (truncated for display).
 *
 * @param str - Input string to hash.
 * @param n - Number of hex characters to return (default: 12).
 * @returns Truncated hex digest.
 */
export function shortHash(str: string, n: number = 12): string {
  return sha256(str).slice(0, n);
}

/**
 * Compute a content hash for deduplication purposes.
 * Uses SHA-256 but normalizes whitespace before hashing.
 *
 * @param content - Content string to hash.
 * @returns 64-character lowercase hex digest.
 */
export function contentHash(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return sha256(normalized);
}
