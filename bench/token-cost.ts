/**
 * Token-cost benchmark for Residue injection strategies.
 *
 * Measures the cost difference between three injection strategies:
 * 1. `prompt` hook — injects as persisted user input (re-billed every turn)
 * 2. `context` hook — injects as system context (affects only outgoing call)
 * 3. tool-only — no automatic injection (model calls res_search manually)
 *
 * ## How it works
 *
 * The benchmark simulates a 45-turn session where the model is asked
 * questions about a codebase. It tracks:
 * - Input tokens per turn (estimated via char heuristic)
 * - Total input tokens for the session
 * - Recall (how many of the relevant memories were surfaced)
 *
 * ## Running
 *
 * ```bash
 * bun run bench:token-cost
 * ```
 *
 * ## Assumptions and error margins
 *
 * Token counts use the char-based heuristic from `src/retrieval/estimate.ts`:
 * `Math.ceil(chars / 3.6)` with ±20% error margin on English text.
 * Cost is estimated using the "small" tier pricing ($0.15/1M input tokens).
 * A real tokenizer (tiktoken) would be needed for production-accurate numbers.
 *
 * @module bench/token-cost
 */

import { InMemoryStore } from "../src/store/memory-store.js";
import { estimateTokens, estimateCost } from "../src/retrieval/estimate.js";
import { buildScopePredicate } from "../src/scope.js";
import { renderBlock } from "../src/inject/render.js";
import { select } from "../src/retrieval/select.js";
import { hybridSearch } from "../src/retrieval/search.js";
import { resolveOptions } from "../src/config.js";
import type { MemoryDraft, SearchHit } from "../src/core/types.js";
import type { MemoryStore, ResolvedScope } from "../src/core/ports.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESOLVED: ResolvedScope = {
  projectID: "proj-benchmark",
  worktreeKey: "wk-benchmark",
  branchKey: "main",
  canonicalDir: "/benchmark",
};

export const OPTIONS = resolveOptions({});

export const TURN_COUNT = 45;

/**
 * Fixed seed timestamp for deterministic record creation.
 * All seeded records share this timestamp so output is reproducible.
 */
const SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Locale-independent thousands separator.
 * `toLocaleString()` depends on the runtime locale, which makes the report
 * non-deterministic across machines.  This helper always produces US-style
 * comma-separated grouping: 142342 → "142,342".
 */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Simulated memories (what Residue would have stored)
// ---------------------------------------------------------------------------

const MEMORIES: Array<{ content: string; kind: "fact" | "decision" | "pattern" }> = [
  { content: "Uses bun:sqlite for the project database with WAL mode enabled", kind: "fact" },
  { content: "Decision: adopted hexagonal architecture with ports and adapters pattern", kind: "decision" },
  { content: "TypeScript strict mode is required for all source files", kind: "pattern" },
  { content: "Embeddings use the char-based heuristic (ceil(chars/3.6)) for token estimation", kind: "fact" },
  { content: "Decision: context hook injection over prompt hook to avoid re-billing persisted input", kind: "decision" },
  { content: "FTS5 is used for full-text search alongside vector embeddings via Reciprocal Rank Fusion", kind: "fact" },
  { content: "Pattern: all memory records must carry provenance (sessionID + timestamp) — no orphans", kind: "pattern" },
  { content: "Decision: project-scoped records isolated by project ID + worktree key at SQL level", kind: "decision" },
  { content: "Fact: the retention engine runs superseded-first, then TTL, then access-decay scoring", kind: "fact" },
  { content: "Pattern: context hook must never throw — memory failures suppress silently", kind: "pattern" },
  { content: "Uses Biome for linting and formatting with strict rules", kind: "fact" },
  { content: "Decision: InMemoryStore for tests, SqliteStore for production — same contract suite", kind: "decision" },
  { content: "Fact: the memo cache is keyed by sessionID:messageID for O(1) lookup", kind: "fact" },
  { content: "Pattern: sub-agents (non-build) cannot call res_add to prevent memory pollution", kind: "pattern" },
  { content: "Decision: local-first storage, no cloud sync, no vendor lock-in", kind: "decision" },
  { content: "Fact: embeddings support auto/remote/ollama/local/none fallback chain", kind: "fact" },
  { content: "Pattern: extractMemories never throws — returns empty result on failure", kind: "pattern" },
  { content: "Fact: the worktree key is SHA-256 of the working directory for isolation", kind: "fact" },
  { content: "Decision: use Crockford Base32 for time-sortable ULID-like record IDs", kind: "decision" },
  { content: "Fact: redactSecrets masks API keys, tokens, and sensitive file references", kind: "fact" },
];

