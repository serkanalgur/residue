/**
 * Vector storage and similarity search for Residue's SQLite store.
 *
 * Provides float32 BLOB encoding/decoding, L2 normalization, cosine similarity,
 * and an IVF-lite index for fast approximate nearest-neighbor queries.
 *
 * The vector table name encodes the embedder identity — this module reads the
 * table name to determine which embedder produced the vectors, rather than
 * relying on hardcoded patterns.
 *
 * @module store/sqlite/vectors
 */

import type { SqliteDatabase } from "./driver.js";

// ---------------------------------------------------------------------------
// BLOB encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a Float32Array as a Buffer (BLOB) for SQLite storage.
 *
 * @param vec - Float32 vector to encode.
 * @returns Buffer containing the raw float32 bytes.
 */
export function encodeVec(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode a Buffer (BLOB) from SQLite back into a Float32Array.
 *
 * @param blob - Raw bytes from the database.
 * @returns Decoded Float32Array.
 */
export function decodeVec(blob: Buffer): Float32Array {
  const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buf);
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * L2-normalize a vector in place.
 *
 * If the vector is all zeros or has zero norm, returns the vector unchanged.
 *
 * @param vec - Vector to normalize.
 * @returns The same vector, normalized.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i]! / norm;
  }
  return vec;
}

/**
 * Compute cosine similarity between two vectors.
 *
 * Both vectors should be L2-normalized for best results. If they are not,
 * the function normalizes them internally (less efficient).
 *
 * @param a - First vector.
 * @param b - Second vector (must be same length as a).
 * @returns Cosine similarity in [-1, 1].
 * @throws If vectors have different lengths.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// IVF-lite index
// ---------------------------------------------------------------------------

/** Number of centroids for IVF-lite quantization. */
const NUM_CENTROIDS = 256;

/** Number of nearest centroids to scan during query. */
const NPROBE = 16;

/**
 * Simple k-means clustering for IVF-lite.
 *
 * Runs for a fixed number of iterations (10) which is sufficient for
 * approximate quantization of embedding vectors.
 *
 * @param vectors - Array of vectors to cluster.
 * @param k - Number of centroids.
 * @returns Array of k centroid vectors.
 */
function kMeans(vectors: Float32Array[], k: number): Float32Array[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const numIter = 10;

  // Initialize centroids by picking evenly spaced vectors
  const centroids: Float32Array[] = [];
  const step = Math.max(1, Math.floor(vectors.length / k));
  for (let i = 0; i < k && i * step < vectors.length; i++) {
    centroids.push(new Float32Array(vectors[i * step]!));
  }

  // Pad remaining centroids with zeros if needed
  while (centroids.length < k) {
    centroids.push(new Float32Array(dim));
  }

  // Run iterations
  const assignments = new Int32Array(vectors.length);
  for (let iter = 0; iter < numIter; iter++) {
    // Assign each vector to nearest centroid
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclideanDistSq(vectors[i]!, centroids[c]!);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      assignments[i] = best;
    }

    // Recompute centroids
    const sums: Float32Array[] = [];
    const counts = new Int32Array(k);
    for (let c = 0; c < k; c++) {
      sums.push(new Float32Array(dim));
    }
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i]!;
      counts[c] = counts[c]! + 1;
      const sum = sums[c]!;
      const vec = vectors[i]!;
      for (let d = 0; d < dim; d++) {
        sum[d] = (sum[d] ?? 0) + (vec[d] ?? 0);
      }
    }
    for (let c = 0; c < k; c++) {
      const cnt = counts[c]!;
      if (cnt > 0) {
        const sum = sums[c]!;
        const centroid = centroids[c]!;
        for (let d = 0; d < dim; d++) {
          centroid[d] = (sum[d] ?? 0) / cnt;
        }
      }
    }
  }

  return centroids;
}

/**
 * Squared Euclidean distance between two vectors.
 */
function euclideanDistSq(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return sum;
}

/**
 * Find the k nearest centroid indices for a query vector.
 *
 * @param query - Query vector.
 * @param centroids - Array of centroid vectors.
 * @param k - Number of nearest centroids to return.
 * @returns Array of centroid indices, sorted by distance.
 */
function findNearestCentroids(
  query: Float32Array,
  centroids: Float32Array[],
  k: number,
): number[] {
  const dists: Array<[number, number]> = [];
  for (let i = 0; i < centroids.length; i++) {
    dists.push([euclideanDistSq(query, centroids[i]!), i]);
  }
  dists.sort((a, b) => a[0] - b[0]);
  return dists.slice(0, k).map(([, idx]) => idx);
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

/**
 * Result of a vector similarity search.
 */
export interface VecSearchHit {
  /** Memory record ID. */
  readonly memoryId: string;
  /** Cosine similarity score. */
  readonly score: number;
}

/**
 * Find the vector table name for a given embedder.
 *
 * Queries sqlite_master for tables matching the pattern `vec_<embedderId>_*`.
 * Returns the most recently created match (handles dimension changes).
 *
 * @param db - Database instance.
 * @param embedderId - Embedder identifier prefix.
 * @returns Table name if found, null otherwise.
 */
export function findVecTable(
  db: SqliteDatabase,
  embedderId: string,
): string | null {
  const safePrefix = embedderId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?",
  ).all(`vec_${safePrefix}_%`) as Array<{ name: string }>;

  if (tables.length === 0) return null;

  // Return the table with the highest dimension (most recent)
  return tables
    .sort((a, b) => b.name.localeCompare(a.name))
    [0]!.name;
}

