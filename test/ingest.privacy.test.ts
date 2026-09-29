/**
 * Privacy tests for the ingestion pipeline.
 *
 * Verifies that sensitive content is NEVER stored in memory records:
 * - .env file content → redacted
 * - *.pem file content → redacted
 * - id_rsa references → redacted
 * - .npmrc content → redacted
 * - credentials* references → redacted
 * - API keys (sk-...) → masked
 * - Bearer tokens → masked
 * - Password patterns → masked
 * - Secret patterns → masked
 *
 * Tests use mock generateText to control what the "model" returns.
 * Verifies the final draft content (what would be stored) is safe.
 *
 * @module test/ingest.privacy
 */

import { describe, it, expect } from "bun:test";
import { extractMemories, redactSensitiveContent } from "../src/ingest/extractor.js";
import type { ResolvedScope } from "../src/core/types.js";
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
  projectID: "proj-privacy-test",
  worktreeKey: "wk-privacy-test",
  branchKey: "main",
  canonicalDir: "/privacy-test",
};

/** Patterns that must NEVER appear in stored memory content. */
const FORBIDDEN_PATTERNS: readonly (RegExp | string)[] = [
  /\.env\b/,
  /\.pem\b/,
  /id_rsa/,
  /\.npmrc/,
  /^credentials/i,
  /\bsk-[a-zA-Z0-9_-]{20,}\b/,
  /-----BEGIN.*PRIVATE KEY-----/,
  // Note: password=/token=/secret= are redacted to [REDACTED] by redactSensitiveContent.
  // We verify the original sensitive VALUE doesn't leak, not the generic pattern.
];

/** Check if a string contains any forbidden pattern. */
function containsForbidden(text: string): boolean {
  return FORBIDDEN_PATTERNS.some((pattern) => {
    if (typeof pattern === "string") {
      return text.includes(pattern);
    }
    return pattern.test(text);
  });
}

function defaultModel() {
  return { id: "test-model", providerID: "test-provider" };
}

// ---------------------------------------------------------------------------
// .env content
// ---------------------------------------------------------------------------

