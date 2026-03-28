```text
 █████╗  ██████╗ ███████╗███╗   ██╗██████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔══██╗
███████║██║  ███╗█████╗  ██╔██╗ ██║██████╔╝
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██╔══██╗
██║  ██║╚██████╔╝███████╗██║ ╚████║██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝
  AGENt memoRy
```

# agenr

Local-first, durable memory infrastructure for AI agents.

## What is agenr?

agenr gives agents a persistent brain: a local SQLite database of durable knowledge that survives across sessions, tools, and agent restarts. Instead of relying on fragile prompt state or file-based scratch memory, agents can ingest transcripts, extract decisions and lessons, store them as typed entries, and recall them later with semantic search and memory-aware ranking.

It exists because most agent runtimes forget everything important between sessions. Even when a tool has a built-in memory feature, it is often lossy, file-based, or tightly coupled to one surface. agenr keeps memory structured and queryable: facts, decisions, preferences, lessons, todos, events, and relationships live in one local store instead of getting flattened into prompt text.

What makes agenr different is the combination of local-first storage, semantic embeddings, hybrid recall, and adapter-friendly architecture. The core is hexagonal, so multiple agent systems can share the same brain over time. Today the production adapter is the OpenClaw memory plugin, and the CLI provides offline ingest and recall against that same database.

## Features

- Hybrid recall: vector similarity, lexical FTS, temporal awareness, recency decay, and importance weighting.
- LLM-powered knowledge extraction from conversation transcripts.
- Semantic deduplication using exact hashes, normalized hashes, embeddings, and within-run clustering.
- Session continuity with predecessor resolution, recent transcript tails, and LLM-generated session summaries.
- Agent tools for `store`, `recall`, `retire`, `update`, and `trace` through the OpenClaw plugin.
- Native OpenClaw memory plugin that replaces OpenClaw's built-in memory slot.
- Local-first storage with SQLite/libSQL. Memory stays on your machine; only model and embedding calls leave it.
- Designed for multi-agent systems so future adapters can share the same database.

## Quick Start - The Recommended Way

```bash
pnpm install -g agenr
agenr init
```

That's it. The interactive wizard handles everything.

It walks through:

- auth setup for OpenAI API keys, Anthropic API keys, OpenAI subscription auth via Codex CLI, or Anthropic subscription auth via OAuth/token
- model selection filtered by the auth method you chose
- OpenAI embedding key setup
- OpenClaw detection and optional plugin installation
- session scanning and optional bulk ingestion of existing transcripts

Run `agenr init` again any time you want to re-run onboarding, reinstall the plugin, or ingest another batch of existing sessions.

## Quick Start - OpenClaw Plugin (manual)

If you already have agenr configured, or you want to install the plugin separately:

```bash
openclaw plugins install agenr
openclaw gateway restart
```

`agenr init` normally does this for you, updates `openclaw.json`, and offers an initial ingest pass over existing sessions.

