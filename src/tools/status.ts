/**
 * `res_status` tool — reports plugin health and configuration.
 *
 * Read-only diagnostic tool. Returns:
 * - Plugin and store versions
 * - SQLite driver, WAL, and FTS5 status
 * - Record counts (project + global)
 * - Embedder status
 * - Data directory path
 * - Last injection budget
 *
 * @module tools/status
 */

import type { ResidueStatus } from "../core/types.js";

/**
 * Build the status response object.
 *
 * @param params - Status parameters.
 * @param params.pluginVersion - Current plugin version string.
 * @param params.driver - SQLite driver name.
 * @param params.walEnabled - Whether WAL mode is active.
 * @param params.fts5Available - Whether FTS5 is available.
 * @param params.projectRecordCount - Number of project-scoped records.
 * @param params.globalRecordCount - Number of global-scoped records.
 * @param params.embedder - Embedder status info.
 * @param params.dataDir - Resolved data directory path.
 * @param params.lastInjection - Last injection budget info.
 * @returns Formatted status string for tool output.
 */
export function buildStatusResponse(params: {
  pluginVersion: string;
  driver: string;
  walEnabled: boolean;
  fts5Available: boolean;
  projectRecordCount: number;
  globalRecordCount: number;
  embedder: ResidueStatus["embedder"];
  dataDir: string;
  lastInjection: ResidueStatus["lastInjection"];
}): string {
  const status: ResidueStatus = {
    pluginVersion: params.pluginVersion,
    storeVersion: 1,
    driver: params.driver,
    walEnabled: params.walEnabled,
    fts5Available: params.fts5Available,
    projectRecordCount: params.projectRecordCount,
    globalRecordCount: params.globalRecordCount,
    embedder: params.embedder,
    dataDir: params.dataDir,
    lastInjection: params.lastInjection,
  };

  return JSON.stringify(status, null, 2);
}