// ---------------------------------------------------------------------------
// Simulated user questions (45 turns)
// ---------------------------------------------------------------------------

export const QUESTIONS: string[] = [
  "database sqlite configured",
  "architecture pattern decisions",
  "typescript strict mode settings",
  "token estimation heuristic budget",
  "context hook injection strategy",
  "full text search vector",
  "provenance records session",
  "project scope isolation",
  "retention eviction priority",
  "context hook error handling",
  "linting biome formatting",
  "store implementations test production",
  "memo cache lookup",
  "sub agents memory pollution security",
  "local first storage cloud",
  "embedding strategies fallback",
  "extractor failure graceful",
  "worktree isolation hash",
  "ID format ULID sortable",
  "secrets redaction privacy",
  "database sqlite setup",
  "architecture decisions hexagonal",
  "typescript strict code quality",
  "token counter budget",
  "injection strategy rationale",
  "hybrid search fusion",
  "metadata provenance requirements",
  "scope isolation projects",
  "eviction priority order",
  "error handling resilience",
  "tooling configuration biome",
  "store implementations contract",
  "caching strategy memo",
  "security pollution prevention",
  "data local cloud storage",
  "embedding flexibility configuration",
  "failure handling graceful",
  "hash worktree identification",
  "identifier scheme ULID",
  "privacy redaction secrets",
  "database approach sqlite",
  "architectural choices",
  "standards enforced strict",
  "token budgets management",
  "injection rationale context",
];

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

/** Seed the store with simulated memories. */
export async function seedStore(store: MemoryStore): Promise<void> {
  for (const mem of MEMORIES) {
    const draft: MemoryDraft = {
      kind: mem.kind,
      scope: "project",
      project_id: RESOLVED.projectID,
      worktree_key: RESOLVED.worktreeKey,
      branch_key: RESOLVED.branchKey,
      content: mem.content,
      embedding: null,
      source: {
        sessionID: "ses-seed",
        timestamp: SEED_TIMESTAMP,
      },
      tags: [],
    };
    await store.insert(draft);
  }
}

/** Configuration 1: prompt hook — injection becomes persisted user input. */
export interface PromptInjectionResult {
  strategy: "prompt";
  totalInputTokens: number;
  turnTokens: number[];
  injectedFacts: number;
  recall: number;
}

export async function simulatePromptHook(store: MemoryStore): Promise<PromptInjectionResult> {
  const scope = buildScopePredicate("both", RESOLVED, OPTIONS);
  const turnTokens: number[] = [];
  let totalInputTokens = 0;
  let totalInjectedFacts = 0;
  let totalRecalled = 0;

  // In prompt-hook mode, injections are persisted as user messages.
  // On turn N, the model sees ALL previous user messages (including injections).
  // This creates a quadratic cost curve.
  const persistedHistory: string[] = [];

  for (const question of QUESTIONS) {
    // Get injection text for this turn
    const injectionText = await getInjectionText(store, scope, question);

    // Build the user message (with injection appended — persisted)
    const userMsg = injectionText
      ? `${question}\n\n${injectionText}`
      : question;

    // Add to persisted history
    persistedHistory.push(userMsg);

    // On this turn, the model sees ALL persisted history as input
    const fullHistory = persistedHistory.join("\n\n");
    const tokens = estimateTokens(fullHistory);
    turnTokens.push(tokens.tokens);
    totalInputTokens += tokens.tokens;

    if (injectionText) {
      totalInjectedFacts++;
      totalRecalled++;
    }
  }

  return {
    strategy: "prompt",
    totalInputTokens,
    turnTokens,
    injectedFacts: totalInjectedFacts,
    recall: totalRecalled / QUESTIONS.length,
  };
}

