# Configuration Reference

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | **Yes** | Required for embeddings (`text-embedding-3-small`) regardless of which LLM provider you use for extraction. Even if you use Anthropic for everything else, embeddings go through OpenAI. |

## Config File

Location: `~/.agenr/config.json`

Created and updated by `agenr setup`. You can also edit it directly or use `agenr config set <key> <value>`.

Stores:
- `auth` — authentication method (see [Auth Methods](#auth-methods))
- `provider` — LLM provider (`anthropic` or `openai`)
- `model` — model name for extraction
- `credentials` — stored API keys (encrypted at rest)
- `labelProjectMap` — optional mapping from normalized session labels to project names

### Example (~/.agenr/config.json)

```json
{
  "labelProjectMap": {
    "agenr-dev": "agenr",
    "openclaw": "openclaw"
  }
}
```

## Database

Default path: `~/.agenr/knowledge.db`

Override with the `--db <path>` flag on any command that touches the database (`store`, `recall`, `consolidate`, `mcp`, `db stats`, etc.).

The database is a local libsql/SQLite file. Migrations auto-apply on first run (see [Migrations](#migrations)).

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
1. Already use Codex CLI? → `openai-subscription`
2. Already use Claude CLI? → `anthropic-token`
3. Have an OpenAI API key? → `openai-api-key`
4. Have an Anthropic API key? → `anthropic-api-key`
5. Have a Claude.ai subscription? → `anthropic-oauth`

> **Note:** Subscription-based auth methods (`openai-subscription`, `anthropic-token`, `anthropic-oauth`) discover credentials from your local CLI installations. Ensure your use of subscription credentials complies with your provider's terms of service.

> **Remember:** Regardless of which auth method you pick for extraction, you still need `OPENAI_API_KEY` for embeddings.

## How `setup` Works

`agenr setup` is interactive. It:
1. Asks which auth method to use
2. Prompts for credentials if needed (API keys, OAuth login)
3. Lets you pick a default model
4. Writes everything to `~/.agenr/config.json`

Environment variables (`OPENAI_API_KEY`, etc.) take precedence over config file values for embedding API key resolution. The resolution order for the embedding key is:
1. `config.embedding.apiKey`
2. `config.credentials.openaiApiKey`
3. `OPENAI_API_KEY` environment variable

## Migrations

Database migrations auto-apply on first run after an upgrade. We recommend backing up your database (`~/.agenr/knowledge.db`) before major version upgrades:

```bash
cp ~/.agenr/knowledge.db ~/.agenr/knowledge.db.backup
```
