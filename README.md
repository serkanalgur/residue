# Residue

Persistent, local-first project memory for OpenCode V2.

Residue extracts atomic "decision + reason" facts from coding sessions and injects relevant notes into future model calls via context hooks. All data lives on disk in SQLite — no cloud, no sync, no vendor lock-in.

## Installation

Add Residue as an OpenCode plugin in your `.opencode/config.json`:

```json
{
  "plugin": {
    "residue": {
      "source": "npm:residue"
    }
  }
}
```

## How It Works

1. **Ingestion**: Listens to session events (`session.text.delta` feeds a turn buffer; `session.idle` triggers extraction). An LLM call extracts durable facts from the conversation.

2. **Storage**: Facts are stored in a local SQLite database with scope isolation (project + worktree). FTS5 enables full-text search; optional vector embeddings enable semantic search.

3. **Injection**: A `context` hook runs before every model call, retrieves relevant memories via hybrid search (lexical + vector with Reciprocal Rank Fusion), and injects them as `<recalled_notes>` system parts.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `autoCapture` | `true` | Automatically extract facts from conversations |
| `embedding` | `"auto"` | Embedding strategy: `auto`, `remote`, `ollama`, `local`, `none` |
| `embeddingKeyEnv` | `"OPENAI_API_KEY"` | Env var for the embedding API key |
| `dataDir` | `"xdg"` | Data location: `xdg` (XDG_DATA_HOME) or `project` (.opencode/residue/) |
| `inject.enabled` | `true` | Enable/disable context injection |
| `inject.maxChars` | `2400` | Maximum characters to inject per call |
| `inject.maxFacts` | `6` | Maximum facts to inject |
| `inject.minScore` | `0.34` | Minimum similarity score threshold |
| `inject.shareAcrossWorktrees` | `true` | Share facts across worktrees of the same project |
| `debug` | `false` | Enable debug logging |

## Tools

Residue registers three tools under the `res` namespace:

- **`res_search`** — Hybrid memory search (FTS5 + vector via RRF)
- **`res_add`** — Manually add a memory record with provenance
- **`res_status`** — Plugin health, store status, embedder state

## Privacy & Security

- **Local-first**: All data stays on your machine in SQLite. No telemetry, no cloud sync.
- **Scope isolation**: Project records are isolated by project ID + worktree key. Cross-project leakage is prevented at the SQL level.
- **Secret redaction**: API keys, tokens, and sensitive file references are automatically redacted from extracted text before storage.
- **Provenance mandatory**: Records without a source (session ID + timestamp) are silently discarded.
- **Sub-agent guard**: `res_add` is removed for non-build agents to prevent sub-agents from polluting project memory.

## Differences from opencode-mem

| Feature | Residue | opencode-mem |
|---------|---------|--------------|
| Storage | SQLite (file-backed, WAL mode) | In-memory only |
| Search | Hybrid (FTS5 + vector with RRF) | Basic text match |
| Scope | Project + worktree isolation | Global only |
| Injection | Context hook with memoisation | N/A |
| Embedding | Auto/remote/ollama/local fallback | Fixed provider |
| Persistence | Survives restarts | Lost on restart |

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
```

## License

MIT — see [LICENSE](./LICENSE).
