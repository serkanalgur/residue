/**
 * Store factory — creates the appropriate MemoryStore implementation.
 *
 * Probes for SQLite drivers, acquires file locks, and returns either
 * a SqliteStore or InMemoryStore based on availability.
 *
 * @module store/factory
 */

import type { MemoryStore } from "../core/ports.js";
import type { Logger } from "../log.js";
import type { ResolvedPaths } from "../paths.js";
import type { ResidueOptions } from "../config.js";
import { probeDriver } from "./sqlite/driver.js";
import { SqliteStore } from "./sqlite/store.js";
import { acquireLock } from "./sqlite/lock.js";
import { InMemoryStore } from "./memory-store.js";

/** Result of store creation. */
export interface StoreResult {
  /** The created store instance. */
  readonly store: MemoryStore;
  /** Whether the store is in degraded mode. */
  readonly degraded: boolean;
  /** Reason for degradation, if any. */
  readonly reason?: string;
  /** Driver used for SQLite, or "memory" for in-memory fallback. */
  readonly driver: string;
}

/**
 * Create a MemoryStore instance based on available drivers and configuration.
 *
 * Resolution chain:
 * 1. Try SQLite with bun:sqlite or node:sqlite
 * 2. Try acquiring file lock (read-only if lock held)
 * 3. Fall back to InMemoryStore if no driver available
 *
 * @param paths - Resolved data paths (DB file locations).
 * @param options - Plugin options.
 * @param logger - Logger instance for warnings.
 * @returns Store result with the created store and metadata.
 */
export async function createStore(
  paths: ResolvedPaths,
  options: ResidueOptions,
  logger: Logger,
): Promise<StoreResult> {
  // Probe for SQLite driver
  const driverResult = await probeDriver(paths.projectDb);

  if (driverResult.driver === "none" || !driverResult.factory) {
    logger.warn(`No SQLite driver available: ${driverResult.reason ?? "unknown"}`);
    return {
      store: new InMemoryStore(),
      degraded: true,
      reason: driverResult.reason ?? "No SQLite driver available",
      driver: "memory",
    };
  }

  // Open the database
  let db;
  try {
    db = driverResult.factory(paths.projectDb);
  } catch (err) {
    logger.warn(`Failed to open database: ${err instanceof Error ? err.message : String(err)}`);
    return {
      store: new InMemoryStore(),
      degraded: true,
      reason: `Failed to open database: ${err instanceof Error ? err.message : String(err)}`,
      driver: "memory",
    };
  }

  // Try acquiring lock
  const lockAcquired = acquireLock(paths.projectDb, logger);
  const readOnly = !lockAcquired;

  // Create the store
  const store = new SqliteStore(db, {
    embedder: null, // Embedder is resolved externally and passed in
    readOnly,
  });

  try {
    await store.initialize();
  } catch (err) {
    logger.warn(`Failed to initialize store: ${err instanceof Error ? err.message : String(err)}`);
    try {
      db.close();
    } catch {
      // Best effort
    }
    return {
      store: new InMemoryStore(),
      degraded: true,
      reason: `Failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      driver: "memory",
    };
  }

  return {
    store,
    degraded: readOnly,
    reason: readOnly ? "Lock held by another process — read-only mode" : undefined,
    driver: driverResult.name,
  };
}
