/**
 * ID generation utilities for memory records.
 *
 * Produces ULID-like, time-sortable identifiers with cryptographic randomness.
 *
 * @module util/ids
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a new unique ID.
 *
 * Format: 26 characters — 10-char Crockford Base32 timestamp + 16-char random suffix.
 * Timestamps are millisecond-precision, making IDs naturally time-sortable.
 *
 * @returns A ULID-like identifier string.
 */
export function newId(): string {
  const now = Date.now();
  const timePart = encodeTime(now);
  const randomPart = encodeRandom(16);
  return timePart + randomPart;
}

/** Crockford Base32 alphabet (excludes I, L, O, U). */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a timestamp as 10-character Crockford Base32. */
export function encodeTime(ms: number): string {
  let result = "";
  let remaining = ms;
  for (let i = 9; i >= 0; i--) {
    const index = remaining % 32;
    result = BASE32[index]! + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

/** Encode random bytes as Crockford Base32 string. */
function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE32[bytes[i]! & 31]!;
  }
  return result;
}
