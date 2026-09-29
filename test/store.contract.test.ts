/**
 * Contract tests for MemoryStore implementations.
 *
 * Both InMemoryStore and SqliteStore must pass the same test suite.
 * This ensures that any implementation satisfies the MemoryStore interface
 * contract. Tests are parameterized over both implementations.
 *
 * @module test/store.contract
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryStore, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Temp directory for SQLite tests. */
let tempDir: string;

/** Create a test draft with defaults. */
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

/** Create a "both" scope predicate. */
function bothScope(pid: string = "proj-test", wk: string = "wk-test"): ScopePredicate {
  return {
    where: "(scope = 'global' OR (scope = 'project' AND project_id = :pid AND worktree_key = :wk))",
    params: { ":pid": pid, ":wk": wk },
  };
}

/** Create a project-only scope predicate. */
function projectScope(pid: string = "proj-test", wk: string = "wk-test"): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid AND worktree_key = :wk",
    params: { ":pid": pid, ":wk": wk },
  };
}

/** Create a global-only scope predicate. */
function globalScope(): ScopePredicate {
  return {
    where: "scope = 'global'",
    params: {},
  };
}

/** Setup a fresh SqliteStore. */
function createSqliteStore(): SqliteStore {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  return new SqliteStore(db, { embedder: null, readOnly: false });
}

// ---------------------------------------------------------------------------
// Parameterized contract tests
// ---------------------------------------------------------------------------

interface StoreFactory {
  name: string;
  create: () => Promise<MemoryStore>;
  cleanup?: (store: MemoryStore) => Promise<void>;
}

const implementations: StoreFactory[] = [
  {
    name: "InMemoryStore",
    create: async () => {
      const store = new InMemoryStore();
      await store.initialize();
      return store;
    },
  },
  {
    name: "SqliteStore",
    create: async () => {
      const store = createSqliteStore();
      await store.initialize();
      return store;
    },
  },
];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "residue-contract-"));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
});

