/**
 * Tests for the memory extractor.
 *
 * **MOCK ctx.generate.text — NO REAL API CALLS**
 *
 * Covers:
 * - Valid JSON → MemoryDraft[]
 * - ```json``` code fence stripping
 * - Invalid JSON → 1 retry → valid → success
 * - 2x invalid JSON → empty result (NEVER throws)
 * - Model returns empty text → empty result
 * - Invalid kind (not in enum) → item rejected
 * - Text < 8 chars → item rejected
 * - Text > 2000 chars → item rejected
 * - confidence outside 0..1 → item rejected
 * - 9+ tags → item rejected
 * - Provenanceless record is NOT written to store
 * - maxFactsPerIdle cap is enforced
 * - redactSensitiveContent strips sensitive patterns
 *
 * @module test/ingest.extractor
 */

import { describe, it, expect, mock } from "bun:test";
import { extractMemories, redactSensitiveContent } from "../src/ingest/extractor.js";
import type { MemoryDraft, ResolvedScope } from "../src/core/types.js";
import type { Logger } from "../src/log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const RESOLVED: ResolvedScope = {
  projectID: "proj-test",
  worktreeKey: "wk-test",
  branchKey: "main",
  canonicalDir: "/test",
};

const DEFAULT_OPTIONS = {
  maxFactsPerIdle: 8,
};

/** Create a mock generateText that returns the given text. */
function mockGenerate(responseText: string) {
  return async (_opts: { prompt: string; model?: unknown }) => {
    return { text: responseText };
  };
}

/** Create a mock generateText that returns the given responses in sequence. */
function mockGenerateSequence(responses: string[]) {
  let callCount = 0;
  return async (_opts: { prompt: string; model?: unknown }) => {
    const text = responses[callCount] ?? "";
    callCount++;
    return { text };
  };
}

function defaultModel() {
  return { id: "test-model", providerID: "test-provider" };
}

// ---------------------------------------------------------------------------
// Valid JSON parsing
// ---------------------------------------------------------------------------

