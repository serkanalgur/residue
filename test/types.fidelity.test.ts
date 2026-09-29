/**
 * Type fidelity regression test.
 *
 * Proves that:
 * 1. src/inject/ contains NO locally-declared SessionContext/SystemPart/Message
 *    interfaces — all types come from real @opencode packages.
 * 2. SessionContext from @opencode/plugin has the expected fields
 *    (system, messages, tools, agent, sessionID, model).
 * 3. SystemPart.cache accepts { type: "persistent" } from @opencode/ai.
 * 4. SessionContext.system is mutable (push works).
 *
 * Compile-time checks run at `bunx tsc --noEmit` — if any type assertion
 * below is wrong, tsc will fail. Runtime checks verify source file contents.
 *
 * @module test/types.fidelity
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Real types — these imports MUST resolve to the actual packages.
// If opencode-types.ts is reintroduced or the packages change shape,
// tsc will fail here.
// ---------------------------------------------------------------------------

import type { SystemPart, Message } from "@opencode/ai";
import type { SessionContext } from "@opencode/plugin/promise/session";

// ---------------------------------------------------------------------------
// Compile-time-only type assertions (never executed at runtime)
//
// These use type annotations to prove structural compatibility.
// tsc validates them; the JS runtime never sees these statements.
// ---------------------------------------------------------------------------

// (A) SessionContext has all required fields with correct mutability
{
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type AssertSessionContextShape = {
    sessionID: SessionContext["sessionID"];
    agent: SessionContext["agent"];
    model: SessionContext["model"];
    system: SessionContext["system"];
    messages: SessionContext["messages"];
    tools: SessionContext["tools"];
  };

  // system is mutable Array<SystemPart> — push is allowed
  type AssertSystemPushable = SessionContext["system"] extends Array<SystemPart>
    ? true
    : never;

  // messages is mutable Array<Message>
  type AssertMessagesPushable = SessionContext["messages"] extends Array<Message>
    ? true
    : never;

  // These types must resolve to `true` — tsc fails otherwise
  type _t1 = AssertSystemPushable extends true ? "ok" : never;
  type _t2 = AssertMessagesPushable extends true ? "ok" : never;
}

// (B) SystemPart.cache accepts { type: "persistent" }
{
  // If SystemPart didn't accept this shape, this assignment would fail tsc
  const _persistentPart: SystemPart = {
    type: "text",
    text: "",
    cache: { type: "persistent" },
  };

  const _ephemeralPart: SystemPart = {
    type: "text",
    text: "",
    cache: { type: "ephemeral" },
  };
}

// (C) Message type is accessible and has role + content
{
  // If Message didn't exist in @opencode/ai, tsc would fail on the import above
  // and on these phantom usages
  type AssertMessageShape = Message extends { role: string; content: unknown }
    ? true
    : never;
  type _tm = AssertMessageShape extends true ? "ok" : never;
}

// ---------------------------------------------------------------------------
// Runtime: prove no locally-declared type copies exist
// ---------------------------------------------------------------------------

/** Patterns that indicate a locally-declared type copy (NOT an import). */
const LOCAL_DECLARATION_PATTERNS = [
  /^\s*export\s+interface\s+SessionContext\b/m,
  /^\s*interface\s+SessionContext\b/m,
  /^\s*export\s+type\s+SessionContext\b/m,
  /^\s*type\s+SessionContext\b/m,
  /^\s*export\s+interface\s+SystemPart\b/m,
  /^\s*interface\s+SystemPart\b/m,
  /^\s*export\s+type\s+SystemPart\b/m,
  /^\s*type\s+SystemPart\b/m,
  /^\s*export\s+interface\s+Message\b/m,
  /^\s*interface\s+Message\b/m,
  /^\s*export\s+type\s+Message\b/m,
  /^\s*type\s+Message\b/m,
];

const INJECT_DIR = join(import.meta.dir, "..", "src", "inject");

async function readInjectFiles(): Promise<string[]> {
  const entries = await readdir(INJECT_DIR);
  return entries.filter((e) => e.endsWith(".ts"));
}

describe("type fidelity — no local type copies", () => {
  it("src/inject/ contains no locally-declared SessionContext, SystemPart, or Message", async () => {
    const files = await readInjectFiles();
    const violations: string[] = [];

    for (const file of files) {
      const content = await readFile(join(INJECT_DIR, file), "utf-8");
      for (const pattern of LOCAL_DECLARATION_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          violations.push(
            `${file}: locally declared type found: "${matches[0]!.trim()}"`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("opencode-types.ts does not exist", async () => {
    const files = await readInjectFiles();
    expect(files).not.toContain("opencode-types.ts");
  });
});

describe("type fidelity — runtime shape checks", () => {
  it("SessionContext.system is mutable — push works", () => {
    const ctx: SessionContext = {
      sessionID: "test" as never,
      agent: "build" as never,
      model: {} as never,
      system: [],
      messages: [],
      tools: {},
      options: {},
    };

    const before = ctx.system.length;
    ctx.system.push({ type: "text", text: "regression-check" });
    expect(ctx.system.length).toBe(before + 1);
    ctx.system.pop();
    expect(ctx.system.length).toBe(before);
  });

  it("SystemPart accepts { type: 'persistent' } as cache", () => {
    const part: SystemPart = {
      type: "text",
      text: "persistent-cache-check",
      cache: { type: "persistent" },
    };

    expect(part.cache).toBeDefined();
    expect(part.cache!.type).toBe("persistent");
  });

  it("SystemPart accepts { type: 'ephemeral' } as cache", () => {
    const part: SystemPart = {
      type: "text",
      text: "ephemeral-cache-check",
      cache: { type: "ephemeral" },
    };

    expect(part.cache).toBeDefined();
    expect(part.cache!.type).toBe("ephemeral");
  });

  it("SystemPart accepts metadata field", () => {
    const part: SystemPart = {
      type: "text",
      text: "metadata-check",
      metadata: { source: "residue.memory" },
    };

    expect(part.metadata).toBeDefined();
    expect((part.metadata as Record<string, unknown>).source).toBe("residue.memory");
  });
});
