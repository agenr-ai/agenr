# agenr

**AGENt memoRy** — persistent memory for AI tools. Extract, store, and recall knowledge across sessions, tools, and time.

agenr gives AI coding tools (Claude Code, Codex, Cursor, Windsurf) a shared, persistent memory. What one tool learns, every tool remembers. No more starting from scratch every session.

## Why

AI tools are brilliant but amnesiac. Every session starts at zero — no memory of yesterday's decisions, no recall of architectural patterns, no awareness of accumulated context.

agenr fixes this. It extracts structured knowledge from conversations, stores it locally, and makes it available to any MCP-compatible tool. One brain, many tools.

## Quick Start

```bash
# Install
npm install -g agenr

# Configure (interactive)
agenr setup

# Extract knowledge from a transcript
agenr extract session.jsonl

# Store and recall
agenr extract session.jsonl --json | agenr store
agenr recall "what database are we using"

# Bulk ingest files
agenr ingest ./notes/ ./transcripts/

# Watch a live session
agenr watch session.jsonl --interval 120

# Start MCP server (for Claude Code, Codex, etc.)
agenr mcp
```

## MCP Server — Cross-Tool Memory

The killer feature. Add agenr as an MCP server and every AI tool shares one knowledge base:

```json
{
  "mcpServers": {
    "agenr": {
      "command": "agenr",
      "args": ["mcp"]
    }
  }
}
```

This works with Claude Code, Codex, Cursor, Windsurf, and any MCP-compatible client.

### MCP Tools

| Tool | Description |
|------|-------------|
| `agenr_recall` | Semantic search across stored knowledge |
| `agenr_store` | Store new knowledge entries |
| `agenr_extract` | Extract knowledge from raw text |

What Codex learns while building your feature, Claude Code remembers when debugging it. What Cursor learns about your codebase, Windsurf can recall. The knowledge compounds.

## Commands

### `agenr extract <files...>`

Extract structured knowledge from transcript files (JSONL, markdown, plain text).

```bash
agenr extract session.jsonl
agenr extract session.jsonl --json | agenr store
```

Extracts 7 entry types: **fact**, **decision**, **preference**, **todo**, **relationship**, **event**, **lesson**.

### `agenr store`

Store knowledge entries from stdin (pipe from `extract --json`).

```bash
agenr extract session.jsonl --json | agenr store
```

Smart deduplication with 3 cosine similarity bands:
- **>0.98**: Exact duplicate, skip
- **0.92-0.98**: Same knowledge, confirm/update existing entry
- **<0.92**: New knowledge, insert

### `agenr recall <query>`

Semantic search with FSRS-based scoring.

```bash
agenr recall "what is Jim's preferred package manager"
agenr recall "architecture decisions" --types decision --since 7d --limit 20
agenr recall --context session-start  # Bootstrap a new session with key context
```

Scoring combines vector similarity, recency (power-law decay), Bayesian confidence, and full-text search boost.

### `agenr ingest <paths...>`

Bulk ingest knowledge from files and directories.

```bash
agenr ingest ./notes/ ./transcripts/ ./memory.md
agenr ingest ./project/ --glob "**/*.md" --verbose
agenr ingest ./sessions/ --dry-run  # Preview without storing
```

Supports JSONL transcripts, markdown, and plain text. Checks the ingest log to skip already-processed files.

### `agenr watch <file>`

Live file watcher. Monitors a file for changes and auto-extracts + stores new knowledge.

```bash
agenr watch ~/.openclaw/sessions/current.jsonl --interval 120
```

Perfect for monitoring active AI sessions — knowledge is captured as it happens.

### `agenr mcp`

Start the MCP server (stdio transport, JSON-RPC 2.0).

```bash
agenr mcp
agenr mcp --verbose  # Log requests to stderr
```

### `agenr db <subcommand>`

Database management.

```bash
agenr db stats    # Entry counts, type breakdown, top tags
agenr db export   # Export all entries as JSON
agenr db reset    # Clear all data (with confirmation)
agenr db path     # Print database file path
```

### `agenr setup`

Interactive configuration wizard. Sets provider, auth method, and model.

### `agenr config show|set|set-key`

Manage configuration directly.

```bash
agenr config show
agenr config set provider openai
agenr config set-key openai sk-proj-...
```

### `agenr auth status`

Live authentication check against the configured provider.

## How It Works

### Knowledge Extraction

agenr reads transcripts (AI conversations, meeting notes, plain text) and extracts structured knowledge entries using an LLM. Each entry has a type, subject, content, confidence level, expiry tier, and tags.

### Storage

Entries are stored in a local SQLite database (`~/.agenr/knowledge.db`) with vector embeddings for semantic search. Smart deduplication prevents redundant entries while allowing knowledge to evolve over time.

### Recall

Retrieval uses a multiplicative scoring formula grounded in cognitive science:

- **Vector similarity** — semantic relevance to the query
- **Recency** — FSRS power-law forgetting curve (recent knowledge scores higher)
- **Confidence** — Bayesian confidence with prior decay toward uncertainty
- **Recall strength** — entries that are recalled more often score higher (spacing effect)
- **Full-text boost** — exact keyword matches get a bonus

### Memory Tiers

Entries have expiry tiers inspired by human memory:

| Tier | Half-life | Example |
|------|-----------|---------|
| `permanent` | 365 days | Biographical facts, preferences |
| `temporary` | 30 days | Current project decisions, recent events |
| `session-only` | 3 days | Immediate context, ephemeral details |

## Configuration

Config is stored in `~/.agenr/config.json`. Run `agenr setup` for interactive configuration.

### Supported Providers

- **Anthropic** — OAuth, token, or API key
- **OpenAI** — API key or Codex subscription

### Environment Variables

Secrets only (don't choose provider/model):

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_OAUTH_TOKEN`
- `OPENAI_API_KEY`

## Architecture

```
agenr extract  →  LLM extracts structured entries from text
agenr store    →  Dedup + embed + store in local SQLite
agenr recall   →  Vector search + FSRS scoring
agenr watch    →  File watcher → extract → store (loop)
agenr ingest   →  Batch extract → store across files
agenr mcp      →  JSON-RPC 2.0 server exposing recall/store/extract
```

Everything runs locally. No cloud services, no data leaves your machine (except LLM API calls for extraction).

## Development

```bash
git clone https://github.com/agenr-ai/agenr.git
cd agenr
pnpm install
pnpm build
pnpm test
```

## License

MIT
