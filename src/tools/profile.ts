/**
 * `res_profile` tool — cross-project aggregated view of durable preferences.
 *
 * Read-only. Scans global-scope records (and optionally the current project)
 * to answer: "how does this person like to work?"
 *
 * Returns an aggregated summary grouped by kind, with counts, most-accessed
 * entries, and dominant tags. Content is presented as a readable digest,
 * not raw JSON.
 *
 * Safety guarantees:
 * - Never inserts, updates, or deletes any records.
 * - Bounded scan: examines at most `maxScan` records.
 *
 * @module tools/profile
 */

import type { MemoryStore, Embedder, ScopePredicate } from "../core/ports.js";
import type { MemoryKind, MemoryRecord } from "../core/types.js";
import type { ResolvedScope } from "../core/ports.js";
import type { Logger } from "../log.js";
import { buildScopePredicate } from "../scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for res_profile. */
export interface ProfileInput {
  /** Include current project records alongside global. Default: false. */
  readonly includeProject?: boolean;
  /** Maximum records to scan (bounded work). Default: 200. */
  readonly maxScan?: number;
}

/** Dependencies injected into the profile tool. */
export interface ProfileDeps {
  readonly store: MemoryStore;
  readonly embedder: Embedder | null;
  readonly resolved: ResolvedScope;
  readonly options: {
    readonly inject: {
      readonly shareAcrossWorktrees: boolean;
    };
  };
  readonly logger: Logger;
}

/** Minimal ToolContext shape used by our execute function. */
interface ToolContext {
  readonly signal?: AbortSignal;
  progress?(Update: { status: string }): Promise<void>;
}

/** Aggregated stats for a single kind. */
interface KindAggregate {
  readonly kind: MemoryKind;
  readonly count: number;
  readonly topTags: ReadonlyArray<{ readonly tag: string; readonly count: number }>;
  readonly mostAccessed: ReadonlyArray<{ readonly content: string; readonly accessCount: number }>;
  readonly avgConfidence: number;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Execute the res_profile tool.
 *
 * @param input - Tool input.
 * @param context - Tool context with signal and progress.
 * @param deps - Injected dependencies.
 * @returns Tool output with content string and metadata.
 */
export async function executeProfile(
  input: ProfileInput,
  context: ToolContext,
  deps: ProfileDeps,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const start = Date.now();

  // Check for cancellation
  context.signal?.throwIfAborted();

  const maxScan = Math.min(Math.max(input.maxScan ?? 200, 1), 1000);

  await context.progress?.({ status: "Building profile..." });

  // Build scope: global always + optionally project
  const globalScope = buildScopePredicate("global", deps.resolved, deps.options);
  const projectScope = buildScopePredicate("project", deps.resolved, deps.options);

  // Scan global records
  const globalRecords = await deps.store.scan({
    scope: globalScope,
    limit: maxScan,
  });

  let projectRecords: readonly MemoryRecord[] = [];
  if (input.includeProject) {
    const remaining = maxScan - globalRecords.length;
    if (remaining > 0) {
      projectRecords = await deps.store.scan({
        scope: projectScope,
        limit: remaining,
      });
    }
  }

  const allRecords = [...globalRecords, ...projectRecords];

  // Never insert, update, or delete — read-only guarantee
  if (allRecords.length === 0) {
    return {
      content: "No memory records found. Nothing to profile.",
      metadata: { recordCount: 0, elapsedMs: Date.now() - start },
    };
  }

  // Aggregate by kind
  const aggregates = aggregateByKind(allRecords);

  // Build readable digest
  const digest = formatDigest(aggregates, allRecords.length, input.includeProject ?? false);

  return {
    content: digest,
    metadata: {
      recordCount: allRecords.length,
      kinds: aggregates.map((a) => a.kind),
      elapsedMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Aggregate records by kind, computing counts, top tags, most accessed,
 * and average confidence for each kind.
 */
function aggregateByKind(records: readonly MemoryRecord[]): KindAggregate[] {
  const byKind = new Map<MemoryKind, MemoryRecord[]>();

  for (const record of records) {
    const existing = byKind.get(record.kind);
    if (existing) {
      existing.push(record);
    } else {
      byKind.set(record.kind, [record]);
    }
  }

  const aggregates: KindAggregate[] = [];

  for (const [kind, kindRecords] of byKind) {
    // Count tags
    const tagCounts = new Map<string, number>();
    for (const r of kindRecords) {
      for (const tag of r.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({ tag, count }));

    // Most accessed
    const mostAccessed = [...kindRecords]
      .sort((a, b) => b.access_count - a.access_count)
      .slice(0, 3)
      .map((r) => ({ content: r.content.slice(0, 100), accessCount: r.access_count }));

    // Average confidence
    const avgConfidence = kindRecords.reduce((sum, r) => sum + r.confidence, 0) / kindRecords.length;

    aggregates.push({
      kind,
      count: kindRecords.length,
      topTags,
      mostAccessed,
      avgConfidence,
    });
  }

  // Sort by count descending
  aggregates.sort((a, b) => b.count - a.count);

  return aggregates;
}

/**
 * Format aggregates as a human-readable digest.
 *
 * @param aggregates - Aggregated data by kind.
 * @param totalCount - Total number of records scanned.
 * @param includeProject - Whether project records were included.
 * @returns Readable digest string.
 */
function formatDigest(
  aggregates: readonly KindAggregate[],
  totalCount: number,
  includeProject: boolean,
): string {
  const lines: string[] = [];

  lines.push(`Memory Profile — ${totalCount} records scanned${includeProject ? " (global + project)" : " (global only)"}`);
  lines.push("");

  for (const agg of aggregates) {
    const kindLabel = agg.kind.toUpperCase();
    lines.push(`## ${kindLabel} (${agg.count} records, avg confidence: ${agg.avgConfidence.toFixed(2)})`);

    // Top tags
    if (agg.topTags.length > 0) {
      const tagStr = agg.topTags.map((t) => `${t.tag}(${t.count})`).join(", ");
      lines.push(`  Tags: ${tagStr}`);
    }

    // Most accessed
    if (agg.mostAccessed.length > 0) {
      lines.push("  Most accessed:");
      for (const entry of agg.mostAccessed) {
        if (entry.accessCount > 0) {
          lines.push(`    • [${entry.accessCount}x] ${entry.content}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}
