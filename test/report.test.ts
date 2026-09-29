/**
 * Tests for the reporting stripe.
 *
 * Covers:
 * - Disabled by default — call path genuinely absent
 * - When enabled, hard rate limit holds under a burst
 * - Never uses resume: true
 * - Content stays short and never contains full record dumps
 * - Synthetic message delivery mode is "queue" (not "steer")
 *
 * @module test/report
 */

import { describe, it, expect } from "bun:test";
import { createReporter } from "../src/report.js";
import { createLogger } from "../src/log.js";
import type { ReportConfig } from "../src/config.js";

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function defaultConfig(overrides: Partial<ReportConfig> = {}): ReportConfig {
  return {
    enabled: false,
    maxPerSessionPer5min: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Disabled by default
// ---------------------------------------------------------------------------

describe("report — disabled by default", () => {
  it("returns null when report.enabled is false", () => {
    const config = defaultConfig({ enabled: false });
    const mockSession = { synthetic: async () => ({}) };

    const reporter = createReporter(config, "ses-test", { session: mockSession }, SILENT_LOG);

    // Code path is genuinely absent — null, not a no-op function
    expect(reporter).toBeNull();
  });

  it("the call path to session.synthetic is absent when disabled", async () => {
    let syntheticCalled = false;
    const config = defaultConfig({ enabled: false });
    const mockSession = {
      synthetic: async () => {
        syntheticCalled = true;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-test", { session: mockSession }, SILENT_LOG);
    expect(reporter).toBeNull();

    // Even if someone tried to call it, it would fail (null)
    expect(syntheticCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enabled — basic functionality
// ---------------------------------------------------------------------------

describe("report — enabled", () => {
  it("sends a synthetic message via session.synthetic", async () => {
    let capturedInput: Record<string, unknown> = {};
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 5 });
    const mockSession = {
      synthetic: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-report-001", { session: mockSession }, SILENT_LOG);
    expect(reporter).not.toBeNull();

    await reporter!("Memory: 3 new facts captured.");

    expect(capturedInput.sessionID).toBe("ses-report-001");
    expect(capturedInput.text).toBe("Memory: 3 new facts captured.");
  });

  it("never sets resume: true", async () => {
    let capturedInput: Record<string, unknown> = {};
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 5 });
    const mockSession = {
      synthetic: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-resume", { session: mockSession }, SILENT_LOG);
    await reporter!("Test message");

    // CRITICAL: resume must NEVER be true
    expect(capturedInput.resume).toBe(false);
  });

  it("uses delivery: queue (not steer)", async () => {
    let capturedInput: Record<string, unknown> = {};
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 5 });
    const mockSession = {
      synthetic: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-delivery", { session: mockSession }, SILENT_LOG);
    await reporter!("Test message");

    expect(capturedInput.delivery).toBe("queue");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("report — rate limiting", () => {
  it("enforces maxPerSessionPer5min within a burst", async () => {
    let callCount = 0;
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 2 });
    const mockSession = {
      synthetic: async () => {
        callCount++;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-rate", { session: mockSession }, SILENT_LOG);
    expect(reporter).not.toBeNull();

    // First two should succeed
    await reporter!("Message 1");
    await reporter!("Message 2");
    expect(callCount).toBe(2);

    // Third should be rate-limited
    await reporter!("Message 3");
    expect(callCount).toBe(2); // Still 2 — third was blocked
  });

  it("all messages in a burst beyond the limit are dropped", async () => {
    let callCount = 0;
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 1 });
    const mockSession = {
      synthetic: async () => {
        callCount++;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-drop", { session: mockSession }, SILENT_LOG);

    await reporter!("First");
    await reporter!("Second");
    await reporter!("Third");
    await reporter!("Fourth");

    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

describe("report — content safety", () => {
  it("truncates messages longer than 200 chars", async () => {
    let capturedText = "";
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 5 });
    const mockSession = {
      synthetic: async (input: Record<string, unknown>) => {
        capturedText = input.text as string;
        return {};
      },
    };

    const reporter = createReporter(config, "ses-trunc", { session: mockSession }, SILENT_LOG);

    const longMessage = "x".repeat(300);
    await reporter!(longMessage);

    expect(capturedText.length).toBeLessThanOrEqual(200);
    expect(capturedText.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("report — error handling", () => {
  it("never throws when session.synthetic fails", async () => {
    const config = defaultConfig({ enabled: true, maxPerSessionPer5min: 5 });
    const mockSession = {
      synthetic: async () => {
        throw new Error("synthetic failed");
      },
    };

    const reporter = createReporter(config, "ses-fail", { session: mockSession }, SILENT_LOG);
    expect(reporter).not.toBeNull();

    // Must NOT throw
    await expect(reporter!("Test")).resolves.toBeUndefined();
  });
});