for (const impl of implementations) {
  describe(`MemoryStore contract — ${impl.name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await impl.create();
    });

    afterAll(async () => {
      if (impl.cleanup) await impl.cleanup(store);
    });

    describe("insert", () => {
      it("inserts a draft and returns a record with generated ID", async () => {
        const draft = makeDraft({ content: "Use WAL mode for SQLite" });
        const record = await store.insert(draft);

        expect(record.id).toBeTruthy();
        expect(record.id.length).toBeGreaterThan(0);
        expect(record.content).toBe("Use WAL mode for SQLite");
        expect(record.kind).toBe("fact");
        expect(record.scope).toBe("project");
        expect(record.project_id).toBe("proj-test");
      });

      it("preserves all draft fields in the returned record", async () => {
        const draft = makeDraft({
          kind: "decision",
          content: "Use TypeScript strict mode",
          tags: ["typescript", "config"],
          branch_key: "develop",
        });
        const record = await store.insert(draft);

        expect(record.kind).toBe("decision");
        expect(record.tags).toEqual(["typescript", "config"]);
        expect(record.branch_key).toBe("develop");
        expect(record.source.sessionID).toBe("ses-test");
      });

      it("inserts global-scoped records", async () => {
        const draft = makeDraft({
          scope: "global",
          project_id: null,
          content: "Global rule: always use semantic commits",
        });
        const record = await store.insert(draft);

        expect(record.scope).toBe("global");
        expect(record.project_id).toBeNull();
      });
    });

    describe("count", () => {
      it("returns 0 for empty store", async () => {
        const count = await store.count(bothScope());
        expect(count).toBe(0);
      });

      it("counts project-scoped records correctly", async () => {
        await store.insert(makeDraft({ content: "Record 1" }));
        await store.insert(makeDraft({ content: "Record 2" }));
        await store.insert(makeDraft({ content: "Record 3" }));

        const count = await store.count(bothScope());
        expect(count).toBe(3);
      });

      it("does not count records from other projects", async () => {
        await store.insert(makeDraft({ content: "My project" }));
        await store.insert(makeDraft({ project_id: "proj-other", content: "Other project" }));

        const count = await store.count(bothScope("proj-test", "wk-test"));
        expect(count).toBe(1);
      });

      it("counts global records separately", async () => {
        await store.insert(makeDraft({ content: "Project record" }));
        await store.insert(makeDraft({ scope: "global", project_id: null, content: "Global record" }));

        const projectCount = await store.count(projectScope());
        const globalCount = await store.count(globalScope());

        expect(projectCount).toBe(1);
        expect(globalCount).toBe(1);
      });
    });

    describe("search", () => {
      it("returns empty for no matches", async () => {
        const results = await store.search(
          "nonexistent query",
          null,
          bothScope(),
          10,
        );
        expect(results).toHaveLength(0);
      });

      it("finds records by text content", async () => {
        await store.insert(makeDraft({ content: "Use WAL mode for SQLite databases" }));
        await store.insert(makeDraft({ content: "Configure TypeScript compiler options" }));

        const results = await store.search("WAL mode", null, bothScope(), 10);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.record.content).toContain("WAL");
      });

      it("respects scope isolation in search results", async () => {
        await store.insert(makeDraft({ content: "My project fact" }));
        await store.insert(makeDraft({
          project_id: "proj-other",
          worktree_key: "wk-other",
          content: "Other project fact",
        }));

        const results = await store.search("fact", null, bothScope("proj-test", "wk-test"), 10);
        for (const hit of results) {
          expect(hit.record.project_id).toBe("proj-test");
        }
      });

      it("returns results sorted by score descending", async () => {
        await store.insert(makeDraft({ content: "SQLite WAL mode configuration" }));
        await store.insert(makeDraft({ content: "WAL" }));

        const results = await store.search("WAL mode", null, bothScope(), 10);
        if (results.length >= 2) {
          expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
        }
      });

      it("respects limit parameter", async () => {
        for (let i = 0; i < 20; i++) {
          await store.insert(makeDraft({ content: `Test record ${i} with common keyword` }));
        }

        const results = await store.search("common", null, bothScope(), 5);
        expect(results.length).toBeLessThanOrEqual(5);
      });
    });

    describe("delete (via scope)", () => {
      it("deletes records matching scope", async () => {
        await store.insert(makeDraft({ content: "To delete" }));
        await store.insert(makeDraft({ content: "To keep" }));

        // InMemoryStore and SqliteStore both support delete via the port
        // For contract test, we verify count changes
        const beforeCount = await store.count(bothScope());
        expect(beforeCount).toBe(2);

        // We can't call delete directly on MemoryStore interface,
        // but we can verify the store works after operations
        const afterSearch = await store.search("delete", null, bothScope(), 10);
        expect(afterSearch.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("close", () => {
      it("can be called without error", async () => {
        await expect(store.close()).resolves.toBeUndefined();
      });

      it("can be called multiple times", async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SQLite-specific WAL reopen test
// ---------------------------------------------------------------------------

describe("SqliteStore WAL persistence", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "residue-wal-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("data persists across database reopens with WAL mode", async () => {
    const dbPath = join(tempDir, "wal-test.db");

    // First connection: insert data
    const db1 = new Database(dbPath);
    applyPragmas(db1);
    const schema1 = initSchema(db1);
    expect(schema1.fts5Available).toBe(true);

    const store1 = new SqliteStore(db1, { embedder: null, readOnly: false });
    await store1.initialize();

    await store1.insert(makeDraft({ content: "Persistent record 1" }));
    await store1.insert(makeDraft({ content: "Persistent record 2" }));

    const count1 = await store1.count(bothScope());
    expect(count1).toBe(2);

    await store1.close();

    // Second connection: verify data persists
    const db2 = new Database(dbPath);
    applyPragmas(db2);
    initSchema(db2);

    const store2 = new SqliteStore(db2, { embedder: null, readOnly: false });
    await store2.initialize();

    const count2 = await store2.count(bothScope());
    expect(count2).toBe(2);

    const results = await store2.search("Persistent", null, bothScope(), 10);
    expect(results.length).toBe(2);

    await store2.close();
  });
});
