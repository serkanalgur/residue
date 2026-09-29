/**
 * Vector normalization, similarity, and serialization utilities.
 *
 * All functions are pure and operate on Float32Array vectors.
 *
 * @module embed/normalize
 */

/**
 * L2-normalize a vector in-place and return it.
 *
 * If the vector has zero magnitude, returns the original vector unchanged
 * (avoids division by zero).
 *
 * @param vec - Input vector to normalize.
 * @returns The same vector reference, normalized to unit length.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sumSq += v * v;
  }
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) {
    vec[i]! *= inv;
  }
  return vec;
}

/**
 * Compute cosine similarity between two vectors.
 *
 * Both vectors should be the same dimension. If either has zero magnitude,
 * returns 0.0.
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Similarity in range [-1.0, 1.0]. For L2-normalized vectors this equals dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `[residue] cosine: dimension mismatch — a has ${a.length}, b has ${b.length}`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Encode a Float32Array into a Node.js Buffer for storage.
 *
 * Layout: 4-byte little-endian uint32 length prefix, then `length * 4` bytes
 * of IEEE 754 float32 data.
 *
 * @param arr - Float32Array to encode.
 * @returns Buffer containing the serialized vector.
 */
export function encodeFloat32(arr: Float32Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(arr.length, 0);
  return Buffer.concat([header, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)]);
}

/**
 * Decode a Buffer back into a Float32Array.
 *
 * Expects the same layout as {@link encodeFloat32}: 4-byte length prefix
 * followed by float32 data.
 *
 * @param buf - Buffer to decode.
 * @returns Reconstructed Float32Array.
 * @throws If the buffer is too short or the length prefix is inconsistent.
 */
export function decodeFloat32(buf: Buffer): Float32Array {
  if (buf.length < 4) {
    throw new Error("[residue] decodeFloat32: buffer too short (need at least 4 bytes)");
  }
  const length = buf.readUInt32LE(0);
  const expectedBytes = 4 + length * 4;
  if (buf.length < expectedBytes) {
    throw new Error(
      `[residue] decodeFloat32: buffer too short — expected ${expectedBytes} bytes for length ${length}, got ${buf.length}`,
    );
  }
  // Create a new ArrayBuffer from the float data portion
  const dataBytes = buf.subarray(4, expectedBytes);
  const ab = new ArrayBuffer(dataBytes.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < dataBytes.length; i++) {
    view[i] = dataBytes[i]!;
  }
  return new Float32Array(ab);
}
