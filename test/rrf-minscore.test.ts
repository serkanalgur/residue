/**
 * Regression tests for the RRF score-scale bug.
 *
 * ## The bug
 *
 * `hybridSearch` merged its two channels with Reciprocal Rank Fusion and then
 * compared the result against `inject.minScore` (default `0.34`, documented as
 * a 0–1 similarity threshold). RRF scores are *rank*-derived, not similarity
 * scores: the maximum attainable value is `2 / (k + 1)`, which is `0.0328` at
 * the standard `k = 60`. A single-channel hit tops out at `0.0164`.
 *
 * So the default threshold sat ~10x above the structural ceiling and **every
 * hit was discarded**. Under default configuration the plugin never injected
 * a memory — silently, with no error.
 *
 * ## The fix
 *
 * `normalizeRrfScores` rescales the merged set so the best hit is `1.0`,
 * making the scale independent of `k`, channel count, and candidate count.
 * The transform is monotonic, so ranking is unchanged; only the threshold
 * comparison differs.
 *
 * These tests pin the behaviour from both ends: a top-ranked hit must survive
 * the default filter, and a high relative threshold must still be able to
 * exclude weak matches (i.e. the filter did not simply get disabled).
 *
 * @module test/rrf-minscore
 */

import { describe, it, expect } from "bun:test";
import {
  hybridSearch,
  rrfMerge,
  normalizeRrfScores,
} from "../src/retrieval/search.js";
import { select } from "../src/retrieval/select.js";
import { buildScopePredicate } from "../src/scope.js";
import { DEFAULT_OPTIONS } from "../src/config.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import type { SearchHit } from "../src/core/types.js";
import type { ResolvedScope } from "../src/core/ports.js";
import type { Logger } from "../src/log.js";

const log: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const resolved: ResolvedScope = {
  projectID: "proj-rrf",
  worktreeKey: "wk-rrf",
  branchKey: "main",
  canonicalDir: "/rrf",
};

const options = { inject: { shareAcrossWorktrees: true } };

/**
 * A deterministic embedder whose vectors are derived from the record content,
 * so an embedder-backed search agrees with the lexical channel on which record
 * is the best match. Needed to exercise the both-channel (hybrid) path.
 */
function makeEmbedder() {
  return {
    id: "test-embedder",
    dim: 8,
    degraded: false,
    reason: "",
    async embed(text: string): Promise<Float32Array> {
      const v = new Float32Array(8);
      for (let i = 0; i < text.length; i++) {
        v[i % 8] += text.charCodeAt(i) / 1000;
      }
      // Normalize to unit length so cosine similarity behaves.
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < 8; i++) v[i] = (v[i] ?? 0) / norm;
      return v;
    },
  };
}

/** Build a synthetic SearchHit with a given id and score. */
function hit(id: string, score: number, content = "some memory content"): SearchHit {
  return {
    record: {
      id,
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content,
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date(0).toISOString() },
      tags: [],
      confidence: 0.8,
      created_at: 0,
      last_access: 0,
      access_count: 0,
      superseded_by: null,
    },
    score,
    ftsMatch: true,
  };
}

// ---------------------------------------------------------------------------
// normalizeRrfScores
// ---------------------------------------------------------------------------

