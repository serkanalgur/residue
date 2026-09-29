/**
 * WAL mode, busy timeout, and PID-based file locking for SQLite.
 *
 * Configures SQLite pragmas for safe concurrent access and provides
 * a PID lock file to prevent corruption from multiple processes.
 *
 * @module store/sqlite/lock
 */

import type { SqliteDatabase } from "./driver.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Lock file extension. */
const LOCK_EXT = ".lock";

/** Default busy timeout in milliseconds. */
const DEFAULT_BUSY_TIMEOUT = 5000;

/**
 * Configuration result for WAL + pragmas.
 */
export interface PragmaResult {
  /** Whether WAL mode is enabled (requires file-backed database). */
  readonly walEnabled: boolean;
  /** Whether foreign keys are enabled. */
  readonly foreignKeysEnabled: boolean;
  /** Whether the busy timeout was set. */
  readonly busyTimeoutSet: boolean;
}

/**
 * Apply standard pragmas to a SQLite database.
 *
 * Sets WAL journal mode, busy timeout, and foreign keys.
 * WAL only works with file-backed databases; in-memory databases
 * will report walEnabled: false (which is expected).
 *
 * @param db - Database instance.
 * @param busyTimeout - Busy timeout in milliseconds (default: 5000).
 * @returns Pragma configuration result.
 */
export function applyPragmas(db: SqliteDatabase, busyTimeout: number = DEFAULT_BUSY_TIMEOUT): PragmaResult {
  let walEnabled = false;
  let foreignKeysEnabled = false;
  let busyTimeoutSet = false;

  // WAL mode — only works on file-backed databases
  try {
    db.run("PRAGMA journal_mode=WAL");
    // Verify WAL is active
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
    walEnabled = row?.journal_mode === "wal";
  } catch {
    // WAL not supported or in-memory DB
  }

  // Busy timeout
  try {
    db.run(`PRAGMA busy_timeout=${busyTimeout}`);
    busyTimeoutSet = true;
  } catch {
    // Some drivers don't support busy_timeout pragma
  }

  // Foreign keys
  try {
    db.run("PRAGMA foreign_keys=ON");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    foreignKeysEnabled = row?.foreign_keys === 1;
  } catch {
    // Foreign keys not supported
  }

  return { walEnabled, foreignKeysEnabled, busyTimeoutSet };
}

/**
 * PID lock file for preventing concurrent process access.
 *
 * Creates a `.lock` file alongside the database with the current PID.
 * If the lock file exists and the process is still alive, lock acquisition
 * fails (returns false). If the process is dead, the stale lock is removed.
 *
 * @param dbPath - Path to the database file.
 * @param logger - Optional logger for warnings.
 * @returns True if lock was acquired, false if another process holds it.
 */
export function acquireLock(
  dbPath: string,
  logger?: { warn(msg: string): void },
): boolean {
  const lockPath = dbPath + LOCK_EXT;

  if (existsSync(lockPath)) {
    try {
      const content = readFileSync(lockPath, "utf8").trim();
      const pid = parseInt(content, 10);
      if (Number.isFinite(pid) && isProcessAlive(pid)) {
        logger?.warn(
          `[residue] Lock held by PID ${pid} — entering read-only mode`,
        );
        return false;
      }
      // Stale lock — process is dead, remove it
      unlinkSync(lockPath);
    } catch {
      // Lock file is corrupted or unreadable — remove and retry
      try {
        unlinkSync(lockPath);
      } catch {
        // Best effort
      }
    }
  }

  try {
    writeFileSync(lockPath, String(process.pid), "utf8");
    return true;
  } catch {
    logger?.warn("[residue] Could not create lock file — entering read-only mode");
    return false;
  }
}

/**
 * Release the PID lock file.
 *
 * @param dbPath - Path to the database file.
 */
export function releaseLock(dbPath: string): void {
  const lockPath = dbPath + LOCK_EXT;
  try {
    if (existsSync(lockPath)) {
      const content = readFileSync(lockPath, "utf8").trim();
      const pid = parseInt(content, 10);
      // Only remove if we own the lock
      if (pid === process.pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    // Best effort cleanup
  }
}

/**
 * Check if a process with the given PID is alive.
 *
 * @param pid - Process ID to check.
 * @returns True if the process is running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // process.kill with signal 0 doesn't send a signal but checks existence
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