/**
 * Extract dimension from a vector table name.
 *
 * Table name format: `vec_<embedderId>_<dim>`
 *
 * @param tableName - Vector table name.
 * @returns Dimension extracted from the table name.
 */
export function vecTableDimension(tableName: string): number {
  const lastUnderscore = tableName.lastIndexOf("_");
  if (lastUnderscore === -1) return 0;
  const dimStr = tableName.slice(lastUnderscore + 1);
  const dim = parseInt(dimStr, 10);
  return Number.isFinite(dim) ? dim : 0;
}

/**
 * Perform approximate vector similarity search using IVF-lite.
 *
 * 1. Finds the vector table for the given embedder.
 * 2. Loads all vectors and runs k-means to build centroids.
 * 3. Identifies the nprobe nearest centroids to the query.
 * 4. Scans only vectors in those centroids for cosine similarity.
 * 5. Returns the top `limit` results sorted by score descending.
 *
 * @param db - Database instance.
 * @param query - Query vector (will be L2-normalized).
 * @param embedderId - Embedder identifier to find the correct vector table.
 * @param limit - Maximum results to return.
 * @returns Array of VecSearchHit sorted by score descending.
 */
export function vectorSearch(
  db: SqliteDatabase,
  query: Float32Array,
  embedderId: string,
  limit: number,
): VecSearchHit[] {
  const tableName = findVecTable(db, embedderId);
  if (!tableName) return [];

  const dim = vecTableDimension(tableName);
  if (dim === 0 || dim !== query.length) return [];

  // Load all vectors
  const rows = db.prepare(`SELECT memory_id, v FROM ${tableName}`).all() as Array<{
    memory_id: string;
    v: Buffer;
  }>;

  if (rows.length === 0) return [];

  // L2-normalize query
  const qNorm = l2Normalize(new Float32Array(query));

  // Build vectors array
  const vectors: Float32Array[] = rows.map((r) => l2Normalize(decodeVec(r.v)));
  const ids: string[] = rows.map((r) => r.memory_id);

  // Build IVF-lite index
  const actualK = Math.min(NUM_CENTROIDS, vectors.length);
  const centroids = kMeans(vectors, actualK);

  // Find nearest centroids
  const nearestCentroidIdx = findNearestCentroids(qNorm, centroids, Math.min(NPROBE, actualK));
  const centroidSet = new Set(nearestCentroidIdx);

  // Build reverse index: centroid -> vector indices
  const reverseIndex: Map<number, number[]> = new Map();
  for (let i = 0; i < vectors.length; i++) {
    // Find closest centroid for this vector
    let bestC = 0;
    let bestD = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = euclideanDistSq(vectors[i]!, centroids[c]!);
      if (d < bestD) {
        bestD = d;
        bestC = c;
      }
    }
    const bucket = reverseIndex.get(bestC);
    if (bucket) {
      bucket.push(i);
    } else {
      reverseIndex.set(bestC, [i]);
    }
  }

  // Score only vectors in nearest centroids
  const scored: VecSearchHit[] = [];
  for (const cIdx of nearestCentroidIdx) {
    const bucket = reverseIndex.get(cIdx);
    if (!bucket) continue;
    for (const vIdx of bucket) {
      scored.push({
        memoryId: ids[vIdx]!,
        score: cosineSimilarity(qNorm, vectors[vIdx]!),
      });
    }
  }

  // Sort by score descending and return top limit
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Store a vector in the database.
 *
 * @param db - Database instance.
 * @param tableName - Vector table name.
 * @param memoryId - Memory record ID.
 * @param vec - Float32 vector to store.
 */
export function storeVector(
  db: SqliteDatabase,
  tableName: string,
  memoryId: string,
  vec: Float32Array,
): void {
  db.run(
    `INSERT OR REPLACE INTO ${tableName} (memory_id, v) VALUES (?, ?)`,
    [memoryId, encodeVec(l2Normalize(new Float32Array(vec)))],
  );
}

/**
 * Delete a vector from the database.
 *
 * @param db - Database instance.
 * @param tableName - Vector table name.
 * @param memoryId - Memory record ID.
 */
export function deleteVector(
  db: SqliteDatabase,
  tableName: string,
  memoryId: string,
): void {
  db.run(`DELETE FROM ${tableName} WHERE memory_id = ?`, [memoryId]);
}