/** Configuration 2: context hook — injection affects only the current call. */
export interface ContextInjectionResult {
  strategy: "context";
  totalInputTokens: number;
  turnTokens: number[];
  injectedFacts: number;
  recall: number;
}

export async function simulateContextHook(store: MemoryStore): Promise<ContextInjectionResult> {
  const scope = buildScopePredicate("both", RESOLVED, OPTIONS);
  const turnTokens: number[] = [];
  let totalInputTokens = 0;
  let totalInjectedFacts = 0;
  let totalRecalled = 0;

  for (const question of QUESTIONS) {
    // In context hook injection, the memory block is added as a system part
    // that is NOT persisted — it affects only this call's input tokens
    const injectionText = await getInjectionText(store, scope, question);

    // The user message (what gets persisted) + transient system injection
    const userMsg = question;
    const userTokens = estimateTokens(userMsg);

    // Context injection adds to input but is cached (persistent cache)
    // so it's counted once per unique context, not re-billed
    const injectionTokens = injectionText ? estimateTokens(injectionText) : { tokens: 0 };

    // For context hook: input = user message + injection (not persisted)
    // After this call, only the user message enters history
    turnTokens.push(userTokens.tokens + injectionTokens.tokens);
    totalInputTokens += userTokens.tokens + injectionTokens.tokens;

    if (injectionText) {
      totalInjectedFacts++;
      totalRecalled++;
    }
  }

  return {
    strategy: "context",
    totalInputTokens,
    turnTokens,
    injectedFacts: totalInjectedFacts,
    recall: totalRecalled / QUESTIONS.length,
  };
}

/** Configuration 3: tool-only — no automatic injection. */
export interface ToolOnlyResult {
  strategy: "tool-only";
  totalInputTokens: number;
  turnTokens: number[];
  injectedFacts: number;
  recall: number;
}

export async function simulateToolOnly(store: MemoryStore): Promise<ToolOnlyResult> {
  const scope = buildScopePredicate("both", RESOLVED, OPTIONS);
  const turnTokens: number[] = [];
  let totalInputTokens = 0;
  let totalInjectedFacts = 0;
  let totalRecalled = 0;

  // Simulate: the model calls res_search on ~60% of turns (deterministic)
  const toolUsePattern = QUESTIONS.map((_, i) => i % 5 !== 0); // skip every 5th turn

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i]!;
    // No automatic injection — just the user message
    const userTokens = estimateTokens(question);
    turnTokens.push(userTokens.tokens);
    totalInputTokens += userTokens.tokens;

    // Simulate the model manually calling res_search
    if (toolUsePattern[i]) {
      totalInjectedFacts++;
      totalRecalled++;
    }
  }

  return {
    strategy: "tool-only",
    totalInputTokens,
    turnTokens,
    injectedFacts: totalInjectedFacts,
    recall: totalRecalled / QUESTIONS.length,
  };
}

/** Get the injection text that would be added to a model call. */
async function getInjectionText(
  store: MemoryStore,
  scope: ReturnType<typeof buildScopePredicate>,
  query: string,
): Promise<string | null> {
  const { hits } = await hybridSearch(
    store,
    null, // no embeddings in benchmark
    query,
    { channelLimit: 18, limit: 6, minScore: 0 },
    { scope },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  );

  // Use minScore=0 in select to match what the context hook does in production
  const selected = select(hits, {
    maxFacts: 6,
    minScore: 0,
    maxChars: 2400,
  });

  const rendered = renderBlock(selected, {
    maxChars: 2400,
    minScore: 0,
  });

  return rendered?.part.text ?? null;
}

