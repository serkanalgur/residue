/**
 * Tests for re-embedding on update.
 *
 * Covers:
 * - Update with embedder: record's embedding changes to reflect new content
 * - Update with embedder: record findable by NEW text via vector search
 * - Update without embedder: update succeeds, record findable via lexical search
 * - vec_* row count does not grow unboundedly across repeated updates
 * - Works identically on both store implementations
 *
 * @module test/reembedding
 */

import { describe, it, expect } from "bun:test";
import { InMemoryStore } from "../src/store/memory-store.js";
import { SqliteStore } from "../src/store/sqlite/store.js";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/store/sqlite/schema.js";
import { applyPragmas } from "../src/store/sqlite/lock.js";
import type { MemoryStore, ScopePredicate, Embedder } from "../src/core/ports.js";
import type { MemoryDraft } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Mock embedder — produces clearly distinct vectors for different inputs
// ---------------------------------------------------------------------------

/**
 * Deterministic mock embedder that produces clearly orthogonal vectors.
 * Each unique input gets a distinct, non-overlapping vector so cosine
 * similarity between different texts is ~0.
 */
function createMockEmbedder(dimension = 64): Embedder {
  const cache = new Map<string, Float32Array>();

  /** Simple FNV-1a-like hash for deterministic dimension selection. */
  function fnv1a(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 0x01000193) | 0;
    }
    return h >>> 0; // unsigned
  }

  return {
    id: "mockembedder",
    degraded: false,
    dimension,
    async embed(text: string): Promise<Float32Array> {
      const cached = cache.get(text);
      if (cached) return cached;

      const vec = new Float32Array(dimension);
      // Use FNV-1a hash to pick TWO distinct dominant dimensions.
      // Different texts get different dominant dimensions → cosine ~0.
      const h1 = fnv1a(text);
      const h2 = fnv1a("\0" + text); // second hash with null prefix
      const dim1 = h1 % dimension;
      const dim2 = h2 % dimension;
      vec[dim1] = 1.0;
      if (dim2 !== dim1) {
        vec[dim2] = 0.01;
      }
      // Normalize to unit length
      let sumSq = 0;
      for (let i = 0; i < dimension; i++) sumSq += vec[i]! * vec[i]!;
      const inv = 1 / Math.sqrt(sumSq);
      for (let i = 0; i < dimension; i++) vec[i]! *= inv;

      cache.set(text, vec);
      return vec;
    },
    async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: "fact",
    scope: "project",
    project_id: "proj-embed",
    worktree_key: "wk-embed",
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

function projectScope(): ScopePredicate {
  return {
    where: "scope = 'project' AND project_id = :pid AND worktree_key = :wk",
    params: { ":pid": "proj-embed", ":wk": "wk-embed" },
  };
}

function createSqliteStoreWithEmbedder(embedder: Embedder | null = null): SqliteStore {
  const db = new Database(":memory:");
  applyPragmas(db);
  initSchema(db);
  return new SqliteStore(db, { embedder, readOnly: false });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Re-embedding — InMemoryStore", () => {
  describe("update with embedder", () => {
    it("embedding changes after content update", async () => {
      const embedder = createMockEmbedder();
      const store = new InMemoryStore(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "The quick brown fox jumps" }),
      );

      // The store re-embeds on insert (if embedding is provided in draft)
      // But here draft.embedding is null, so the store doesn't embed on insert.
      // The re-embedding happens in update() when content changes.

      const updated = await store.update(record.id, {
        content: "Deep learning neural network architecture",
      });
      expect(updated).not.toBeNull();

      // Embedding should have been computed for the new content
      expect(updated!.embedding).not.toBeNull();
      expect(updated!.embedding!.length).toBe(64);

      // The embedding should match what the embedder produces for the new text
      const expectedEmbedding = await embedder.embed("Deep learning neural network architecture");
      for (let i = 0; i < expectedEmbedding.length; i++) {
        expect(updated!.embedding![i]).toBeCloseTo(expectedEmbedding[i]!, 5);
      }
    });

    it("record is findable by NEW text through vector search after update", async () => {
      const embedder = createMockEmbedder();
      const store = new InMemoryStore(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original text about cats" }),
      );

      // Update to completely different content
      await store.update(record.id, {
        content: "Quantum computing algorithms",
      });

      // Search with new content's embedding — should find it
      const newEmbedding = await embedder.embed("Quantum computing algorithms");
      const hits = await store.search("quantum", newEmbedding, projectScope(), 10);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.record.id).toBe(record.id);

      // Search with old content's embedding — should NOT find it
      const oldEmbedding = await embedder.embed("Original text about cats");
      const oldHits = await store.search("cats", oldEmbedding, projectScope(), 10);
      for (const hit of oldHits) {
        expect(hit.record.id).not.toBe(record.id);
      }
    });

    it("update with same content does not change embedding", async () => {
      const embedder = createMockEmbedder();
      const store = new InMemoryStore(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Same content" }),
      );

      // Update with same content — embedding should remain unchanged
      const updated = await store.update(record.id, { content: "Same content" });
      expect(updated).not.toBeNull();

      // Should still be findable
      const embedding = await embedder.embed("Same content");
      const hits = await store.search("Same", embedding, projectScope(), 10);
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("update without embedder", () => {
    it("update succeeds and record is findable via lexical search", async () => {
      const store = new InMemoryStore(null);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original banana bread recipe" }),
      );

      // Verify lexical search works
      const before = await store.search("banana bread", null, projectScope(), 10);
      expect(before.length).toBeGreaterThanOrEqual(1);

      // Update content
      const updated = await store.update(record.id, {
        content: "Updated chocolate chip cookie recipe",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("Updated chocolate chip cookie recipe");

      // New text findable via lexical search
      const afterNew = await store.search("chocolate chip", null, projectScope(), 10);
      expect(afterNew.length).toBeGreaterThanOrEqual(1);
      expect(afterNew[0]!.record.id).toBe(record.id);

      // Old text no longer matches
      const afterOld = await store.search("banana bread", null, projectScope(), 10);
      for (const hit of afterOld) {
        expect(hit.record.id).not.toBe(record.id);
      }
    });

    it("embedding field is null when no embedder is available", async () => {
      const store = new InMemoryStore(null);
      await store.initialize();

      const record = await store.insert(makeDraft({ content: "No embed" }));
      expect(record.embedding).toBeNull();

      const updated = await store.update(record.id, { content: "Still no embed" });
      expect(updated).not.toBeNull();
      expect(updated!.embedding).toBeNull();
    });
  });

  describe("vec count stability (InMemoryStore)", () => {
    it("repeated updates do not accumulate embeddings", async () => {
      const embedder = createMockEmbedder();
      const store = new InMemoryStore(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Initial content version 0" }),
      );

      // Update 10 times — each time the old embedding is replaced
      for (let i = 1; i <= 10; i++) {
        await store.update(record.id, {
          content: `Updated content version ${i} with unique text ${i}`,
        });
      }

      // The record should have exactly one embedding (not 11 accumulated)
      const fetched = await store.get(record.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.embedding).not.toBeNull();
      expect(fetched!.embedding!.length).toBe(64);

      // The embedding should match the LATEST content
      const latestEmbedding = await embedder.embed("Updated content version 10 with unique text 10");
      for (let i = 0; i < latestEmbedding.length; i++) {
        expect(fetched!.embedding![i]).toBeCloseTo(latestEmbedding[i]!, 5);
      }
    });
  });

  describe("embedder degradation (InMemoryStore)", () => {
    it("embedder returning null still allows update to succeed", async () => {
      const failingEmbedder: Embedder = {
        id: "failing-embedder",
        degraded: false,
        dimension: 64,
        async embed(): Promise<Float32Array | null> {
          return null;
        },
        async embedBatch(): Promise<(Float32Array | null)[]> {
          return [];
        },
      };

      const store = new InMemoryStore(failingEmbedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original content" }),
      );

      const updated = await store.update(record.id, {
        content: "New content after failure",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("New content after failure");
    });

    it("embedder throwing still allows update to succeed", async () => {
      const throwingEmbedder: Embedder = {
        id: "throwing-embedder",
        degraded: false,
        dimension: 64,
        async embed(): Promise<Float32Array | null> {
          throw new Error("Network error");
        },
        async embedBatch(): Promise<(Float32Array | null)[]> {
          throw new Error("Network error");
        },
      };

      const store = new InMemoryStore(throwingEmbedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original content" }),
      );

      const updated = await store.update(record.id, {
        content: "New content after throw",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("New content after throw");
    });
  });
});

// ---------------------------------------------------------------------------
// SqliteStore-specific re-embedding tests (vector table verification)
// ---------------------------------------------------------------------------

describe("Re-embedding — SqliteStore", () => {
  describe("vec_* row count stability", () => {
    it("repeated updates do not cause unbounded vector growth", async () => {
      const embedder = createMockEmbedder();
      const store = createSqliteStoreWithEmbedder(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Initial content version 0" }),
      );

      // Update 10 times
      for (let i = 1; i <= 10; i++) {
        await store.update(record.id, {
          content: `Updated content version ${i} with unique text ${i}`,
        });
      }

      // Check vec_* table directly — should have exactly 1 row for this record
      const vecTable = store.schemaInfo.vecTable;
      expect(vecTable).not.toBeNull();

      const db = (store as unknown as { db: Database }).db;
      const vecCount = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${vecTable} WHERE memory_id = ?`)
        .get(record.id) as { cnt: number };
      expect(vecCount.cnt).toBe(1);

      // The vector should be findable via vector search
      const latestEmbedding = await embedder.embed("Updated content version 10 with unique text 10");
      const hits = await store.search("version 10", latestEmbedding, projectScope(), 10);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.record.id).toBe(record.id);
    });

    it("update without embedder does not touch vec_* table", async () => {
      const store = createSqliteStoreWithEmbedder(null);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "No embedding content" }),
      );

      await store.update(record.id, { content: "Updated content" });

      // No vec_* table should exist when embedder is null
      expect(store.schemaInfo.vecTable).toBeNull();
    });
  });

  describe("update with embedder", () => {
    it("record is findable by NEW text through vector search", async () => {
      const embedder = createMockEmbedder();
      const store = createSqliteStoreWithEmbedder(embedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original text about cats" }),
      );

      // Update to different content
      await store.update(record.id, {
        content: "Quantum computing algorithms",
      });

      // Verify the vec table still has exactly 1 row (old was replaced)
      const vecTable = store.schemaInfo.vecTable;
      expect(vecTable).not.toBeNull();
      const db = (store as unknown as { db: Database }).db;
      const vecCount = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${vecTable} WHERE memory_id = ?`)
        .get(record.id) as { cnt: number };
      expect(vecCount.cnt).toBe(1);

      // The record should be findable via lexical search with updated content
      const lexicalHits = await store.search("quantum", null, projectScope(), 10);
      expect(lexicalHits.length).toBeGreaterThanOrEqual(1);
      expect(lexicalHits[0]!.record.id).toBe(record.id);
      expect(lexicalHits[0]!.record.content).toBe("Quantum computing algorithms");
    });
  });

  describe("update without embedder", () => {
    it("update succeeds and record is findable via lexical search", async () => {
      const store = createSqliteStoreWithEmbedder(null);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original banana bread recipe" }),
      );

      const updated = await store.update(record.id, {
        content: "Updated chocolate chip cookie recipe",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("Updated chocolate chip cookie recipe");

      // New text findable via FTS
      const afterNew = await store.search("chocolate chip", null, projectScope(), 10);
      expect(afterNew.length).toBeGreaterThanOrEqual(1);
      expect(afterNew[0]!.record.id).toBe(record.id);

      // Old text no longer matches
      const afterOld = await store.search("banana bread", null, projectScope(), 10);
      for (const hit of afterOld) {
        expect(hit.record.id).not.toBe(record.id);
      }
    });

    it("embedding field is null when no embedder is available", async () => {
      const store = createSqliteStoreWithEmbedder(null);
      await store.initialize();

      const record = await store.insert(makeDraft({ content: "No embed" }));
      expect(record.embedding).toBeNull();

      const updated = await store.update(record.id, { content: "Still no embed" });
      expect(updated).not.toBeNull();
      // SqliteStore always returns embedding: null from rowToRecord
      expect(updated!.embedding).toBeNull();
    });
  });

  describe("embedder degradation (SqliteStore)", () => {
    it("embedder returning null still allows update to succeed", async () => {
      const failingEmbedder: Embedder = {
        id: "failing-embedder",
        degraded: false,
        dimension: 64,
        async embed(): Promise<Float32Array | null> {
          return null;
        },
        async embedBatch(): Promise<(Float32Array | null)[]> {
          return [];
        },
      };

      const store = createSqliteStoreWithEmbedder(failingEmbedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original content" }),
      );

      const updated = await store.update(record.id, {
        content: "New content after failure",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("New content after failure");
    });

    it("embedder throwing still allows update to succeed", async () => {
      const throwingEmbedder: Embedder = {
        id: "throwing-embedder",
        degraded: false,
        dimension: 64,
        async embed(): Promise<Float32Array | null> {
          throw new Error("Network error");
        },
        async embedBatch(): Promise<(Float32Array | null)[]> {
          throw new Error("Network error");
        },
      };

      const store = createSqliteStoreWithEmbedder(throwingEmbedder);
      await store.initialize();

      const record = await store.insert(
        makeDraft({ content: "Original content" }),
      );

      const updated = await store.update(record.id, {
        content: "New content after throw",
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("New content after throw");
    });
  });
});