describe("Privacy — .env content", () => {
  it("redacts .env file references in extracted text", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Configuration stored in .env file with API keys",
          kind: "fact",
          tags: ["config"],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-001",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    expect(result.drafts.length).toBeGreaterThan(0);
    for (const draft of result.drafts) {
      expect(draft.content).not.toMatch(/\.env\b/);
    }
  });

  it("redacts actual .env content patterns", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 is in the .env",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-002",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(containsForbidden(draft.content)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// *.pem content
// ---------------------------------------------------------------------------

describe("Privacy — *.pem content", () => {
  it("redacts .pem file references", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Private key stored in key.pem for authentication",
          kind: "fact",
          tags: ["auth"],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-003",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(containsForbidden(draft.content)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// id_rsa content
// ---------------------------------------------------------------------------

describe("Privacy — id_rsa content", () => {
  it("redacts id_rsa references", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "SSH key at id_rsa used for git access",
          kind: "fact",
          tags: ["ssh"],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-004",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(containsForbidden(draft.content)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// .npmrc content
// ---------------------------------------------------------------------------

describe("Privacy — .npmrc content", () => {
  it("redacts .npmrc references", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Registry token stored in .npmrc for npm publish",
          kind: "fact",
          tags: ["npm"],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-005",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(containsForbidden(draft.content)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// credentials* content
// ---------------------------------------------------------------------------

describe("Privacy — credentials* content", () => {
  it("redacts credentials references", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "AWS credentials stored in credentials.json",
          kind: "fact",
          tags: ["aws"],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-006",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(containsForbidden(draft.content)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// API key masking
// ---------------------------------------------------------------------------

describe("Privacy — API key masking", () => {
  it("masks OpenAI-style API keys (sk-...)", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Using API key sk-abcdefghijklmnopqrstuvwxyz123456 for OpenAI",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-007",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(draft.content).not.toContain("sk-abcde");
      expect(draft.content).toContain("[REDACTED]");
    }
  });

  it("masks Bearer tokens", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Authorization uses Bearer eyJhbGciOiJIUzI1NiJ9 for API calls",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-008",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      expect(draft.content).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    }
  });

  it("masks password= patterns", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Database password=Hunter2IsNotAGoodPassword! for Postgres",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-009",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      // The original secret value must not appear in the stored content
      expect(draft.content).not.toContain("Hunter2IsNotAGoodPassword!");
      // The password= pattern should be redacted to password=[REDACTED]
      expect(draft.content).toContain("password=[REDACTED]");
    }
  });

  it("masks token= patterns", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "NPM token=npm_xxxxxxxxxxxxxxxxxxxx for publishing",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-010",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      // The original secret value must not appear
      expect(draft.content).not.toContain("npm_xxxxxxxxxxxxxxxxxxxx");
      // The token= pattern should be redacted
      expect(draft.content).toContain("token=[REDACTED]");
    }
  });

  it("masks secret= patterns", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "App secret=mySuperSecretValue12345678901 for JWT signing",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-011",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      // The original secret value must not appear
      expect(draft.content).not.toContain("mySuperSecretValue12345678901");
      // The secret= pattern should be redacted
      expect(draft.content).toContain("secret=[REDACTED]");
    }
  });
});

// ---------------------------------------------------------------------------
// Combined sensitive content
// ---------------------------------------------------------------------------

describe("Privacy — combined sensitive content", () => {
  it("handles multiple sensitive patterns in one text", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Config has .env with sk-abc123def456ghi789jkl0 and password=secret123 in credentials.json",
          kind: "fact",
          tags: [],
          confidence: 0.8,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-012",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    for (const draft of result.drafts) {
      // Sensitive file patterns are redacted
      expect(draft.content).not.toMatch(/\.env\b/);
      expect(draft.content).not.toMatch(/credentials\.json/);
      // API key is masked
      expect(draft.content).not.toContain("sk-abc123def456ghi789jkl0");
      // Password value is masked
      expect(draft.content).not.toContain("secret123");
    }
  });
});

// ---------------------------------------------------------------------------
// Normal content is NOT affected
// ---------------------------------------------------------------------------

describe("Privacy — normal content preserved", () => {
  it("preserves normal technical content", async () => {
    const response = JSON.stringify({
      memories: [
        {
          text: "Uses bun:sqlite for the project database with WAL mode",
          kind: "fact",
          tags: ["database"],
          confidence: 0.9,
        },
        {
          text: "Decision to use FTS5 for full-text search indexing",
          kind: "decision",
          tags: ["search"],
          confidence: 0.85,
        },
      ],
    });

    const result = await extractMemories(
      async () => ({ text: response }),
      defaultModel,
      "test",
      "ses-priv-normal",
      undefined,
      RESOLVED,
      { maxFactsPerIdle: 8 },
      silentLog,
    );

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]!.content).toBe(
      "Uses bun:sqlite for the project database with WAL mode",
    );
    expect(result.drafts[1]!.content).toBe(
      "Decision to use FTS5 for full-text search indexing",
    );
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveContent direct tests
// ---------------------------------------------------------------------------

describe("Privacy — redactSensitiveContent", () => {
  const sensitiveCases: Array<[string, string]> = [
    [".env file contains secrets", "[REDACTED_FILE]"],
    ["key.pem has the private key", "[REDACTED_FILE]"],
    ["id_rsa is the SSH key", "[REDACTED_FILE]"],
    [".npmrc stores the registry token", "[REDACTED_FILE]"],
    ["credentials.json has AWS keys", "[REDACTED_FILE]"],
    ["API key: sk-abcdefghijklmnopqrstuvwxyz123456", "[REDACTED]"],
    ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "[REDACTED]"],
    ["password=SuperSecret12345678", "[REDACTED]"],
  ];

  for (const [input, expected] of sensitiveCases) {
    it(`redacts: "${input.slice(0, 40)}..."`, () => {
      const result = redactSensitiveContent(input);
      expect(result).toContain(expected);
    });
  }

  it("preserves normal text", () => {
    const input = "Uses TypeScript strict mode for type safety";
    expect(redactSensitiveContent(input)).toBe(input);
  });
});