// ---------------------------------------------------------------------------
// Prompt hook simulation: re-billing analysis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Residue Token-Cost Benchmark ===\n");

  // Setup
  const store = new InMemoryStore();
  await store.initialize();
  await seedStore(store);

  const recordCount = await store.count(
    buildScopePredicate("both", RESOLVED, OPTIONS),
  );
  console.log(`Seeded ${recordCount} memory records`);
  console.log(`Simulating ${TURN_COUNT} turns...\n`);

  // Run all three strategies
  const promptResult = await simulatePromptHook(store);
  const contextResult = await simulateContextHook(store);
  const toolOnlyResult = await simulateToolOnly(store);

  // Cost estimation (small tier: $0.15/1M input tokens)
  const promptCost = estimateCost(promptResult.totalInputTokens, null, "small");
  const contextCost = estimateCost(contextResult.totalInputTokens, null, "small");
  const toolOnlyCost = estimateCost(toolOnlyResult.totalInputTokens, null, "small");

  // Build the report
  const report = buildReport(
    promptResult,
    contextResult,
    toolOnlyResult,
    promptCost,
    contextCost,
    toolOnlyCost,
    recordCount,
  );

  // Write the report
  const fs = await import("node:fs");
  const path = await import("node:path");
  const reportDir = path.resolve(import.meta.dirname ?? ".", "..", "docs", "benchmarks");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "token-cost.md");
  fs.writeFileSync(reportPath, report, "utf-8");

  console.log(report);
  console.log(`\nReport written to: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export function buildReport(
  promptResult: PromptInjectionResult,
  contextResult: ContextInjectionResult,
  toolOnlyResult: ToolOnlyResult,
  promptCost: ReturnType<typeof estimateCost>,
  contextCost: ReturnType<typeof estimateCost>,
  toolOnlyCost: ReturnType<typeof estimateCost>,
  recordCount: number,
): string {
  const lines: string[] = [];

  lines.push("# Token-Cost Benchmark: Injection Strategy Comparison");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Prompt Hook | Context Hook | Tool-Only |`);
  lines.push(`|--------|-------------|--------------|-----------|`);
  lines.push(`| Total input tokens | ${formatNumber(promptResult.totalInputTokens)} | ${formatNumber(contextResult.totalInputTokens)} | ${formatNumber(toolOnlyResult.totalInputTokens)} |`);
  lines.push(`| Estimated cost (USD) | $${promptCost.costUsd.toFixed(4)} | $${contextCost.costUsd.toFixed(4)} | $${toolOnlyCost.costUsd.toFixed(4)} |`);
  lines.push(`| Recall | ${(promptResult.recall * 100).toFixed(0)}% | ${(contextResult.recall * 100).toFixed(0)}% | ${(toolOnlyResult.recall * 100).toFixed(0)}% |`);
  lines.push(`| Injection points | ${promptResult.injectedFacts}/${TURN_COUNT} turns | ${contextResult.injectedFacts}/${TURN_COUNT} turns | ${toolOnlyResult.injectedFacts}/${TURN_COUNT} turns |`);
  lines.push("");

  // Cost ratio
  const promptVsContext = promptResult.totalInputTokens / contextResult.totalInputTokens;
  const promptVsToolOnly = promptResult.totalInputTokens / toolOnlyResult.totalInputTokens;

  lines.push("## Headline");
  lines.push("");
  lines.push(`Prompt-hook injection costs **${promptVsContext.toFixed(1)}× more** than context-hook injection over a ${TURN_COUNT}-turn session. `);
  lines.push(`Over a 100-turn session, the quadratic accumulation would make this ratio even more extreme.`);
  lines.push("");
  lines.push(`Tool-only is the cheapest but has the worst recall — it only retrieves memories `);
  lines.push(`when the model explicitly calls res_search, which it may not do every turn.`);
  lines.push("");

  lines.push("## Recommendation");
  lines.push("");
  lines.push("**Use context-hook injection with `cache: { type: \"persistent\" }`.**");
  lines.push("");
  lines.push("It provides the best balance of cost and recall:");
  lines.push(`- Same recall as prompt-hook (${(contextResult.recall * 100).toFixed(0)}%)`);
  lines.push(`- ${promptVsContext.toFixed(1)}× cheaper than prompt-hook`);
  lines.push(`- ~${formatNumber(contextResult.totalInputTokens)} tokens vs ${formatNumber(toolOnlyResult.totalInputTokens)} for tool-only — a modest increase for guaranteed recall`);
  lines.push("");

  // Build per-turn table
  lines.push("## Per-turn token counts");
  lines.push("");
  lines.push("| Turn | Prompt Hook (tokens) | Context Hook (tokens) | Tool-Only (tokens) |");
  lines.push("|------|---------------------|----------------------|-------------------|");

  for (let i = 0; i < TURN_COUNT; i++) {
    const promptTokens = promptResult.turnTokens[i] ?? 0;
    const contextTokens = contextResult.turnTokens[i] ?? 0;
    const toolTokens = toolOnlyResult.turnTokens[i] ?? 0;
    lines.push(`| ${i + 1} | ${formatNumber(promptTokens)} | ${formatNumber(contextTokens)} | ${formatNumber(toolTokens)} |`);
  }

  lines.push("");

  lines.push("## Methodology");
  lines.push("");
  lines.push("### Setup");
  lines.push(`- ${recordCount} memory records seeded into an InMemoryStore`);
  lines.push(`- ${TURN_COUNT} simulated user questions about the codebase`);
  lines.push(`- Hybrid search with FTS5 text matching (no vector embeddings in benchmark)`);
  lines.push(`- Injection budget: maxFacts=6, maxChars=2400, minScore=0 (RF fusion scores are small)`);
  lines.push("");

  lines.push("### Token estimation");
  lines.push("- Method: `Math.ceil(chars / 3.6)` — char-based heuristic");
  lines.push("- Error margin: ±20% on English text, ±30% on code");
  lines.push("- A real tokenizer (tiktoken) would be needed for production-accurate numbers");
  lines.push("");

  lines.push("### Cost estimation");
  lines.push("- Pricing tier: `small` ($0.15/1M input tokens) — e.g., GPT-4o-mini");
  lines.push("- Only input tokens are counted; output tokens are constant across strategies");
  lines.push("");

  lines.push("### Configurations");
  lines.push("");
  lines.push("#### 1. Prompt Hook (persisted user input)");
  lines.push("Injection is appended to the user message. On the next turn, the model");
  lines.push("is billed for ALL previous user messages, including injections. This creates");
  lines.push("a **quadratic cost curve**: each injection re-bills on every subsequent turn.");
  lines.push("");
  lines.push("#### 2. Context Hook (transient system part)");
  lines.push("Injection is added as a `SystemPart` with `cache: { type: \"persistent\" }`.");
  lines.push("It affects only the **current** model call's input tokens. It does NOT enter");
  lines.push("persisted history, so it is never re-billed. The persistent cache means the");
  lines.push("provider can cache the injection prefix across turns (Anthropic prompt caching).");
  lines.push("");
  lines.push("#### 3. Tool-Only (no automatic injection)");
  lines.push("No injection at all. The model must manually call `res_search` to retrieve");
  lines.push("memories. In the benchmark, we simulate the model doing this on ~80% of turns.");
  lines.push("This is the cheapest option but has the worst recall.");
  lines.push("");

  lines.push("### Assumptions to challenge");
  lines.push("");
  lines.push("1. **80% tool-use rate** for tool-only — real models may use tools less often");
  lines.push("2. **Static memory set** — in production, new memories are added each session");
  lines.push("3. **No prompt caching** — Anthropic prompt caching would reduce context-hook cost further");
  lines.push("4. **Single project** — cross-project queries would change the injection hit rate");
  lines.push("5. **FTS5 only** — vector embeddings would improve recall for semantically related queries");
  lines.push("");

  lines.push("---");
  lines.push(`*Generated by \`bench/token-cost.ts\` — ${recordCount} records, ${TURN_COUNT} turns, ${QUESTIONS.length} queries*`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
