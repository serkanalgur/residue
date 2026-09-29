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
