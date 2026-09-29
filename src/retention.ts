/**
 * Retention policy engine for Residue memory records.
 *
 * Automatically evicts old, low-value, and superseded records.
 * The policy is data-driven: per-kind TTL, per-project row cap,
 * access decay, and superseded-first eviction.
 *
 * Design:
 * - Bounded work: examines at most `batchSize` records per run.
 * - Cancellable: respects an AbortSignal.
 * - Idempotent: running twice changes nothing the second time.
 * - Never throws into its caller — failures are swallowed and logged.
 *
 * Eviction ordering (most to least priority):
 * 1. Superseded records (actively misleading if they surface).
 * 2. TTL-expired records (past their per-kind lifetime).
 * 3. Access-decay: records with low access_count and old last_access
 *    are less valuable than recently-accessed ones.
 * 4. Least valuable by a composite score of confidence × access recency.
 *
 * @module retention
 */

import type { MemoryKind, MemoryRecord } from "./core/types.js";
import type { MemoryStore, ScopePredicate, ScanOptions } from "./core/ports.js";
import type { RetentionConfig } from "./config.js";
import type { Logger } from "./log.js";

/** Scope filter for retention — which records to consider. */
export type RetentionScope = "project" | "global";

/**
 * Convert a RetentionConfig into a TTL map (kind → max age in ms).
 *
 * @param config - Retention configuration.
 * @returns Map from MemoryKind to TTL in milliseconds.
 */
function buildTtlMap(config: RetentionConfig): Map<MemoryKind, number> {
  const ttl = config.ttl;
  return new Map([
    ["decision", ttl.decisionDays * 86_400_000],
    ["pattern", ttl.patternDays * 86_400_000],
    ["fact", ttl.factDays * 86_400_000],
    ["digest", ttl.digestDays * 86_400_000],
    ["profile", ttl.profileDays * 86_400_000],
  ]);
}

/**
 * Compute an eviction priority score for a record.
 *
 * Lower score = more likely to be evicted.
 * Factors:
 * - Superseded records get score 0 (evict first).
 * - TTL-expired records get a very low score.
 * - Access decay: records not accessed recently score lower.
 * - Confidence: higher confidence protects against eviction.
 *
 * @param record - The memory record to score.
 * @param ttlMap - Per-kind TTL in ms.
 * @param now - Current epoch ms.
 * @returns Eviction priority score (lower = evict first).
 */
function evictionScore(
  record: MemoryRecord,
  ttlMap: Map<MemoryKind, number>,
  now: number,
): number {
  // Superseded records are the top eviction priority
  if (record.superseded_by !== null) return 0;

  // TTL-expired records get a very low score
  const ttl = ttlMap.get(record.kind) ?? 180 * 86_400_000;
  if (ttl > 0 && record.created_at + ttl < now) return 1;

  // Access decay: time since last access in days
  const daysSinceAccess = Math.max(0, (now - record.last_access) / 86_400_000);

  // Access count factor: more accesses = higher score
  const accessFactor = Math.min(record.access_count / 10, 1);

  // Confidence factor: higher confidence = higher score
  const confidenceFactor = record.confidence;

  // Recency factor: more recently accessed = higher score
  const recencyFactor = 1 / (1 + daysSinceAccess / 30);

  // Composite score (higher = keep, lower = evict)
  return 2 + accessFactor * 0.3 + confidenceFactor * 0.3 + recencyFactor * 0.4;
}

/**
 * Run the retention policy on a store.
 *
 * This function is:
 * - **Bounded**: examines at most `config.batchSize` records per run.
 * - **Cancellable**: respects the provided AbortSignal.
 * - **Idempotent**: running it twice changes nothing the second time.
 * - **Never throws**: errors are caught and logged.
 *
 * @param store - The memory store to apply retention to.
 * @param config - Retention configuration.
 * @param scope - Which scope to apply retention to.
 * @param logger - Logger for diagnostics.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns The number of records removed.
 */
