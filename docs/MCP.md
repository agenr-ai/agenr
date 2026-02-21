# agenr MCP Integration

## What MCP Is

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is a standard for exposing tools over a consistent interface so LLM clients can call external capabilities (like memory retrieval and persistence) using structured tool calls instead of ad hoc prompts.

## Why agenr + MCP

agenr centralizes memory in one local database, while MCP lets multiple AI clients read/write that same memory. Instead of separate memory silos per tool, you get one shared memory layer with consistent extraction, storage, and recall behavior.

Note: OpenClaw users do not use the MCP server. agenr ships as a native OpenClaw
plugin. See [OPENCLAW.md](./OPENCLAW.md) for OpenClaw-specific setup. This document
covers Codex, Claude Code, and other MCP-compatible clients.

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
- tools: `agenr_recall`, `agenr_store`, `agenr_extract`, `agenr_retire`

## Codex Setup (`~/.codex/config.toml`)

```toml
[mcp]
agenr = { command = "agenr", args = ["mcp"], env = { AGENR_PROJECT_DIR = "/path/to/project", OPENAI_API_KEY = "your-key" } }
```

Notes:
- Codex reads MCP config from `~/.codex/config.toml`, not project `.mcp.json`.
- `agenr init --platform codex` still writes project `.mcp.json` for compatibility with other clients. Codex ignores that file.

## Claude Code Setup (project `.mcp.json`)

```json
{
  "mcpServers": {
    "agenr": {
      "command": "agenr",
      "args": ["mcp"],
      "env": {
        "AGENR_PROJECT_DIR": "/path/to/project",
        "OPENAI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Notes:
- Use project-level `.mcp.json` so config travels with the repo.
- If your existing config already uses a `mcpServers` wrapper, agenr merges into that shape.

## Other MCP Clients (Generic stdio config)

If your client supports stdio servers, configure:
- command: `agenr`
- args: `[mcp]`
- env: `AGENR_PROJECT_DIR=/path/to/project`, `OPENAI_API_KEY=...`

Equivalent shell command:

```bash
AGENR_PROJECT_DIR=/path/to/project OPENAI_API_KEY=your-key-here agenr mcp
```

## Project Scoping (Recommended for Coding Agents)

By default, agenr uses a single global database (`~/.agenr/knowledge.db`). This works well for personal assistants, but coding agents typically want to avoid cross-project memory pollution (for example, recalling "use pnpm" in a Python repo).

agenr supports two approaches:
- **Project tagging (single DB):** entries have an optional `project` tag (`entries.project`). With MCP, `AGENR_PROJECT_DIR` + `.agenr/config.json` sets default scope automatically for `agenr_recall` and default project for `agenr_store`.
- **Per-project databases:** pass `--db` to run MCP against a project-local database (for stricter isolation).

### Manual setup (per-project DB)

Pass `--db` to scope the MCP server to a project-local database:

**Project `.mcp.json`:**
```json
{
  "mcpServers": {
    "agenr": {
      "command": "agenr",
      "args": ["mcp", "--db", ".agenr/knowledge.db"],
      "env": {
        "AGENR_PROJECT_DIR": "/path/to/project",
        "OPENAI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Add `.agenr/knowledge.db` and `.agenr/knowledge.db-*` to your `.gitignore`.

Project tagging and filtering can be used alongside `--db`.

## Tool Reference

Source of truth:
- `src/mcp/server.ts`

### `agenr_recall`

Retrieve relevant memories using semantic search.

Parameters:
- `query` (string, optional): search text. Required when context is `default` (or omitted). Not needed for `session-start` context.
- `context` (string, optional, default `default`): Use `session-start` for fast bootstrap without embedding call (no `query` needed). Other value: `default`.
- `limit` (integer, optional, default `10`): max results
- `types` (string, optional): comma-separated entry types
- `since` (string, optional): ISO date or relative (`7d`, `24h`, `1m`, `1y`)
- `threshold` (number, optional, default `0`): minimum score `0.0..1.0`
- Note: threshold is only available when using the MCP server directly. The native
  OpenClaw plugin does not expose this parameter.
- `platform` (string, optional): platform filter (`openclaw`, `claude-code`, `codex`)
- `project` (string, optional):
  - omit to use configured project scope (project + dependencies from `.agenr/config.json`)
  - pass `*` to bypass scope and search all projects
  - pass an explicit value to query only that project (dependencies are not expanded)

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

Session-start recall (no query needed):

```json
{
  "name": "agenr_recall",
  "arguments": {
    "context": "session-start",
    "limit": 20
  }
}
```

Typical response text:

```text
Found 2 results for "what did we decide about package management":

[1] [id=entry-abc-123] (score: 0.812, type: decision, 2026-02-14)
We switched this project to pnpm.
```

### `agenr_store`

Store structured entries in the memory DB.

`agenr_store` runs online dedup against existing DB entries by default.

Parameters:
- `entries` (array, required)
- `platform` (string, optional): platform tag applied to all stored entries (`openclaw`, `claude-code`, `codex`)
- `project` (string, optional): project tag applied to all stored entries (lowercase)
- Each entry supports:
- `content` (string, required)
- `type` (enum, required): `fact|decision|preference|todo|relationship|event|lesson`
- `importance` (integer, optional, `1..10`, default `7`)
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
        "importance": 7,
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
Stored: 1 new, 0 updated, 1 duplicates skipped, 0 superseded.
```

### `agenr_retire`

agenr_retire marks a single memory entry as retired (soft delete). Retired entries
are excluded from all recall but are not deleted from the database.

Parameters:
- `entry_id` (string, required): single entry ID to retire. To retire multiple entries, make multiple calls.
- `reason` (string, optional): retirement reason.
- `persist` (boolean, optional, default `false`): persist retirement to ledger so it survives re-ingest.

Example call payload:

```json
{
  "name": "agenr_retire",
  "arguments": {
    "entry_id": "entry-123",
    "reason": "obsolete",
    "persist": true
  }
}
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

### Importance calibration

Score 7 is the default. Most entries should be 7 -- stored silently.

Score 8+ fires a real-time cross-session signal in OpenClaw. Ask: "Would
an active parallel session need to act on this right now?" If no, use 7.
Cap: no more than 20% of stored entries should be 8 or higher.

- 10: Permanent project-level constraints (use sparingly, 1-2 per project)
- 9: Critical breaking changes or immediate cross-session decisions only
- 8: Cross-session alert worthy -- fires signal in active sessions
- 7: Default. Facts, decisions, preferences, milestones
- 6: Routine verifications and dev observations
- 5: Borderline, barely worth storing

For OpenClaw transcript ingestion, extractor prompting is confidence-aware:
hedged, unverified assistant factual claims are tagged `unverified` and capped
at importance 5, while verified assistant claims and user statements keep normal
importance handling.

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
- Keep `importance` within `1..10` for `agenr_store`.
