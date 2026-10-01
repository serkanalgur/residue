/**
 * Regression tests for the FTS5 query builder.
 *
 * ## The bug
 *
 * `buildFtsQuery` (src/store/sqlite/store.ts) joined query terms with AND:
 *
 *     "what" AND "is" AND "the" AND "zorblax" AND "deployment" AND ...
 *
 * The query is an entire natural-language user prompt, not a curated keyword
 * list, so requiring every term to be present made the query unsatisfiable in
 * practice — the stopwords alone guaranteed zero matches. FTS retrieval
 * silently returned nothing for essentially every real prompt, and because the
 * failure was silent it looked identical to "no memories stored yet".
 *
 * ## The fix
 *
 * Join with OR (relying on bm25 `ORDER BY rank` for precision) and drop common
 * stopwords, with a fallback to all terms so an all-stopword query still
 * retrieves rather than matching nothing.
 *
 * @module test/fts-query
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { buildScopePredicate } from "../src/scope.js";
import type { ScopePredicate } from "../src/core/ports.js";

const RESOLVED = {
  projectID: "proj-fts",
  worktreeKey: "wk-fts",
  branchKey: "main" as string | null,
  canonicalDir: "/fts",
};

const OPTIONS = { inject: { shareAcrossWorktrees: true } };

/**
 * Fresh in-memory store with FTS initialised.
 *
 * `store.initialize()` is required, not optional: it is what sets
 * `this.fts5Available`. Calling `initSchema(db)` alone creates the FTS table
 * but leaves the store believing FTS is unavailable, so `search()` silently
 * skips the FTS branch and returns nothing.
 */
async function createStore(): Promise<SqliteStore> {
  const db = new Database(":memory:");
  const store = new SqliteStore(db, { embedder: null, readOnly: false });
  await store.initialize();
  expect(store.schemaInfo.fts5).toBe(true);
  return store;
}

const scope = (): ScopePredicate =>
  buildScopePredicate("both", RESOLVED, OPTIONS);

const FACT =
  "The zorblax deployment pipeline uses a canary rollout capped at 5 percent for the first hour";

/** Seed the store with one distinctive fact. */
async function seedOneFact(store: SqliteStore, text = FACT) {
  await store.insert({
    kind: "decision",
    scope: "project",
    project_id: RESOLVED.projectID,
    worktree_key: RESOLVED.worktreeKey,
    branch_key: RESOLVED.branchKey,
    content: text,
    embedding: null,
    source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
    tags: [],
  });
}

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

