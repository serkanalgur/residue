# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-09-29

### Added

- **Expanded MemoryStore port** — `get`, `update`, `remove`, `removeMany`, `scan`, `stats`, `touch`, and `supersede` methods added to the store interface. Both `SqliteStore` and `InMemoryStore` implement the full port. A parameterized contract suite verifies both implementations pass identically.
- **Schema migration v1→v2** — adds `confidence`, `created_at`, `last_access`, `access_count`, and `superseded_by` columns. Migration is idempotent and preserves existing data. Tracked via `meta.schema_version`; runs automatically on load.
- **Retention policy engine** (`src/retention.ts`) — per-kind TTL, superseded-first eviction, access-decay scoring, and bounded work. Three-phase eviction: superseded records, TTL-expired records, then row-cap enforcement by composite score.
- **Default retention policy** — `decision` and `pattern` kinds: 365 days; `fact`: 180 days; `digest`: 30 days; `profile`: never expires. Per-project cap: 2 000 records. Global cap: 5 000 records. `0` means "no cap enforced" (unlimited).
- **`res_forget` tool** — two-step preview/confirm workflow for deleting memory records. No code path can truncate the store without `id` or `query`. Large match sets always show preview even with `confirm=true`.
- **`res_profile` tool** — read-only cross-project aggregated view of durable preferences and patterns, grouped by kind with counts, tags, and access statistics.
- **Worktree lifecycle sync** (`src/worktree.ts`) — subscribes to `worktree.updated` / `worktree.resolved` events and demotes (sets `worktree_key` to `NULL`) for removed worktrees. Transient API failures are detected; debounced reconciliation; scope-isolated; idempotent.
- **Global row cap enforcement** — `runGlobalRetention` enforces `maxRecordsGlobal` on global-scope records. Reuses the same eviction scoring. Called on plugin startup.
- **Re-embedding on record update** — both `SqliteStore` and `InMemoryStore` re-embed when content changes. Degraded mode: embedder returning `null` or throwing still allows the update to succeed.
- **Session digest** (`src/ingest/digest.ts`) — produces a single summary record on `session.compaction.ended` events. Anti-feedback-loop protections (debounce, per-session cap) prevent runaway LLM costs. The compaction hook is intentionally not used for memory extraction.
- **Reporting stripe** (`src/report.ts`) — emits concise operational notes via `ctx.session.synthetic()`. Disabled by default; when enabled, hard rate limiting per session. Never resumes from a synthetic message.
- **Token-cost benchmark** (`bench/token-cost.ts`) — measures prompt-hook vs context-hook vs tool-only injection over 45 turns. Runnable via `bun run bench:token-cost`.

### Changed

- **`MemoryRecord.worktree_key`** is now `string | null`. Records demoted by the worktree lifecycle sync have `NULL` worktree keys, which widens their visible scope across all worktrees within the project.
- **Database schema moved to version 2** and migrates automatically on load. Existing databases are upgraded in-place with `ALTER TABLE ADD COLUMN` statements (idempotent, data-preserving).
- **Retention runs with a documented default policy** — per-kind TTL: `decision` 365 d, `pattern` 365 d, `fact` 180 d, `digest` 30 d, `profile` never. Per-project row cap: 2 000. Global row cap: 5 000. Batch size: 500 records per run. All configurable under `retention.*`.

## [0.1.2] - 2026-09-29

### Fixed

- Expose `package.json` through the exports map (`"./package.json": "./package.json"`), resolving `ERR_PACKAGE_PATH_NOT_EXPORTED` for tooling that inspects the installed package.

## [0.1.1] - 2026-09-29

### Fixed

- Remove npm's own dependency tree (159 entries) that was accidentally committed to `package.json`, which broke `bun install --frozen-lockfile` on CI.

### Added

- `files` allowlist in `package.json` restricting published package contents to `src/`, `README.md`, `LICENSE`, and `SECURITY.md`.
- Community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- Project banner and badge row in the README.
- Regression tests pinning package metadata (scoped name, exports, files allowlist, version format).

## [0.1.0] - 2026-09-29

### Added (initial release)

- SQLite-backed memory store with FTS5 full-text search.
- Hybrid retrieval (FTS5 + vector embeddings via Reciprocal Rank Fusion).
- `res_search`, `res_add`, and `res_status` tools under the `res` namespace.
- Automatic fact extraction from session transcripts.
- Context injection via the `context` hook.
- Pluggable embedding strategies: auto, local, remote, ollama, none.

### Deprecated

- **0.1.0 is deprecated.** The published manifest shipped npm's own dependency tree (`dependencies` with 159 entries) instead of a clean package. Use `>=0.1.1`.

[0.2.0]: https://github.com/serkanalgur/residue/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/serkanalgur/residue/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/serkanalgur/residue/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/serkanalgur/residue/releases/tag/v0.1.0
