/**
 * Regression test for bench/token-cost.ts determinism.
 *
 * The benchmark report must be byte-identical across runs so that
 * docs/benchmarks/token-cost.md doesn't produce a git diff every time
 * `bun run bench:token-cost` is executed.
 *
 * Sources of non-determinism that were eliminated:
 * - `new Date().toISOString()` in the report footer → replaced with
 *   input-derived metadata (record count, turn count, query count).
 * - `new Date().toISOString()` in seed record timestamps → replaced with
 *   a fixed SEED_TIMESTAMP constant.
 * - `toLocaleString()` for number formatting → replaced with
 *   `toLocaleString("en-US")` to be locale-independent.
 *
 * @module test/bench-token-cost
 */

import { describe, it, expect } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { estimateCost } from "../src/retrieval/estimate.js";
import { buildScopePredicate } from "../src/scope.js";
import {
  seedStore,
  simulatePromptHook,
  simulateContextHook,
  simulateToolOnly,
  buildReport,
  RESOLVED,
  OPTIONS,
  TURN_COUNT,
  QUESTIONS,
} from "../bench/token-cost.js";

/** Run the full benchmark pipeline and return the report string. */
async function generateReport(): Promise<string> {
  const store = new InMemoryStore();
  await store.initialize();
  await seedStore(store);

  const recordCount = await store.count(
    buildScopePredicate("both", RESOLVED, OPTIONS),
  );

  const promptResult = await simulatePromptHook(store);
  const contextResult = await simulateContextHook(store);
  const toolOnlyResult = await simulateToolOnly(store);

  const promptCost = estimateCost(promptResult.totalInputTokens, null, "small");
  const contextCost = estimateCost(contextResult.totalInputTokens, null, "small");
  const toolOnlyCost = estimateCost(toolOnlyResult.totalInputTokens, null, "small");

  return buildReport(
    promptResult,
    contextResult,
    toolOnlyResult,
    promptCost,
    contextCost,
    toolOnlyCost,
    recordCount,
  );
}

describe("bench/token-cost — determinism", () => {
  it("two consecutive runs produce byte-identical reports", async () => {
    const report1 = await generateReport();
    const report2 = await generateReport();
    expect(report1).toBe(report2);
  });

  it("three consecutive runs produce byte-identical reports", async () => {
    const report1 = await generateReport();
    const report2 = await generateReport();
    const report3 = await generateReport();
    expect(report1).toBe(report2);
    expect(report2).toBe(report3);
  });

  it("report footer contains input metadata, not a wall-clock timestamp", async () => {
    const report = await generateReport();
    const footer = report.split("\n").filter((l) => l.startsWith("*Generated"))[0];
    expect(footer).toBeDefined();
    // Must NOT contain an ISO timestamp (T followed by colon pattern)
    expect(footer).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Must contain input-derived metadata
    expect(footer).toContain(`${TURN_COUNT} turns`);
    expect(footer).toContain(`${QUESTIONS.length} queries`);
  });

  it("numbers use US-style comma grouping regardless of locale", async () => {
    const report = await generateReport();
    // The summary table has token counts; on this machine they should be comma-separated
    const summaryLine = report
      .split("\n")
      .find((l) => l.startsWith("| Total input tokens"));
    expect(summaryLine).toBeDefined();
    // At least one number should have a comma (e.g. "142,342")
    expect(summaryLine).toMatch(/\d{1,3}(,\d{3})+/);
  });
});