describe("FTS retrieval of natural-language questions", () => {
  it("matches a seeded fact from a question-form query", async () => {
    const store = await createStore();
    await seedOneFact(store);

    // Exactly the shape of a real user prompt: leading wh-word, stopwords,
    // and a multi-word noun phrase that appears verbatim in the memory.
    const hits = await store.search(
      "What is the zorblax deployment pipeline canary rollout cap?",
      null,
      scope(),
      10,
    );

    // Before the fix this was 0 — AND semantics made the query unsatisfiable.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.content).toBe(FACT);
    expect(hits[0]!.ftsMatch).toBe(true);
  });

  it("retrieves on the distinctive term alone", async () => {
    const store = await createStore();
    await seedOneFact(store);

    const hits = await store.search("zorblax", null, scope(), 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.content).toBe(FACT);
  });

  it("prefers the precise AND form when it matches, rather than broadening", async () => {
    // AND-first: this query's terms are all present in one record, so the
    // precise form matches and the broad OR fallback is never attempted.
    // Only the full-match record is returned — the partial "mascot logo" one
    // is correctly excluded.
    const store = await createStore();
    await seedOneFact(store, "The zorblax deployment pipeline uses a canary rollout capped at 5 percent");
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Unrelated notes about the zorblax mascot logo colours",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    const hits = await store.search(
      "zorblax deployment pipeline canary rollout",
      null,
      scope(),
      10,
    );

    expect(hits.length).toBe(1);
    expect(hits[0]!.record.content).toContain("canary rollout");
  });

  it("keeps identifier-style queries exact (the concurrency-test case)", async () => {
    // Searching "worker-A" over records worker-A-* and worker-B-* must return
    // only the A records. Pure OR broke this by dropping the discriminating
    // token "A" as a stopword and matching everything.
    const store = await createStore();
    for (const w of ["A", "B"]) {
      for (let i = 0; i < 5; i++) {
        await store.insert({
          kind: "fact",
          scope: "project",
          project_id: RESOLVED.projectID,
          worktree_key: RESOLVED.worktreeKey,
          branch_key: RESOLVED.branchKey,
          content: `worker-${w}-${i}`,
          embedding: null,
          source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
          tags: [],
        });
      }
    }

    const a = await store.search("worker-A", null, scope(), 50);
    const b = await store.search("worker-B", null, scope(), 50);

    expect(a.length).toBe(5);
    expect(b.length).toBe(5);
    expect(a.every((h) => h.record.content.includes("worker-A"))).toBe(true);
    expect(b.every((h) => h.record.content.includes("worker-B"))).toBe(true);
  });

  it("scores a strong match meaningfully above a weak one (no saturation)", async () => {
    // Regression: `1/(1+|rank|)` assumed bm25 magnitudes of order 1, but
    // FTS5 returns ~1e-6, so EVERY hit scored ~0.9999 and the score carried
    // no information. Scores are now normalised against the best rank in the
    // result set, so a strong match must clearly outrank a weak one.
    const store = await createStore();
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content:
        "The zorblax deployment pipeline uses a canary rollout capped at 5 percent for the first hour",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });
    await store.insert({
      kind: "fact",
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: "Unrelated notes about the zorblax mascot logo colours",
      embedding: null,
      source: { sessionID: "ses-1", timestamp: new Date().toISOString() },
      tags: [],
    });

    // OR query so both records are candidates.
    const hits = await store.search(
      "zorblax OR deployment OR pipeline OR canary OR rollout OR mascot",
      null,
      scope(),
      10,
    );

    expect(hits.length).toBe(2);

    const strong = hits.find((h) => h.record.content.includes("canary rollout"));
    const weak = hits.find((h) => h.record.content.includes("mascot logo"));
    expect(strong).toBeDefined();
    expect(weak).toBeDefined();

    // The strong match must be ranked first, with a meaningful margin.
    expect(hits[0]!.record.content).toContain("canary rollout");
    expect(strong!.score).toBeCloseTo(1.0, 5);
    expect(strong!.score).toBeGreaterThan(weak!.score);
    // A real gap — the old formula produced < 0.01 separation here.
    expect(strong!.score - weak!.score).toBeGreaterThan(0.1);
    // Still within the documented 0-1 range.
    expect(strong!.score).toBeLessThanOrEqual(1);
    expect(weak!.score).toBeGreaterThanOrEqual(0);
  });

  it("remaps bm25 onto 0-1 relative to the best rank, not the raw magnitude", () => {
    // Guards the remap directly: raw bm25 is ~1e-6 and corpus-dependent, so
    // the old formula saturated. Normalising against the best rank makes the
    // top hit exactly 1.0 regardless of absolute magnitude.
    const db = new Database(":memory:");
    db.run("CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, text, tokenize='unicode61')");
    db.run("INSERT INTO t (id,text) VALUES (?,?)", [
      "a",
      "The zorblax deployment pipeline uses a canary rollout capped at 5 percent",
    ]);
    db.run("INSERT INTO t (id,text) VALUES (?,?)", [
      "b",
      "Unrelated notes about the zorblax mascot logo colours",
    ]);

    const rows = db
      .query("SELECT id, rank FROM t WHERE t MATCH ? ORDER BY rank")
      .all('"zorblax" OR "deployment" OR "pipeline" OR "canary" OR "rollout"') as Array<{
      id: string;
      rank: number;
    }>;

    expect(rows).toHaveLength(2);
    // Raw magnitudes are tiny — the premise of the old bug.
    expect(Math.abs(rows[0]!.rank)).toBeLessThan(0.01);

    // Replicate the remap: score = rank / bestRank (both negative).
    const best = rows[0]!.rank; // most negative = best match
    const scores = rows.map((r) => r.rank / best);

    expect(scores[0]).toBeCloseTo(1.0, 10);
    // The weak match is now clearly below the strong one (old formula: ~0).
    expect(scores[1]).toBeGreaterThanOrEqual(0);
    expect(scores[1]).toBeLessThan(scores[0]!);
  });

  it("does not return unrelated records for a stopword-only query", async () => {
    const store = await createStore();
    await seedOneFact(store);

    // "what is the" carries no signal; must not match everything.
    const hits = await store.search("what is the", null, scope(), 10);
    expect(hits.length).toBe(0);
  });

  it("still matches when a query is all stopwords plus one real term", async () => {
    const store = await createStore();
    await seedOneFact(store);

    const hits = await store.search("what is the zorblax", null, scope(), 10);
    expect(hits.length).toBe(1);
  });

  it("handles punctuation and empty queries without throwing", async () => {
    const store = await createStore();
    await seedOneFact(store);

    expect((await store.search("what?!", null, scope(), 10)).length).toBe(0);
    expect((await store.search("", null, scope(), 10)).length).toBe(0);
    expect((await store.search("   ", null, scope(), 10)).length).toBe(0);
  });

  it("does not let user text inject FTS5 syntax", async () => {
    const store = await createStore();
    await seedOneFact(store);

    // A query full of FTS5 operators must be treated as literal terms, not
    // syntax — each term is double-quoted before joining.
    const hits = await store.search(
      'zorblax" OR "canary* NEAR/',
      null,
      scope(),
      10,
    );
    // No crash, and no error thrown out of search().
    expect(Array.isArray(hits)).toBe(true);
  });
});