describe("normalizeRrfScores", () => {
  it("rescales a best-case hit (both channels, rank 0) to exactly 1.0", () => {
    const merged = rrfMerge(
      [hit("a", 0), hit("b", 0), hit("c", 0)],
      [hit("a", 0), hit("b", 0), hit("c", 0)],
    );
    const normalized = normalizeRrfScores(merged);

    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized.every((h) => h.score <= 1)).toBe(true);
  });

  it("scores a single-channel rank-0 hit at 0.5 (channel agreement survives)", () => {
    // Dividing by the observed maximum would also yield 1.0 here; dividing by
    // the structural bound correctly reports "found by one channel only".
    const merged = rrfMerge([hit("solo", 0), hit("other", 0)], []);
    const normalized = normalizeRrfScores(merged);

    expect(normalized[0]!.score).toBeCloseTo(0.5, 5);
  });

  it("preserves ranking order (monotonic transform)", () => {
    const merged = rrfMerge(
      [hit("a", 0), hit("b", 0), hit("c", 0), hit("d", 0)],
      [hit("c", 0), hit("a", 0)],
    );
    const before = merged.map((h) => h.record.id);
    const after = normalizeRrfScores(merged).map((h) => h.record.id);

    expect(after).toEqual(before);
  });

  it("handles empty input", () => {
    expect(normalizeRrfScores([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

describe("RRF scores are comparable to the default minScore", () => {
  it("a top-ranked hit survives the DEFAULT minScore filter", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    await store.insert({
      kind: "decision",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content: "Project uses bun:sqlite for the database",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    const scope = buildScopePredicate("both", resolved, options);

    // Use the REAL default minScore from config — this is the regression.
    const result = await hybridSearch(
      store,
      null,
      "bun:sqlite database",
      { channelLimit: 10, limit: 5, minScore: DEFAULT_OPTIONS.inject.minScore },
      { scope },
      log,
    );

    // Before the fix this was 0 — the raw RRF score (~0.016) never reached 0.34.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.record.content).toContain("bun:sqlite");
    expect(result.hits[0]!.score).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.inject.minScore);
  });

  it("the full injection path (hybridSearch + select) returns facts under defaults", async () => {
    // This is the path context-hook.ts actually uses. select() applies
    // minScore too, so the scale bug broke injection at two points.
    const store = new InMemoryStore();
    await store.initialize();

    await store.insert({
      kind: "decision",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content: "Never commit directly to the main branch",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    const scope = buildScopePredicate("both", resolved, options);
    const inject = DEFAULT_OPTIONS.inject;

    const { hits } = await hybridSearch(
      store,
      null,
      "commit main branch",
      { channelLimit: inject.maxFacts * 3, limit: inject.maxFacts, minScore: 0 },
      { scope },
      log,
    );

    const selected = select(hits, {
      maxFacts: inject.maxFacts,
      minScore: inject.minScore,
      maxChars: inject.maxChars,
    });

    // Before the fix, select() discarded everything here.
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]!.record.content).toContain("main branch");
  });

  it("a stricter threshold narrows results and 1.0 keeps only a both-channel top hit", async () => {
    const store = new InMemoryStore();
    await store.initialize();

    for (const content of [
      "TypeScript is the primary language",
      "TypeScript strict mode is enabled everywhere",
      "Unrelated statement about database indexes",
    ]) {
      await store.insert({
        kind: "fact",
        scope: "project",
        project_id: resolved.projectID,
        worktree_key: resolved.worktreeKey,
        branch_key: resolved.branchKey,
        content,
        embedding: null,
        source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
        tags: [],
      });
    }

    const scope = buildScopePredicate("both", resolved, options);

    // No embedder -> single channel -> best hit normalizes to 0.5.
    const all = await hybridSearch(
      store, null, "TypeScript",
      { channelLimit: 10, limit: 5, minScore: 0 },
      { scope }, log,
    );
    const topOnly = await hybridSearch(
      store, null, "TypeScript",
      { channelLimit: 10, limit: 5, minScore: 1.0 },
      { scope }, log,
    );

    // The filter still bites: it narrows the set, and 1.0 (both-channel rank 0)
    // excludes everything a single-channel search can produce.
    expect(all.hits.length).toBeGreaterThan(1);
    expect(all.hits[0]!.score).toBeCloseTo(0.5, 5);
    expect(topOnly.hits.length).toBe(0);

    // Ranking is unchanged by normalization — scores are non-increasing.
    const scores = all.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("a both-channel top hit DOES survive minScore 0.9", async () => {
    // Channel agreement is the real signal: with an embedder that agrees with
    // FTS, the top hit reaches 1.0 and clears a high threshold. This is the
    // behaviour max-relative normalization would have destroyed.
    const store = new InMemoryStore();
    await store.initialize();
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content: "TypeScript is the primary language",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    const scope = buildScopePredicate("both", resolved, options);
    const result = await hybridSearch(
      store,
      makeEmbedder(),
      "TypeScript",
      { channelLimit: 10, limit: 5, minScore: 0.9 },
      { scope },
      log,
    );

    expect(result.mode).toBe("hybrid");
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.score).toBe(1.0);
  });

  it("documents the known limit: RRF cannot express absolute relevance", () => {
    // Rank-derived scores decay slowly (1/(k+rank)), so the worst-ranked
    // candidate at the default channelLimit of 18 still normalizes to ~0.39 —
    // above the 0.34 default. Anything the retriever returns therefore passes
    // the default threshold.
    //
    // This is inherent: RRF scores a rank-0 hit identically whether it is an
    // excellent or a poor match, so no rescaling can recover a relevance
    // floor. minScore is a channel-agreement gate, not a similarity floor.
    // Tightening it for real would require similarity-based scoring.
    const many = Array.from({ length: 18 }, (_, i) => hit(`m${i}`, 0));
    const normalized = normalizeRrfScores(rrfMerge(many, []));

    const worst = normalized[normalized.length - 1]!.score;
    expect(worst).toBeGreaterThan(DEFAULT_OPTIONS.inject.minScore);
    // ...but it is meaningfully below 0.5, so the scale still discriminates.
    expect(worst).toBeLessThan(0.5);
  });

  it("minScore >= 1 still returns nothing", async () => {
    const store = new InMemoryStore();
    await store.initialize();
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: resolved.projectID,
      worktree_key: resolved.worktreeKey,
      branch_key: resolved.branchKey,
      content: "A stored fact about the build pipeline",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    const scope = buildScopePredicate("both", resolved, options);
    const result = await hybridSearch(
      store, null, "build pipeline",
      { channelLimit: 10, limit: 5, minScore: 1.0 },
      { scope }, log,
    );

    expect(result.hits).toEqual([]);
  });
});
