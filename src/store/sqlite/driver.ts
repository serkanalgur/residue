/**
 * SQLite driver resolution chain.
 *
 * Attempts bun:sqlite first, then node:sqlite, then falls back to an
 * in-memory implementation. The first working driver is returned.
 *
 * @module store/sqlite/driver
 */

/** Driver types in resolution order. */
export type DriverKind = "bun" | "node" | "memory" | "none";

/** Resolved driver information. */
export interface DriverResult {
  /** Which driver was selected. */
  readonly driver: DriverKind;
  /** Human-readable driver name for status reports. */
  readonly name: string;
  /** Whether the driver is file-backed (supports WAL). */
  readonly fileBacked: boolean;
  /** Error message if no driver was found. */
  readonly reason?: string;
}

/** Minimal interface abstracting over bun:sqlite and node:sqlite. */
export interface SqliteDatabase {
  /** Execute a SQL statement (no return value). */
  run(sql: string, ...params: unknown[]): unknown;
  /** Execute a SQL statement (no return value, alias for run). */
  exec(sql: string): void;
  /** Prepare and execute a query returning all rows. */
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  /** Close the database connection. */
  close(): void;
}

/** Factory function that creates a database connection. */
export type DriverFactory = (path: string) => SqliteDatabase;

/**
 * Attempt to import bun:sqlite and return a driver factory.
 *
 * @returns Driver factory if bun:sqlite is available, null otherwise.
 */
async function tryBunSqlite(): Promise<DriverFactory | null> {
  try {
    const mod = await import("bun:sqlite");
    const Database = mod.Database;
    return (path: string): SqliteDatabase => new Database(path) as unknown as SqliteDatabase;
  } catch {
    return null;
  }
}

/**
 * Attempt to import node:sqlite and return a driver factory.
 *
 * @returns Driver factory if node:sqlite is available, null otherwise.
 */
async function tryNodeSqlite(): Promise<DriverFactory | null> {
  try {
    const mod = await import("node:sqlite");
    const DatabaseSync = mod.DatabaseSync;
    return (path: string): SqliteDatabase => new DatabaseSync(path) as unknown as SqliteDatabase;
  } catch {
    return null;
  }
}

/**
 * Probe and resolve the best available SQLite driver.
 *
 * Resolution order: bun:sqlite → node:sqlite → none.
 * Each driver is tested by opening a temporary in-memory database.
 *
 * @param dbPath - Path to probe the driver with (used for file-backed check).
 * @returns Driver result with factory, or none if no driver is available.
 */
export async function probeDriver(dbPath: string = ":memory:"): Promise<DriverResult & { factory: DriverFactory | null }> {
  // Try bun:sqlite first
  const bunFactory = await tryBunSqlite();
  if (bunFactory) {
    try {
      const db = bunFactory(dbPath);
      db.run("SELECT 1");
      db.close();
      return {
        driver: "bun",
        name: "bun:sqlite",
        fileBacked: dbPath !== ":memory:",
        factory: bunFactory,
      };
    } catch {
      // bun:sqlite loaded but failed — fall through
    }
  }

  // Try node:sqlite second
  const nodeFactory = await tryNodeSqlite();
  if (nodeFactory) {
    try {
      const db = nodeFactory(dbPath);
      db.run("SELECT 1");
      db.close();
      return {
        driver: "node",
        name: "node:sqlite",
        fileBacked: dbPath !== ":memory:",
        factory: nodeFactory,
      };
    } catch {
      // node:sqlite loaded but failed — fall through
    }
  }

  return {
    driver: "none",
    name: "none",
    fileBacked: false,
    factory: null,
    reason: "No SQLite driver available (tried bun:sqlite, node:sqlite)",
  };
}
