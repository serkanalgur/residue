# Contributing to residue

Thank you for your interest in contributing! This document provides guidelines and information about contributing to this project.

> Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md) and [Security Policy](./SECURITY.md).

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/residue.git
   cd residue
   ```
3. Install dependencies:
   ```bash
   bun install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Running Tests

```bash
bun test
```

### Type Checking

```bash
bun run typecheck
```

### Linting

This project uses [Biome](https://biomejs.dev/) for linting. Before submitting a PR, please run:

```bash
bun run lint
```

To auto-fix lint issues:

```bash
bunx biome check --write src/ test/
```

### Project Structure

- `src/` — Main source code
  - `index.ts` — Plugin entry point (registers tools, hooks, and ingestion pipeline)
  - `config.ts` — Configuration types, defaults, and safe resolution with input validation
  - `log.ts` — Structured logger with automatic secret redaction
  - `paths.ts` — Data directory resolution with XDG/home/tmp fallback chain
  - `scope.ts` — Scope isolation and SQL predicate building for cross-project safety
  - `core/` — Port interfaces and shared types (the plugin contract)
  - `embed/` — Embedding adapters (remote OpenAI-compatible, Ollama, local transformers.js, registry)
  - `ingest/` — Conversation ingestion pipeline (turn buffer, LLM-based fact extraction, subscription hooks)
  - `store/` — Storage backends (SQLite with WAL + FTS5, in-memory for testing)
  - `retrieval/` — Hybrid search (FTS5 lexical + vector similarity with Reciprocal Rank Fusion)
  - `inject/` — Context hook that injects relevant memories into every model call
  - `tools/` — MCP tool definitions (`res_search`, `res_add`, `res_status`)
  - `util/` — Small pure helpers (hashing, ID generation, text truncation)
- `test/` — Test files (Bun test runner)

## Submitting Changes

1. Ensure all checks pass:
   ```bash
   bun run typecheck
   bun run lint
   bun test
   ```
2. Commit your changes with a clear message:
   ```bash
   git commit -m "feat: add new feature description"
   ```
3. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
4. Create a Pull Request on GitHub

### Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `style:` — Code style changes (formatting, etc.)
- `refactor:` — Code refactoring
- `test:` — Adding or updating tests
- `chore:` — Maintenance tasks

### Testing Expectations

The test suite must pass consistently. Please verify your changes pass on **5 consecutive runs** with no flaky tests before submitting a PR. This project has a history of intermittent test failures, and we treat flaky tests as blocking bugs.

## Releasing

Releases are triggered by pushing a `v*` git tag. The publish workflow
(`.github/workflows/publish.yml`) takes the version from the tag, runs the full
test suite, and publishes to npm.

### Before you tag

1. Land your changes on `main`.
2. Bump the version in `package.json` and add a `CHANGELOG.md` entry:
   ```bash
   npm version patch   # or: minor, or 0.4.0-rc.1 for a prerelease
   ```
   The version must live **only** in `package.json` — a test enforces that no
   source file hardcodes it.
3. Confirm the release gates pass locally:
   ```bash
   bun run typecheck && bun run lint && bun test
   ```

### Publishing

```bash
git tag v0.3.1
git push origin main --tags
```

The workflow derives the version from the tag
(`npm version "$VERSION" --no-git-tag-version`), so the tag and `package.json`
are always in sync.

Authentication uses **OIDC trusted publishing** — there is no npm token secret.
The first release from a new workflow run may need to be approved once in the
npm web UI.

### Version → dist-tag mapping

`npm publish` defaults to the `latest` dist-tag, which is what `npm install`
resolves by default. The workflow therefore derives the dist-tag from the
version:

| Version | dist-tag | Installed by `npm install @serkanalgur/residue` |
| --- | --- | --- |
| `1.2.3` | `latest` | ✅ yes |
| `1.2.3-rc.1` | `next` | ❌ no |
| `1.2.3-beta.1` | `beta` | ❌ no |
| `1.2.3-alpha.1` | `alpha` | ❌ no |
| `1.2.3-canary.1` | `canary` | ❌ no |

Prereleases are intentionally kept off `latest`, so `npm install` never hands a
user a `-rc` or `-beta` build by accident. Users opt in explicitly:

```bash
npm install @serkanalgur/residue@next
```

### Unknown prerelease identifiers fail the run

Only the identifiers in the table above are recognised. A version with any other
prerelease suffix — `1.2.3-preview.1`, `1.2.3-test.4` — **fails the publish run**
with an explicit error instead of falling back to `latest`:

```
Unrecognised prerelease identifier 'preview' in version 1.2.3-preview.1.
Add it to the case statement in publish.yml or publish as a stable release.
```

This is deliberate. Silently defaulting to `latest` would promote an unreviewed
build to the default version for every consumer, which is far worse than a
failed release. If you genuinely need a new channel, add it to the `case`
statement in `.github/workflows/publish.yml` and document it in the table above.

Build metadata does not affect the mapping: `1.0.0+build.7` is treated as stable
(`latest`), because semver build metadata does not change precedence.

## Reporting Issues

If you find a bug or have a feature request, please open an issue on GitHub with:

- A clear title and description
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Your environment:
  - OpenCode version
  - Bun version (`bun --version`)
  - Operating system
- The relevant `options` block from your `opencode.jsonc` (redact any API keys or secrets)

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive experience for everyone. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
