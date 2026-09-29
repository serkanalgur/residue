/**
 * Scope isolation leak tests — SQL-level and database-level.
 *
 * Tests both the in-memory `matchesScope` function AND actual SQL queries
 * against a real SQLite database to verify that cross-project data leakage
 * is impossible.
 *
 * Includes SQL injection tests with malicious input that must not corrupt
 * the database or bypass scope isolation.
 *
 * @module test/store.leak
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { matchesScope } from "../src/scope.js";
import { buildScopePredicate } from "../src/scope.js";
import type { ResolvedScope } from "../src/core/ports.js";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryDraft } from "../src/core/types.js";

/** Generate a random project ID. */
function randomProjectId(): string {
  return `proj-${randomBytes(8).toString("hex")}`;
}

/** Generate a random worktree key. */
function randomWorktreeKey(): string {
  return `wk-${randomBytes(8).toString("hex")}`;
}

/** Create a test draft. */
function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: "fact",
    scope: "project",
    project_id: "proj-test",
    worktree_key: "wk-test",
    branch_key: "main",
    content: "Test content",
    embedding: null,
    source: {
      sessionID: "ses-test",
      timestamp: new Date().toISOString(),
    },
    tags: ["test"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory matchesScope tests (existing, enhanced)
// ---------------------------------------------------------------------------

describe("scope isolation (200 random combinations)", () => {
  const options = { inject: { shareAcrossWorktrees: false } };
  const sharedOptions = { inject: { shareAcrossWorktrees: true } };

  it("no cross-project leakage without worktree sharing", () => {
    for (let i = 0; i < 200; i++) {
      const projectA = randomProjectId();
      const projectB = randomProjectId();
      const worktreeA = randomWorktreeKey();
      const worktreeB = randomWorktreeKey();

      const scopeA: ResolvedScope = {
        projectID: projectA,
        worktreeKey: worktreeA,
        branchKey: "main",
        canonicalDir: "/workspace/a",
      };

      const scopeB: ResolvedScope = {
        projectID: projectB,
        worktreeKey: worktreeB,
        branchKey: "main",
        canonicalDir: "/workspace/b",
      };

      const recordA = {
        scope: "project" as const,
        project_id: projectA,
        worktree_key: worktreeA,
      };

      const recordB = {
        scope: "project" as const,
        project_id: projectB,
        worktree_key: worktreeB,
      };

      expect(matchesScope(recordA, scopeB, options)).toBe(false);
      expect(matchesScope(recordB, scopeA, options)).toBe(false);
      expect(matchesScope(recordA, scopeA, options)).toBe(true);
      expect(matchesScope(recordB, scopeB, options)).toBe(true);
    }
  });

  it("no cross-project leakage with worktree sharing enabled", () => {
    for (let i = 0; i < 200; i++) {
      const projectA = randomProjectId();
      const projectB = randomProjectId();
      const worktreeA = randomWorktreeKey();
      const worktreeB = randomWorktreeKey();

      const scopeA: ResolvedScope = {
        projectID: projectA,
        worktreeKey: worktreeA,
        branchKey: "main",
        canonicalDir: "/workspace/a",
      };

      const scopeB: ResolvedScope = {
        projectID: projectB,
        worktreeKey: worktreeB,
        branchKey: "main",
        canonicalDir: "/workspace/b",
      };

      const recordA = {
        scope: "project" as const,
        project_id: projectA,
        worktree_key: worktreeA,
      };

      const recordB = {
        scope: "project" as const,
        project_id: projectB,
        worktree_key: worktreeB,
      };

      expect(matchesScope(recordA, scopeB, sharedOptions)).toBe(false);
      expect(matchesScope(recordB, scopeA, sharedOptions)).toBe(false);
      expect(matchesScope(recordA, scopeA, sharedOptions)).toBe(true);
      expect(matchesScope(recordB, scopeB, sharedOptions)).toBe(true);
    }
  });

  it("global records are visible to all scopes", () => {
    for (let i = 0; i < 200; i++) {
      const scope: ResolvedScope = {
        projectID: randomProjectId(),
        worktreeKey: randomWorktreeKey(),
        branchKey: null,
        canonicalDir: "/workspace/x",
      };

      const globalRecord = {
        scope: "global" as const,
        project_id: null,
        worktree_key: "any",
      };

      expect(matchesScope(globalRecord, scope, options)).toBe(true);
      expect(matchesScope(globalRecord, scope, sharedOptions)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SQL-level leak tests with real database
// ---------------------------------------------------------------------------

describe("SQL-level scope isolation (real SQLite)", () => {
  let db: Database;
  let store: SqliteStore;

  beforeAll(async () => {
    db = new Database(":memory:");
    applyPragmas(db);
    initSchema(db);
    store = new SqliteStore(db, { embedder: null, readOnly: false });
    await store.initialize();
  });

  afterAll(async () => {
    await store.close();
  });

  it("inserts records for 200 different projects and verifies zero cross-project leakage", async () => {
    const projects: Array<{ pid: string; wk: string; content: string }> = [];

    // Insert records for 200 different projects
    for (let i = 0; i < 200; i++) {
      const pid = randomProjectId();
      const wk = randomWorktreeKey();
      const content = `secret-fact-${i}`;
      projects.push({ pid, wk, content });

      await store.insert(makeDraft({
        project_id: pid,
        worktree_key: wk,
        content,
      }));
    }

    // For each project, verify that only its own records are visible
    for (const { pid, wk, content } of projects) {
      const scope = buildScopePredicate("both", {
        projectID: pid,
        worktreeKey: wk,
        branchKey: null,
        canonicalDir: "/tmp",
      }, { inject: { shareAcrossWorktrees: false } });

      const count = await store.count(scope);
      expect(count).toBe(1);

      // FTS5 unicode61 tokenizer splits on hyphens, so use the first
      // segment (which is unique per project) for the search query.
      const searchTerms = content.split("-");
      const results = await store.search(searchTerms[0]!, null, scope, 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.record.content).toBe(content);
      expect(results[0]!.record.project_id).toBe(pid);
    }

    // Verify total count is correct — sum individual project counts
    // (Can't query all projects at once due to scope isolation)
    let totalFound = 0;
    for (const { pid, wk } of projects) {
      const cnt = await store.count(
        buildScopePredicate("both", {
          projectID: pid,
          worktreeKey: wk,
          branchKey: null,
          canonicalDir: "/tmp",
        }, { inject: { shareAcrossWorktrees: false } }),
      );
      totalFound += cnt;
    }
    expect(totalFound).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// SQL injection tests
// ---------------------------------------------------------------------------

describe("SQL injection resistance", () => {
  let db: Database;
  let store: SqliteStore;

  beforeAll(async () => {
    db = new Database(":memory:");
    applyPragmas(db);
    initSchema(db);
    store = new SqliteStore(db, { embedder: null, readOnly: false });
    await store.initialize();
  });

  afterAll(async () => {
    await store.close();
  });

  const injectionPayloads = [
    "'; DROP TABLE memory; --",
    "1' OR '1'='1",
    "admin'--",
    "'; INSERT INTO memory (id, text) VALUES ('hacked', 'pwned'); --",
    "1; DELETE FROM memory WHERE 1=1; --",
    "' UNION SELECT * FROM memory; --",
    "0 OR 1=1",
    "'; UPDATE memory SET scope='global' WHERE 1=1; --",
    "Robert'); DROP TABLE Students;--",
    "\\' OR \\'1\\'=\\'1",
    "memory' OR '1'='1' /*",
    "*/; DROP TABLE memory; /*",
    "'; PRAGMA journal_mode=DELETE; --",
    "1' AND (SELECT COUNT(*) FROM memory) > 0 AND '1'='1",
  ];

  it("all injection payloads are safely handled as content", async () => {
    for (const payload of injectionPayloads) {
      // Insert with malicious content
      const record = await store.insert(makeDraft({
        content: payload,
        project_id: "proj-injection-test",
        worktree_key: "wk-injection-test",
      }));

      // Content should be stored verbatim
      expect(record.content).toBe(payload);

      // Verify record exists via count (not search — FTS5 tokenization
      // may not match special characters in injection payloads)
      const scope = {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-injection-test" } as Record<string, string | null>,
      };

      // Search should not crash — even if it returns 0 results (FTS5 may
      // not tokenize injection payloads), it must not throw
      const results = await store.search(payload, null, scope, 10);
      // No assertion on results.length — FTS5 may or may not match
      void results;
    }

    // Verify the memory table still exists and is intact
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-injection-test" },
    });
    expect(count).toBe(injectionPayloads.length);
  });

  it("scope predicate params prevent injection via project_id", async () => {
    const maliciousPid = "'; DROP TABLE memory; --";
    const maliciousWk = "1' OR '1'='1";

    // Insert a legitimate record
    await store.insert(makeDraft({
      project_id: "proj-legit",
      worktree_key: "wk-legit",
      content: "legitimate fact",
    }));

    // Try to query with malicious scope — should return 0 results, not crash
    const scope = buildScopePredicate("both", {
      projectID: maliciousPid,
      worktreeKey: maliciousWk,
      branchKey: null,
      canonicalDir: "/tmp",
    }, { inject: { shareAcrossWorktrees: false } });

    const count = await store.count(scope);
    expect(count).toBe(0);

    // Legitimate records should still be intact
    const legitScope = buildScopePredicate("both", {
      projectID: "proj-legit",
      worktreeKey: "wk-legit",
      branchKey: null,
      canonicalDir: "/tmp",
    }, { inject: { shareAcrossWorktrees: false } });

    const legitCount = await store.count(legitScope);
    expect(legitCount).toBe(1);
  });

  it("search with injection payloads does not corrupt results or database", async () => {
    // Search with malicious query should not crash — FTS5 may or may not match
    const results = await store.search(
      "'; DROP TABLE memory; --",
      null,
      {
        where: "scope = 'project' AND project_id = :pid",
        params: { ":pid": "proj-injection-test" },
      },
      10,
    );
    // No crash = success. FTS5 tokenization of special chars may yield 0 results.
    void results;

    // Verify the table still exists and records are intact
    const count = await store.count({
      where: "scope = 'project' AND project_id = :pid",
      params: { ":pid": "proj-injection-test" },
    });
    expect(count).toBe(injectionPayloads.length);
  });
});
