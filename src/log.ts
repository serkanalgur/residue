/**
 * Structured logger for Residue with secret redaction.
 *
 * All output is prefixed with `[residue]`. Sensitive values are
 * automatically redacted before output.
 *
 * @module log
 */

import { redactSecrets } from "./config.js";

/** Logger interface with standard levels. */
export interface Logger {
  /** Log an informational message. */
  info(msg: string): void;
  /** Log a warning message. */
  warn(msg: string): void;
  /** Log an error message. */
  error(msg: string): void;
  /** Log a debug message (only when debug mode is enabled). */
  debug(msg: string): void;
}

/**
 * Create a logger instance.
 *
 * @param debug - Whether debug-level messages should be emitted.
 * @returns Logger instance with redacted output.
 */
export function createLogger(debug: boolean): Logger {
  const prefix = "[residue]";

  return {
    info(msg: string): void {
      console.log(`${prefix} ${redactSecrets(msg)}`);
    },
    warn(msg: string): void {
      console.warn(`${prefix} ${redactSecrets(msg)}`);
    },
    error(msg: string): void {
      console.error(`${prefix} ${redactSecrets(msg)}`);
    },
    debug(msg: string): void {
      if (debug) {
        console.log(`${prefix} [debug] ${redactSecrets(msg)}`);
      }
    },
  };
}