For local development or a custom build path, run `pnpm build` first and point OpenClaw at the built plugin directory:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/agenr/dist/adapters/openclaw"] },
    "allow": ["agenr"],
    "slots": { "memory": "agenr" },
    "entries": {
      "agenr": {
        "enabled": true,
        "config": {
          "dbPath": "~/.agenr/knowledge.db"
        }
      }
    }
  }
}
```

If `config.json` is not next to `dbPath`, add `"configPath": "/path/to/config.json"` inside `plugins.entries.agenr.config`.

## Configuration

`agenr init` and `agenr setup` handle configuration interactively. By default, agenr stores config at `~/.agenr/config.json` and the database at `~/.agenr/knowledge.db`.

Overrides:

- `AGENR_CONFIG_DIR` changes the default config directory.
- `AGENR_CONFIG_PATH` points directly at a specific `config.json`.
- `AGENR_DB_PATH` overrides the database path.

When agenr runs as an OpenClaw plugin, `configPath` is optional. If you omit it, agenr will look for `config.json` next to the configured `dbPath`.

Key config fields:

| Field                            | What it does                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                           | Authentication method: `openai-api-key`, `openai-subscription`, `anthropic-api-key`, `anthropic-oauth`, or `anthropic-token`.                                                     |
| `provider` / `model`             | Default LLM provider and model used for extraction tasks unless overridden.                                                                                                       |
| `credentials`                    | Stored manual credentials. Today that can include `openaiApiKey`, `anthropicApiKey`, and `anthropicOauthToken`. The config file is written with locked-down permissions (`0600`). |
| `credentials.openaiApiKey`       | OpenAI key used for embeddings, and also for extraction when `auth` is `openai-api-key`. Older configs may still rely on legacy `embeddingApiKey` or `apiKey` fallback fields.    |
| `embeddingModel`                 | Embedding model. Defaults to `text-embedding-3-small`.                                                                                                                            |
| `extractionModel` / `dedupModel` | Optional per-pipeline overrides so extraction and dedup can use different provider/model pairs.                                                                                   |
| `extractionContext`              | Optional user context injected into extraction prompts to help the model decide what is worth remembering.                                                                        |
| `dbPath`                         | Knowledge database location. Defaults to `~/.agenr/knowledge.db` unless overridden.                                                                                               |

Important: when agenr is running as an OpenClaw plugin, session summaries use OpenClaw's configured LLM and auth, not agenr's. Agenr's config is still required for embeddings and for CLI-based ingestion/recall.

## What You Need

- An OpenAI API key for embeddings. Agenr uses `text-embedding-3-small`, and embedding cost is typically fractions of a penny.
- For LLM extraction, one of: an OpenAI API key, OpenAI subscription auth via Codex CLI, an Anthropic API key, or Anthropic subscription auth via OAuth/token.
- `agenr init` handles all of this interactively.

## CLI Commands

The current CLI surface is intentionally small. Today the `db` group only exposes `reset`.

| Command                | What it does                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agenr init`           | Interactive first-run wizard: auth, model selection, OpenClaw detection, plugin install, and optional initial ingestion. |
| `agenr setup`          | Configure auth, model defaults, embeddings, and the agenr database path.                                                 |
| `agenr recall <query>` | Run the hybrid recall pipeline with optional temporal and type/tag filters.                                              |
| `agenr ingest <path>`  | Bulk-ingest one file or directory of OpenClaw transcript files.                                                          |
| `agenr db reset`       | Delete and recreate the knowledge database.                                                                              |

The OpenClaw plugin also gives the agent five tools directly inside the runtime: `agenr_store`, `agenr_recall`, `agenr_retire`, `agenr_update`, and `agenr_trace`.

Examples:

```bash
# Recall knowledge
agenr recall "what decisions did we make about the API?"

# Ingest transcripts
agenr ingest ~/.openclaw/agents/main/sessions/

# Reset the database
agenr db reset
```

## Architecture

- Hexagonal structure: `src/core/` contains pure logic and `src/adapters/` contains infrastructure.
- The core never imports from adapters or CLI code.
- OpenClaw, the CLI, and future adapters all target the same underlying memory brain.

See [AGENTS.md](./AGENTS.md) for the full architecture and repository conventions.

## How Recall Works

Recall is a hybrid pipeline. Agenr embeds the query, retrieves candidates through both vector search and SQLite FTS, merges those candidates, then scores them using lexical overlap, vector similarity, recency/around-date logic, and entry importance before returning the final ranking. Temporal filters like `--since` and `--until` are hard filters; `--around` is a ranking bias. Details: [docs/RECALL.md](./docs/RECALL.md).

## How Ingestion Works

Ingestion is transcript-to-memory: parse OpenClaw JSONL transcripts, normalize them, choose whole-file or chunked extraction, run LLM extraction, validate the structured entries, deduplicate them within the ingest run, generate embeddings, and then persist surviving entries through the store pipeline. The current CLI ingest path is OpenClaw-transcript-specific. Details: [docs/INGEST.md](./docs/INGEST.md) and [docs/STORE.md](./docs/STORE.md).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm check        # format + lint + typecheck + test
```

## Troubleshooting

| Problem                                                           | What to check                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agenr init` cannot complete setup                                | Re-run `agenr setup` and verify the selected auth method is actually available. Subscription flows depend on the relevant external login being present, and non-OpenAI extraction setups still need a separate OpenAI embedding key. |
| `openclaw plugins install agenr` fails                            | Make sure the `openclaw` CLI is installed and on `PATH`. For local development, run `pnpm build` and use `plugins.load.paths` instead.                                                                                               |
| `agenr recall` or `agenr_recall` fails with embedding/auth errors | Embeddings always use OpenAI. Confirm `credentials.openaiApiKey` is configured, or re-run `agenr setup` to set the embedding key explicitly.                                                                                         |
| SQLite says the database is locked                                | Avoid running multiple writers against the same DB at once. Stop overlapping ingest/reset runs, restart the OpenClaw gateway if needed, then retry.                                                                                  |
| OpenClaw does not pick up the plugin                              | Restart the gateway, confirm `plugins.slots.memory` is `agenr`, confirm `plugins.allow` contains `agenr`, and for dev installs confirm `plugins.load.paths` points at the built `dist/adapters/openclaw` directory.                  |

## License

AGPL-3.0