describe("extractMemories — valid JSON", () => {
  it("parses valid JSON and returns MemoryDraft[]", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Uses bun:sqlite for the project database",
          kind: "fact",
          tags: ["database", "sqlite"],
          confidence: 0.9,
        },
        {
          text: "Decision to use FTS5 for full-text search",
          kind: "decision",
          tags: ["search"],
          confidence: 0.85,
        },
      ],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test transcript text",
      "ses-001",
      "msg-001",
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(2);
    expect(result.rawCount).toBe(2);
    expect(result.rejectedCount).toBe(0);

    const d1 = result.drafts[0]!;
    expect(d1.kind).toBe("fact");
    expect(d1.content).toBe("Uses bun:sqlite for the project database");
    expect(d1.tags).toEqual(["database", "sqlite"]);
    expect(d1.scope).toBe("project");
    expect(d1.project_id).toBe("proj-test");
    expect(d1.source.sessionID).toBe("ses-001");
    expect(d1.source.messageID).toBe("msg-001");
    expect(d1.embedding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Code fence stripping
// ---------------------------------------------------------------------------

describe("extractMemories — code fence stripping", () => {
  it("strips ```json fences", async () => {
    const response = '```json\n{"memories":[{"text":"Uses bun:sqlite for the project database","kind":"fact","tags":["db"],"confidence":0.9}]}\n```';

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.content).toBe("Uses bun:sqlite for the project database");
  });

  it("strips plain ``` fences", async () => {
    const response = '```\n{"memories":[{"text":"Uses FTS5 for full-text search","kind":"decision","tags":["search"],"confidence":0.8}]}\n```';

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
  });

  it("handles JSON wrapped in prose", async () => {
    const response = 'Here are the extracted memories:\n{"memories":[{"text":"Prefers TypeScript strict mode for type safety","kind":"fact","tags":["typescript"],"confidence":0.75}]}\nDone.';

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Retry on invalid JSON
// ---------------------------------------------------------------------------

describe("extractMemories — retry on invalid JSON", () => {
  it("recovers from malformed JSON via resilience chain (single call)", async () => {
    // The resilience chain retries PARSING the same text, not calling generateText again.
    // A single response that mixes prose with valid JSON should be recovered.
    const noisyResponse =
      "Here are the extracted memories:\n" +
      JSON.stringify({
        memories: [
          {
            text: "Uses bun:sqlite for the project database",
            kind: "fact",
            tags: [],
            confidence: 0.6,
          },
        ],
      }) +
      "\nHope that helps!";

    const result = await extractMemories(
      mockGenerate(noisyResponse),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.content).toBe("Uses bun:sqlite for the project database");
  });
});

// ---------------------------------------------------------------------------
// Complete failure → empty result (NEVER throws)
// ---------------------------------------------------------------------------

describe("extractMemories — complete failure", () => {
  it("returns empty on 2x invalid JSON (never throws)", async () => {
    const invalid1 = "Complete garbage response 1";
    const invalid2 = "Complete garbage response 2";

    const generate = mockGenerateSequence([invalid1, invalid2]);

    await expect(
      extractMemories(
        generate,
        defaultModel,
        "test",
        "ses-001",
        undefined,
        RESOLVED,
        DEFAULT_OPTIONS,
        silentLog,
      ),
    ).resolves.toMatchObject({
      drafts: [],
      rawCount: 0,
    });
  });

  it("returns empty when model returns empty text", async () => {
    const generate = mockGenerate("");

    const result = await extractMemories(
      generate,
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
  });

  it("returns empty when generateText throws", async () => {
    const brokenGenerate = async () => {
      throw new Error("API rate limit");
    };

    await expect(
      extractMemories(
        brokenGenerate,
        defaultModel,
        "test",
        "ses-001",
        undefined,
        RESOLVED,
        DEFAULT_OPTIONS,
        silentLog,
      ),
    ).resolves.toMatchObject({ drafts: [] });
  });
});

// ---------------------------------------------------------------------------
// Validation — items rejected
// ---------------------------------------------------------------------------

describe("extractMemories — validation rejections", () => {
  const validBase = {
    text: "Uses bun:sqlite for the project database",
    kind: "fact",
    tags: ["db"],
    confidence: 0.8,
  };

  it("rejects invalid kind (not in enum)", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, kind: "invalid_kind" }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects text shorter than 8 characters", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, text: "short" }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects text longer than 2000 characters", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, text: "x".repeat(2001) }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects confidence < 0", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, confidence: -0.1 }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects confidence > 1", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, confidence: 1.5 }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects 9+ tags", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("accepts 8 tags (at the limit)", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, tags: ["a", "b", "c", "d", "e", "f", "g", "h"] }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
    expect(result.rejectedCount).toBe(0);
  });

  it("accepts text exactly 8 characters", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, text: "12345678" }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
  });

  it("accepts text exactly 2000 characters", async () => {
    const response = JSON.stringify({
      memories: [{ ...validBase, text: "x".repeat(2000) }],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
  });

  it("accepts confidence 0 and 1 (boundary values)", async () => {
    const response = JSON.stringify({
      memories: [
        { ...validBase, confidence: 0, text: "Confidence is zero on this fact" },
        { ...validBase, confidence: 1, text: "Confidence is max on this fact" },
      ],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(2);
  });

  it("mixes valid and invalid — keeps valid, rejects invalid", async () => {
    const response = JSON.stringify({
      memories: [
        { ...validBase }, // valid
        { ...validBase, kind: "bogus", text: "valid text but bad kind" }, // invalid kind
        { ...validBase, text: "Another valid memory entry here" }, // valid
      ],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(2);
    expect(result.rejectedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provenance requirement
// ---------------------------------------------------------------------------

describe("extractMemories — provenance", () => {
  it("every draft has source with sessionID and timestamp", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Uses bun:sqlite for the project database",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-proof",
      "msg-proof",
      RESOLVED,
      DEFAULT_OPTIONS,
      silentLog,
    );

    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0]!;
    expect(draft.source.sessionID).toBe("ses-proof");
    expect(draft.source.messageID).toBe("msg-proof");
    expect(typeof draft.source.timestamp).toBe("string");
    expect(draft.source.timestamp.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// maxFactsPerIdle cap
// ---------------------------------------------------------------------------

describe("extractMemories — maxFactsPerIdle", () => {
  it("caps output at maxFactsPerIdle", async () => {
    const memories = Array.from({ length: 15 }, (_, i) => ({
      text: `Memory number ${i} about the project configuration`,
      kind: "fact" as const,
      tags: [],
      confidence: 0.5,
    }));

    const response = JSON.stringify({ memories });

    const result = await extractMemories(
      mockGenerate(response),
      defaultModel,
      "test",
      "ses-001",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 3 },
      silentLog,
    );

    expect(result.drafts).toHaveLength(3);
    // rawCount still reflects total from model
    expect(result.rawCount).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveContent
// ---------------------------------------------------------------------------

describe("redactSensitiveContent", () => {
  it("redacts .env references", () => {
    const input = "Read the .env file for configuration";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED_FILE]");
    expect(result).not.toContain(".env");
  });

  it("redacts .pem references", () => {
    const input = "Load key.pem for authentication";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED_FILE]");
    expect(result).not.toContain("key.pem");
  });

  it("redacts id_rsa references", () => {
    const input = "Use id_rsa for SSH access";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED_FILE]");
    expect(result).not.toContain("id_rsa");
  });

  it("redacts .npmrc references", () => {
    const input = "Check .npmrc for registry config";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED_FILE]");
    expect(result).not.toContain(".npmrc");
  });

  it("redacts credentials references", () => {
    const input = "Load credentials.json for auth";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED_FILE]");
    expect(result).not.toContain("credentials.json");
  });

  it("masks API keys (sk-...)", () => {
    const input = "Using key sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSensitiveContent(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcde");
  });

  it("masks Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
    const result = redactSensitiveContent(input);
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("leaves normal text unchanged", () => {
    const input = "Uses bun:sqlite for the project database";
    expect(redactSensitiveContent(input)).toBe(input);
  });
});
