# agenr MCP Integration

## What MCP Is

Model Context Protocol (MCP) is a standard for exposing tools over a consistent interface so LLM clients can call external capabilities (like memory retrieval and persistence) using structured tool calls instead of ad hoc prompts.

## Why agenr + MCP

agenr centralizes memory in one local database, while MCP lets multiple AI clients read/write that same memory. Instead of separate memory silos per tool, you get one shared memory layer with consistent extraction, storage, and recall behavior.

## Start the MCP Server

```bash
pnpm exec agenr mcp
```

Optional flags:
- `--db <path>`: database path override
- `--verbose`: logs JSON-RPC traffic to stderr

Protocol details:
- transport: stdio
- JSON-RPC: 2.0
- MCP protocol version: `2024-11-05`
- tools: `agenr_recall`, `agenr_store`, `agenr_extract`

## Codex Setup (`~/.codex/config.toml`)

```toml
[mcp_servers.agenr]
command = "node"
args = ["/absolute/path/to/agenr/dist/cli.js", "mcp", "--db", "/absolute/path/to/knowledge.db"]
env = { OPENAI_API_KEY = "your-key-here" }
```

Notes:
- This shape matches working Codex TOML MCP configuration.
- Keep secrets out of committed files.

## Claude Code Setup (project `.mcp.json`)

```json
{
  "mcpServers": {
    "agenr": {
      "command": "node",
      "args": ["/absolute/path/to/agenr/dist/cli.js", "mcp"],
      "env": {
        "OPENAI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Notes:
- Use project-level `.mcp.json` so config travels with the repo.
- `mcpServers` is the expected key.

## Other MCP Clients (Generic stdio config)

If your client supports stdio servers, configure:
- command: `node`
- args: `[/absolute/path/to/agenr/dist/cli.js, mcp]`
- env: `OPENAI_API_KEY=...`

Equivalent shell command:

```bash
OPENAI_API_KEY=your-key-here node /absolute/path/to/agenr/dist/cli.js mcp
```

## Tool Reference

Source of truth:
- `src/mcp/server.ts`

### `agenr_recall`

Retrieve relevant memories using semantic search.

Parameters:
- `query` (string, required): search text
- `limit` (integer, optional, default `10`): max results
- `types` (string, optional): comma-separated entry types
- `since` (string, optional): ISO date or relative (`7d`, `24h`, `1m`, `1y`)
- `threshold` (number, optional, default `0`): minimum score `0.0..1.0`

Example call payload:

```json
{
  "name": "agenr_recall",
  "arguments": {
    "query": "what did we decide about package management",
    "limit": 5,
    "types": "decision,preference",
    "threshold": 0.5
  }
}
```

Typical response text:

```text
Found 2 results for "what did we decide about package management":

[1] (score: 0.812, type: decision, 2026-02-14)
We switched this project to pnpm.
```

### `agenr_store`

Store structured entries in the memory DB.

Parameters:
- `entries` (array, required)
- Each entry supports:
- `content` (string, required)
- `type` (enum, required): `fact|decision|preference|todo|relationship|event|lesson`
- `confidence` (number, optional, `0.0..1.0`, default `0.8`)
- `source` (string, optional)
- `tags` (string[], optional)
- `scope` (enum, optional, default `personal`): `private|personal|public`

Example call payload:

```json
{
  "name": "agenr_store",
  "arguments": {
    "entries": [
      {
        "type": "decision",
        "content": "Use pnpm for this repository.",
        "confidence": 0.9,
        "tags": ["tooling", "package-manager"],
        "source": "standup-2026-02-15",
        "scope": "personal"
      }
    ]
  }
}
```

Typical response text:

```text
Stored 1 entries (1 new, 0 updated, 0 duplicates skipped).
```

### `agenr_extract`

Extract structured knowledge from raw text; optionally store extracted entries.

Parameters:
- `text` (string, required): raw text block
- `store` (boolean, optional, default `false`): persist results
- `source` (string, optional): source label override

Example call payload:

```json
{
  "name": "agenr_extract",
  "arguments": {
    "text": "We moved to pnpm and should keep lockfile policy strict.",
    "store": true,
    "source": "meeting-notes-2026-02-15"
  }
}
```

Typical response text:

```text
Extracted 2 entries from text:

[1] (decision) We moved to pnpm.
Stored: 1 new, 0 updated, 1 duplicates skipped.
```

## Teach Your AI to Use agenr

Add this to your project `AGENTS.md`:

```md
## Memory Policy

- At session start, call `agenr_recall` for the active task/topic.
- When making decisions, call `agenr_store` with `type: decision` and clear tags.
- When given large raw notes/transcripts, call `agenr_extract` first.
- Before answering complex questions, recall relevant memory and cite what was recalled.
```

## Troubleshooting

### Missing OpenAI API key

Symptoms:
- `agenr_recall` / `agenr_store` tool calls fail with embedding key errors.

Fix:
- Set `OPENAI_API_KEY` in MCP server env, or configure via `agenr setup` / `agenr config set-key openai <key>`.

### Wrong DB path

Symptoms:
- empty recalls from one client while another has data.

Fix:
- Ensure all MCP clients point to the same DB (`agenr mcp --db /same/path/knowledge.db`).
- Verify path with:

```bash
pnpm exec agenr db path --db /same/path/knowledge.db
```

### Tool call validation errors

Symptoms:
- MCP returns invalid params errors.

Fix:
- Match exact schema types from this doc and `src/mcp/server.ts`.
- Keep `types` as comma-separated string for `agenr_recall`, not array.
- Keep `confidence` within `0..1` for `agenr_store`.
