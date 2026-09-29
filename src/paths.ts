/**
 * Data directory resolution with fallback chain and writability checks.
 *
 * Resolves the data directory based on configuration, with automatic
 * fallback through XDG, home, and temp directories. All path computation
 * is injectable for testability.
 *
 * @module paths
 */

import { homedir, tmpdir, platform } from "node:os";
import { join } from "node:path";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

/**
 * Injectable environment for path resolution (enables testing).
 */
export interface Env {
  /** Read environment variable. */
  env(name: string): string | undefined;
  /** Get home directory path. */
  homedir(): string;
  /** Get temp directory path. */
  tmpdir(): string;
  /** Check if a path is writable. */
  isWritable(path: string): Promise<boolean>;
}

/**
 * Production environment implementation using Node.js built-ins.
 */
export const NODE_ENV: Env = {
  env(name: string): string | undefined {
    return process.env[name];
  },
  homedir(): string {
    return homedir();
  },
  tmpdir(): string {
    return tmpdir();
  },
  async isWritable(path: string): Promise<boolean> {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** Resolved path configuration for data storage. */
export interface ResolvedPaths {
  /** Base directory where all data lives. */
  readonly base: string;
  /** Path to the global SQLite database file. */
  readonly globalDb: string;
  /** Path to the project-specific SQLite database file. */
  readonly projectDb: string;
}

/**
 * Resolve data directory paths with a fallback chain.
 *
 * Resolution order for `dataDir: "xdg"`:
 * 1. `$XDG_DATA_HOME/residue/` (if set and writable)
 * 2. `~/.local/share/residue/` (if writable)
 * 3. `<tmpdir>/residue/` (always writable, but ephemeral)
 *
 * Resolution order for `dataDir: "project"`:
 * 1. `<projectDir>/.opencode/residue/` (warns about repo-internal writes)
 * 2. Falls back to XDG chain above if not writable
 *
 * @param options - Plugin options (dataDir setting).
 * @param projectID - Unique project identifier for database naming.
 * @param env - Injectable environment (defaults to production).
 * @param warn - Warning callback for non-fatal issues.
 * @returns Resolved paths for data storage.
 */
export async function resolveDataDir(
  options: { dataDir: string },
  projectID: string,
  env: Env = NODE_ENV,
  warn: (msg: string) => void = console.warn,
): Promise<ResolvedPaths> {
  if (options.dataDir === "project") {
    // Project-local resolution — warns about writing into repo
    const projectBase = join(process.cwd(), ".opencode", "residue");
    if (await env.isWritable(projectBase) || await ensureDir(projectBase, env)) {
      warn(
        `[residue] Writing data into project directory (.opencode/residue/). ` +
        `This may pollute your repository. Consider using dataDir: "xdg" instead.`,
      );
      return buildPaths(projectBase, projectID);
    }
    warn(`[residue] Project directory not writable, falling back to XDG chain`);
  }

  // XDG fallback chain
  const xdgHome = env.env("XDG_DATA_HOME");
  if (xdgHome) {
    const base = join(xdgHome, "residue");
    if (await env.isWritable(base) || await ensureDir(base, env)) {
      return buildPaths(base, projectID);
    }
  }

  const homeShare = join(env.homedir(), ".local", "share", "residue");
  if (await env.isWritable(homeShare) || await ensureDir(homeShare, env)) {
    return buildPaths(homeShare, projectID);
  }

  // Last resort: temp directory (data is ephemeral)
  const tmpBase = join(env.tmpdir(), "residue");
  if (await ensureDir(tmpBase, env)) {
    warn(
      `[residue] Falling back to temp directory (${tmpBase}). ` +
      `Data will not persist across reboots.`,
    );
    return buildPaths(tmpBase, projectID);
  }

  // Should never reach here — tmpdir is always writable on sane systems
  throw new Error(
    `[residue] Cannot find a writable data directory. ` +
    `Checked XDG, home, and tmp. Check file permissions.`,
  );
}

/** Build the resolved paths object from a base directory. */
function buildPaths(base: string, projectID: string): ResolvedPaths {
  return {
    base,
    globalDb: join(base, "global.db"),
    projectDb: join(base, `project-${projectID}.db`),
  };
}

/** Ensure a directory exists, creating it if necessary. Returns true on success. */
async function ensureDir(path: string, env: Env): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    return await env.isWritable(path);
  } catch {
    return false;
  }
}
