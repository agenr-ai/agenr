# Configuration Reference

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | **Yes** | Required for embeddings (`text-embedding-3-small`) regardless of which LLM provider you use for extraction. Even if you use Anthropic for everything else, embeddings go through OpenAI. |
| `AGENR_CONFIG_PATH` | No | Override the config file location (default `~/.agenr/config.json`). |

## Config File

Location: `~/.agenr/config.json`

Created and updated by `agenr setup`. You can also edit it directly or use `agenr config set <key> <value>`.

### Top-level keys

| Key | Type | Description |
|-----|------|-------------|
| `auth` | string | Authentication method (see [Auth Methods](#auth-methods)). |
| `provider` | string | LLM provider: `anthropic`, `openai`, or `openai-codex`. |
| `model` | string | Model name for extraction. |
| `credentials` | object | Stored API keys (see [Credentials](#credentials)). |
| `embedding` | object | Embedding provider settings (see [Embedding](#embedding)). |
| `db` | object | Database path configuration (see [Database](#database)). |
| `labelProjectMap` | object | Map normalized session labels to project names for auto-tagging. |
| `forgetting` | object | Forgetting policy (see [Forgetting](#forgetting)). |
| `dedup` | object | Deduplication tuning (see [Dedup](#dedup)). |

### Credentials

Stored in the `credentials` object. Managed by `agenr setup` or `agenr config set-key`.

| Field | Type | Description |
|-------|------|-------------|
| `anthropicApiKey` | string | Anthropic API key. |
| `anthropicOauthToken` | string | Long-lived Anthropic OAuth/session token. |
| `openaiApiKey` | string | OpenAI API key. |

### Embedding

Controls the embedding provider used for semantic search. Currently only OpenAI is supported.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"openai"` | Embedding provider. |
| `model` | string | `"text-embedding-3-small"` | Embedding model name. |
| `dimensions` | number | `1024` | Embedding vector dimensions. |
| `apiKey` | string | - | Override embedding API key (takes priority over `credentials.openaiApiKey` and `OPENAI_API_KEY` env var). |

Embedding API key resolution order:
1. `embedding.apiKey` in config
2. `credentials.openaiApiKey` in config
3. `OPENAI_API_KEY` environment variable

### Database

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `~/.agenr/knowledge.db` | Path to the SQLite knowledge database. |

Override per-command with the `--db <path>` flag on any command that touches the database (`store`, `recall`, `consolidate`, `health`, `mcp`, `db stats`, etc.).

The database is a local libsql/SQLite file. Migrations auto-apply on first run (see [Migrations](#migrations)).

### labelProjectMap

Maps normalized session labels to project names. When the watcher processes a session file, it uses this map to auto-tag extracted entries with the correct project.

```json
{
  "labelProjectMap": {
    "agenr-dev": "agenr",
    "openclaw": "openclaw"
  }
}
```

### Forgetting

Controls automatic forgetting of low-value entries during `agenr consolidate --forget`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master toggle. When `false`, all forgetting is disabled and other fields are ignored. |
| `protect` | string[] | `[]` | Subject patterns to protect from forgetting. Supports glob wildcards (e.g., `"project-*"`). |
| `scoreThreshold` | number | `0.05` | Entries with a forgetting score below this threshold are candidates for deletion. |
| `maxAgeDays` | number | `60` | Age threshold for forgetting eligibility. |

```json
{
  "forgetting": {
    "enabled": true,
    "protect": ["EJA identity", "project-*"],
    "scoreThreshold": 0.05,
    "maxAgeDays": 60
  }
}
```

### Dedup

Controls deduplication behavior when storing entries. Applies globally to all store paths (CLI, MCP, and the OpenClaw plugin).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `aggressive` | boolean | `false` | Enable aggressive dedup: uses a lower similarity threshold (0.62) and checks more candidates (10). Useful in high-noise environments. |
| `threshold` | number (0.0-1.0) | `0.72` | Override the LLM dedup similarity threshold. Entries above this threshold trigger LLM review. Lower values mean more entries reach the LLM reviewer. |

```json
{
  "dedup": {
    "aggressive": true,
    "threshold": 0.65
  }
}
```

## Auth Methods

`agenr setup` will ask you to choose an auth method. Here's a decision guide:

| Method | When to use | How it works |
|---|---|---|
| `openai-subscription` | You use Codex CLI | Reuses Codex CLI credentials from `~/.codex/auth.json` or macOS keychain. No extra API key needed. |
| `openai-api-key` | You have an OpenAI API key | Uses your API key directly. Set via `agenr setup` or `agenr config set-key openai <key>`. |
| `anthropic-api-key` | You have an Anthropic API key | Uses your API key directly. Set via `agenr setup` or `agenr config set-key anthropic <key>`. |
| `anthropic-oauth` | You have a Claude.ai subscription | Browser-based OAuth login to Claude.ai. |
| `anthropic-token` | You use Claude CLI | Reuses session tokens from `~/.claude/.credentials.json` or macOS keychain. |

**Quick decision tree:**
1. Already use Codex CLI? -> `openai-subscription`
2. Already use Claude CLI? -> `anthropic-token`
3. Have an OpenAI API key? -> `openai-api-key`
4. Have an Anthropic API key? -> `anthropic-api-key`
5. Have a Claude.ai subscription? -> `anthropic-oauth`

> **Note:** Subscription-based auth methods (`openai-subscription`, `anthropic-token`, `anthropic-oauth`) discover credentials from your local CLI installations. Ensure your use of subscription credentials complies with your provider's terms of service.

> **Remember:** Regardless of which auth method you pick for extraction, you still need `OPENAI_API_KEY` for embeddings.

## How `setup` Works

`agenr setup` is interactive. It:
1. Asks which auth method to use
2. Prompts for credentials if needed (API keys, OAuth login)
3. Lets you pick a default model
4. Writes everything to `~/.agenr/config.json`

Config file values take precedence over environment variables for embedding API key resolution: `embedding.apiKey` -> `credentials.openaiApiKey` -> `OPENAI_API_KEY` env var. See [Embedding](#embedding) for details.

## Migrations

Database migrations auto-apply on first run after an upgrade. We recommend backing up your database (`~/.agenr/knowledge.db`) before major version upgrades:

```bash
cp ~/.agenr/knowledge.db ~/.agenr/knowledge.db.backup
```
