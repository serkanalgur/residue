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
import { l2Normalize as _l2Normalize, cosine } from "../../embed/normalize.js";

// ---------------------------------------------------------------------------
// BLOB encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a Float32Array as a Buffer (BLOB) for SQLite storage.
 *
 * NOTE: This is intentionally different from normalize.ts's `encodeFloat32`
 * which includes a length prefix header. Vectors use raw bytes in SQLite.
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
// Vector math (delegated to canonical embed/normalize.ts)
// ---------------------------------------------------------------------------

/**
 * L2-normalize a vector in place. Delegates to canonical implementation.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  return _l2Normalize(vec);
}

/**
 * Compute cosine similarity between two vectors.
 * Delegates to canonical implementation.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  return cosine(a, b);
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
// IVF-lite cache
// ---------------------------------------------------------------------------

/** Cached IVF index for a single table. */
interface CachedIVF {
  /** Centroid vectors from k-means. */
  readonly centroids: Float32Array[];
  /** Reverse index: centroid index → vector indices. */
  readonly reverseIndex: Map<number, number[]>;
  /** Vector data (normalized) for scoring. */
  readonly vectors: Float32Array[];
  /** Vector IDs. */
  readonly ids: string[];
  /** Row count at time of index build (invalidation key). */
  readonly rowCount: number;
}

/** Module-level IVF cache, keyed by table name. */
const ivfCache = new Map<string, CachedIVF>();

/**
 * Invalidate the cached IVF index for a table.
 *
 * Called by SqliteStore after insert/delete to ensure the next
 * vectorSearch builds a fresh index.
 *
 * @param tableName - Table whose cache to invalidate.
 */
export function invalidateVectorCache(tableName: string): void {
  ivfCache.delete(tableName);
}

/**
 * Get the current cache generation counter (for testing).
 * Returns the total number of cache invalidations across all tables.
 */
let cacheGeneration = 0;
export function getCacheGeneration(): number {
  return cacheGeneration;
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

  // Check cache — reuse if row count unchanged
  let cached = ivfCache.get(tableName);
  if (cached === undefined || cached.rowCount !== rows.length) {
    // Build vectors array
    const vectors: Float32Array[] = rows.map((r) => l2Normalize(decodeVec(r.v)));
    const ids: string[] = rows.map((r) => r.memory_id);

    // Build IVF-lite index
    const actualK = Math.min(NUM_CENTROIDS, vectors.length);
    const centroids = kMeans(vectors, actualK);

    // Build reverse index: centroid -> vector indices
    const reverseIndex: Map<number, number[]> = new Map();
    for (let i = 0; i < vectors.length; i++) {
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

    cached = { centroids, reverseIndex, vectors, ids, rowCount: rows.length };
    ivfCache.set(tableName, cached);
  }

  // Find nearest centroids
  const nearestCentroidIdx = findNearestCentroids(qNorm, cached.centroids, Math.min(NPROBE, cached.centroids.length));

  // Score only vectors in nearest centroids
  const scored: VecSearchHit[] = [];
  for (const cIdx of nearestCentroidIdx) {
    const bucket = cached.reverseIndex.get(cIdx);
    if (!bucket) continue;
    for (const vIdx of bucket) {
      scored.push({
        memoryId: cached.ids[vIdx]!,
        score: cosineSimilarity(qNorm, cached.vectors[vIdx]!),
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
  // Invalidate IVF cache — row count changed
  invalidateVectorCache(tableName);
  cacheGeneration++;
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
  // Invalidate IVF cache — row count changed
  invalidateVectorCache(tableName);
  cacheGeneration++;
}
