# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-10-03

### Changed

- **`actions/checkout` and `actions/setup-node` bumped v4 → v7** in both workflows. The v4 pins targeted a Node 20 runtime, which GitHub now forces onto Node 24 with a deprecation warning on every run. No runtime or behaviour change for consumers.

### Added

- **Release process documented** in `CONTRIBUTING.md` — pre-tag checklist, the tag-push trigger, the full version → dist-tag table, and why an unrecognised prerelease identifier fails the publish run instead of defaulting to `latest`.
- **A `## [0.3.1]` changelog entry**, recording that 0.3.0 was never published (it shipped as 0.3.1) so the npm version list lines up with the changelog.

### Fixed

- The published package now ships the root `index.ts` entrypoint in tarballs after 0.3.1 — the changelog and CI workflow fixes in this release were committed after the `v0.3.1` tag, and npm tarballs are immutable.

## [0.3.1] - 2026-10-03

Post-release bump. No code changes — the content is identical to [0.3.0](#030---2026-10-01).

This version exists so the npm version list lines up with the changelog: 0.3.0 was never published (it was tagged and shipped as 0.3.1), so the fixes documented under 0.3.0 are the ones actually on the registry. See the 0.3.0 entry for the full change list.

## [0.3.0] - 2026-10-01

Context injection was silently broken: under default configuration the plugin retrieved nothing and injected no memories. Three independent defects stacked, any one of which was sufficient. All are fixed and covered by regression tests.

### Fixed

- **FTS5 queries no longer require every term (`buildFtsQueries`)** — query terms were joined with `AND`, so a natural-language prompt such as "What is the zorblax deployment pipeline canary cap?" became `"what" AND "is" AND "the" AND …` and matched nothing; the stopwords alone made it unsatisfiable. The builder now returns candidates most-precise-first — every term `AND`-joined with no stopword stripping, then a stopword-stripped `OR` fallback used only when the precise form returns no rows. `search()` stops at the first candidate that matches. This keeps identifier queries exact (searching `worker-A` still returns only `worker-A-*`) while natural-language prompts now retrieve.
- **FTS5 bm25 scores are remapped onto a usable 0–1 range (`ftsRanksToScores`)** — `1 / (1 + abs(rank))` assumed bm25 magnitudes of order 1, but FTS5 returns ~1e-6, so every hit scored ~0.9999 and the score could not distinguish a strong match from a weak one. Scores are now normalized against the best (most negative) rank in the result set, making the top hit exactly `1.0` independent of corpus size.
- **RRF scores are normalized before `minScore` is applied (`normalizeRrfScores`)** — raw RRF scores are rank-derived and bounded by `2/(k+1)` ≈ 0.033 at `k = 60`, but `inject.minScore` is a 0–1 threshold (default `0.34`). The default therefore discarded **every** hit. Scores are now rescaled against that fixed structural bound, so a hit ranked first in both channels scores `1.0` and one found by a single channel scores `0.5`. Ranking is unchanged — the transform is monotonic.
- **`contradicts` is now honoured** — the extraction prompt asks the model which earlier fact a new memory supersedes, and the `superseded_by` column plus the retention engine's superseded-first eviction were fully built, but the field was parsed and then discarded. Contradiction references are now resolved to a record (before the new record is inserted, so a self-match cannot occur) and applied via `store.supersede()`.
- **`package.json` `main` points at a real file** — it referenced `index.js`, which does not exist. `main` now agrees with `exports["."]` and resolves to `src/index.ts`.

### Added

- **Root `index.ts` path-plugin entrypoint** — opencode resolves a local directory plugin to `<dir>/index.*` and never reads `package.json` `main`, so residue could not be loaded as a path plugin without a wrapper. The new root entry re-exports `src/index.ts` and is listed in the `files` allowlist, so **the published package ships it** — `npm pack` confirms a 42B `index.ts` in the tarball. A `.ts` entry is supported; a JS entry is not required.
- **`capturePrompts` option (default `false`)** — opt-in capture of user prompts in addition to assistant text, sourced from `session.inbox.enqueued` (`item.type === "user"`). Off by default because it widens what the plugin persists.
- **Regression coverage** — `test/fts-query.test.ts`, `test/rrf-minscore.test.ts`, `test/contradicts.test.ts`, `test/prompt-capture.test.ts`, and entrypoint-allowlist assertions in `test/package-meta.test.ts`.

### Requirements

- **npm v10.9 or newer is required to publish this package.** Releases are published from GitHub Actions via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers), and npm only supports OIDC-based provenance from v10.9 onward. The publish workflow upgrades npm explicitly (`npm install -g npm@latest`) before running `npm publish`. This affects **maintainers publishing the package**, not consumers installing it — no npm tooling is needed to use residue.
- Consumers need no build step: the package ships raw `.ts` source and is consumed by OpenCode's Bun/TypeScript-native runtime.

### Known limitations

- `inject.minScore` is a channel-agreement gate, not a relevance floor. RRF is rank-based and carries no absolute relevance information, so a hit ranked first scores identically whether it is an excellent or a poor match. The default of `0.34` admits everything the retriever returns.
- Memory extraction is driven by `session.idle`, which does not fire in non-interactive `opencode run` sessions. `session.execution.succeeded` is the reliable end-of-turn signal.
- FTS score magnitudes vary with corpus size, so ranking degrades on very small stores; the vector channel carries more signal once embeddings are available.

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