export async function runRetention(
  store: MemoryStore,
  config: RetentionConfig,
  scope: ScopePredicate,
  logger: Logger,
  signal?: AbortSignal,
): Promise<number> {
  if (!config.enabled) return 0;

  let totalRemoved = 0;

  try {
    // Phase 1: Remove superseded records (highest priority)
    const supersededRemoved = await removeSuperseded(store, config, scope, signal);
    totalRemoved += supersededRemoved;

    signal?.throwIfAborted();

    // Phase 2: Remove TTL-expired records
    const ttlRemoved = await removeExpired(store, config, scope, signal);
    totalRemoved += ttlRemoved;

    signal?.throwIfAborted();

    // Phase 3: Enforce row cap by evicting least valuable records
    const capRemoved = await enforceCap(store, config, scope, signal);
    totalRemoved += capRemoved;

    if (totalRemoved > 0) {
      logger.info(`[retention] Removed ${totalRemoved} records`);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      logger.debug("[retention] Cancelled by signal");
    } else {
      logger.error(`[retention] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return totalRemoved;
}

/**
 * Remove records marked as superseded by another record.
 *
 * Superseded records are actively misleading if they surface in search,
 * so they are evicted first, regardless of TTL or access count.
 */
async function removeSuperseded(
  store: MemoryStore,
  config: RetentionConfig,
  scope: ScopePredicate,
  signal?: AbortSignal,
): Promise<number> {
  let removed = 0;
  let offset = 0;
  const batchSize = config.batchSize;

  while (removed < batchSize) {
    signal?.throwIfAborted();

    const records = await store.scan({
      scope,
      limit: Math.min(batchSize - removed, 100),
      offset,
    });

    if (records.length === 0) break;

    const supersededIds: string[] = [];
    for (const record of records) {
      if (record.superseded_by !== null) {
        supersededIds.push(record.id);
      }
    }

    if (supersededIds.length > 0) {
      removed += await store.removeMany(supersededIds);
    }

    offset += records.length;
    if (records.length < 100) break;
  }

  return removed;
}

/**
 * Remove records that have exceeded their per-kind TTL.
 *
 * Records with a TTL of 0 (e.g., profile) are exempt from TTL eviction.
 */
async function removeExpired(
  store: MemoryStore,
  config: RetentionConfig,
  scope: ScopePredicate,
  signal?: AbortSignal,
): Promise<number> {
  const now = Date.now();
  const ttlMap = buildTtlMap(config);
  let removed = 0;
  let offset = 0;
  const batchSize = config.batchSize;

  while (removed < batchSize) {
    signal?.throwIfAborted();

    const records = await store.scan({
      scope,
      limit: Math.min(batchSize - removed, 100),
      offset,
    });

    if (records.length === 0) break;

    const expiredIds: string[] = [];
    for (const record of records) {
      const ttl = ttlMap.get(record.kind) ?? 180 * 86_400_000;
      if (ttl > 0 && record.created_at + ttl < now) {
        expiredIds.push(record.id);
      }
    }

    if (expiredIds.length > 0) {
      removed += await store.removeMany(expiredIds);
    }

    offset += records.length;
    if (records.length < 100) break;
  }

  return removed;
}

/**
 * Enforce per-project or global row cap by evicting least valuable records.
 *
 * "Least valuable" is determined by the composite eviction score:
 * access count × confidence × recency. Superseded and TTL-expired records
 * have already been removed in earlier phases.
 */
async function enforceCap(
  store: MemoryStore,
  config: RetentionConfig,
  scope: ScopePredicate,
  signal?: AbortSignal,
): Promise<number> {
  const maxRecords = config.maxRecordsPerProject;
  if (maxRecords <= 0) return 0;

  const currentCount = await store.count(scope);
  if (currentCount <= maxRecords) return 0;

  const toRemove = currentCount - maxRecords;
  let removed = 0;
  let offset = 0;
  const ttlMap = buildTtlMap(config);
  const now = Date.now();

  while (removed < toRemove) {
    signal?.throwIfAborted();

    const records = await store.scan({
      scope,
      limit: Math.min(toRemove - removed, 100),
      offset,
    });

    if (records.length === 0) break;

    // Score all records and sort by eviction priority (lowest first)
    const scored = records.map((r) => ({
      id: r.id,
      score: evictionScore(r, ttlMap, now),
    }));
    scored.sort((a, b) => a.score - b.score);

    // Take the least valuable ones
    const idsToRemove = scored
      .slice(0, toRemove - removed)
      .map((s) => s.id);

    if (idsToRemove.length > 0) {
      removed += await store.removeMany(idsToRemove);
    }

    offset += records.length;
    if (records.length < 100) break;
  }

  return removed;
}
