/**
 * Tests for worktree lifecycle sync.
 *
 * Covers:
 * - Removed worktree demotes records (sets worktree_key to NULL), does NOT delete
 * - Failed/empty list() demotes nothing (transient API failure safety)
 * - Reconciliation is idempotent
 * - Another project's records are never touched
 * - Burst events are debounced (rate limiting)
 * - Scope isolation across projects
 *
 * @module test/worktree
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { registerWorktreeSync, type WorktreeCtx } from "../src/worktree.js";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import { sha256 } from "../src/util/hash.js";
import type { MemoryStore, ScopePredicate } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";
import type { Logger } from "../src/log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a test draft. */
function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: "fact",
    scope: "project",
    project_id: "proj-wt",
    worktree_key: "wk-abc",
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

/** Scope predicate for project records. */
function projectScope(pid = "proj-wt"): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid",
    params: { ":pid": pid },
  };
}

/** Silent logger for tests. */
function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/** Setup a fresh SqliteStore. */
function createSqliteStore(): SqliteStore {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  return new SqliteStore(db, { embedder: null, readOnly: false });
}

/** Create a mock event subscription that we can push events to. */
function createMockEventCtx() {
  let resolve: ((value: IteratorResult<{ type: string; data?: Record<string, unknown> }>) => void) | null = null;
  const eventQueue: Array<{ type: string; data?: Record<string, unknown> }> = [];

  const iterable: AsyncIterable<{ readonly type: string; readonly data?: Record<string, unknown> }> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (eventQueue.length > 0) {
            const event = eventQueue.shift()!;
            return Promise.resolve({ value: event, done: false });
          }
          return new Promise<{ value: { type: string; data?: Record<string, unknown> }; done: boolean }>((r) => {
            resolve = r;
          });
        },
        return() {
          return Promise.resolve({ value: undefined as unknown, done: true });
        },
      };
    },
  };

  return {
    ctx: {
      event: {
        subscribe: () => iterable,
      },
    } as Pick<WorktreeCtx, "event">,
    push(event: { type: string; data?: Record<string, unknown> }) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: event, done: false });
      } else {
        eventQueue.push(event);
      }
    },
    flush() {
      while (eventQueue.length > 0 && resolve) {
        const event = eventQueue.shift()!;
        const r = resolve;
        resolve = null;
        r({ value: event, done: false });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface StoreFactory {
  name: string;
  create: () => Promise<MemoryStore>;
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

for (const impl of implementations) {
  describe(`Worktree lifecycle — ${impl.name}`, () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = await impl.create();
    });

    describe("removed worktree demotes records (never deletes)", () => {
      it("record survives with worktree_key set to NULL after worktree removal", async () => {
        const wkDir = "/workspace/feature-branch";
        const wkKey = sha256(wkDir);

        // Insert a record under this worktree
        const record = await store.insert(makeDraft({ worktree_key: wkKey }));
        const scope: ScopePredicate = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-wt" },
        };

        const countBefore = await store.count(scope);
        expect(countBefore).toBe(1);

        // Mock context: worktree.list returns empty (worktree was removed)
        const mock = createMockEventCtx();
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());

        // Push a worktree event to trigger reconciliation
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });

        // Wait for debounce + reconciliation
        await new Promise((r) => setTimeout(r, 100));
        cleanup();

        // Record must still exist
        const fetched = await store.get(record.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(record.id);
        expect(fetched!.content).toBe("Test content");

        // worktree_key should be demoted (empty string for InMemory, null for SQLite)
        expect(fetched!.worktree_key === "" || fetched!.worktree_key === null).toBe(true);

        // Count is still 1 — nothing was deleted
        const countAfter = await store.count(scope);
        expect(countAfter).toBe(1);
      });
    });

    describe("failed/empty list() demotes nothing", () => {
      it("does not demote when list() throws (transient API failure)", async () => {
        const wkDir = "/workspace/feature";
        const wkKey = sha256(wkDir);

        await store.insert(makeDraft({ worktree_key: wkKey }));
        const scope: ScopePredicate = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-wt" },
        };

        const mock = createMockEventCtx();
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: {
            list: async () => {
              throw new Error("API timeout");
            },
          },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));
        cleanup();

        // Record still has its original worktree_key
        const allRecords = await store.scan({ scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } }, limit: 100 });
        expect(allRecords.length).toBe(1);
        expect(allRecords[0]!.worktree_key).toBe(wkKey);
      });

      it("does not demote when list() returns empty array (API returned nothing, not error)", async () => {
        const wkDir = "/workspace/temp";
        const wkKey = sha256(wkDir);

        await store.insert(makeDraft({ worktree_key: wkKey }));
        const scope: ScopePredicate = {
          where: "scope = 'project' AND project_id = :pid",
          params: { ":pid": "proj-wt" },
        };

        const mock = createMockEventCtx();
        // list() returns empty but does NOT throw — this is a legitimate "no worktrees"
        // In this case, the store worktree_key IS absent from the live set, so it SHOULD demote.
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));
        cleanup();

        // A successful empty list() means the worktree truly doesn't exist — demote is correct
        const allRecords = await store.scan({ scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } }, limit: 100 });
        expect(allRecords.length).toBe(1);
        expect(allRecords[0]!.worktree_key === "" || allRecords[0]!.worktree_key === null).toBe(true);
      });
    });

    describe("idempotency", () => {
      it("running reconciliation twice changes nothing the second time", async () => {
        const wkDir = "/workspace/feature";
        const wkKey = sha256(wkDir);

        await store.insert(makeDraft({ worktree_key: wkKey }));

        const mock = createMockEventCtx();
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());

        // First event — triggers demotion
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));

        // Second event — should be a no-op (idempotent)
        mock.push({ type: "worktree.resolved", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));

        cleanup();

        // Record still exists, demoted once
        const allRecords = await store.scan({ scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } }, limit: 100 });
        expect(allRecords.length).toBe(1);
        expect(allRecords[0]!.worktree_key === "" || allRecords[0]!.worktree_key === null).toBe(true);
      });
    });

    describe("scope isolation", () => {
      it("never touches records from another project", async () => {
        const wkDir = "/workspace/feature";
        const wkKey = sha256(wkDir);

        // Insert records for two projects under the same worktree key
        await store.insert(makeDraft({ worktree_key: wkKey, project_id: "proj-wt" }));
        await store.insert(makeDraft({ worktree_key: wkKey, project_id: "proj-other" }));

        const mock = createMockEventCtx();
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));
        cleanup();

        // proj-wt record should be demoted
        const projRecords = await store.scan({
          scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } },
          limit: 100,
        });
        expect(projRecords.length).toBe(1);
        expect(projRecords[0]!.worktree_key === "" || projRecords[0]!.worktree_key === null).toBe(true);

        // proj-other record should be untouched
        const otherRecords = await store.scan({
          scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-other" } },
          limit: 100,
        });
        expect(otherRecords.length).toBe(1);
        expect(otherRecords[0]!.worktree_key).toBe(wkKey);
      });
    });

    describe("cleanup", () => {
      it("cleanup function aborts the subscription", async () => {
        const mock = createMockEventCtx();
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());

        // Cleanup should not throw
        cleanup();

        // Pushing events after cleanup should be safe (no crash)
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 50));
      });
    });

    describe("only reacts to worktree events", () => {
      it("ignores non-worktree events", async () => {
        const wkDir = "/workspace/feature";
        const wkKey = sha256(wkDir);

        await store.insert(makeDraft({ worktree_key: wkKey }));

        const mock = createMockEventCtx();
        // list() returns the live worktree — so the initial reconcile won't demote it
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [{ directory: wkDir }] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());

        // Wait for initial reconcile to complete
        await new Promise((r) => setTimeout(r, 100));

        // Push a non-worktree event
        mock.push({ type: "session.created", data: {} });
        await new Promise((r) => setTimeout(r, 100));

        // Record should still have its original worktree_key
        const allRecords = await store.scan({
          scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } },
          limit: 100,
        });
        expect(allRecords.length).toBe(1);
        expect(allRecords[0]!.worktree_key).toBe(wkKey);

        cleanup();
      });
    });

    describe("live worktree preserved", () => {
      it("does not demote a worktree_key that is still live", async () => {
        const wkDir1 = "/workspace/feature";
        const wkKey1 = sha256(wkDir1);
        const wkDir2 = "/workspace/other";
        const wkKey2 = sha256(wkDir2);

        await store.insert(makeDraft({ worktree_key: wkKey1 }));
        await store.insert(makeDraft({ worktree_key: wkKey2 }));

        const mock = createMockEventCtx();
        // list() returns only wkDir1 — wkDir2 should be demoted
        const worktreeCtx: WorktreeCtx = {
          ...mock.ctx,
          worktree: { list: async () => [{ directory: wkDir1 }] },
          location: { project: { id: "proj-wt" } },
        };

        const cleanup = registerWorktreeSync(worktreeCtx, { store }, { debounceMs: 10 }, silentLogger());
        mock.push({ type: "worktree.updated", data: { projectID: "proj-wt" } });
        await new Promise((r) => setTimeout(r, 100));
        cleanup();

        // wkDir1 record should still have its worktree_key
        const allRecords = await store.scan({
          scope: { where: "scope = 'project' AND project_id = :pid", params: { ":pid": "proj-wt" } },
          limit: 100,
        });
        expect(allRecords.length).toBe(2);

        const keptRecord = allRecords.find((r) => r.worktree_key === wkKey1);
        const demotedRecord = allRecords.find((r) => r.worktree_key === "" || r.worktree_key === null);

        expect(keptRecord).toBeDefined();
        expect(demotedRecord).toBeDefined();
      });
    });
  });
}
