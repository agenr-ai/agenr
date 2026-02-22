# AGENR

**AY-JEN-ER** - Human memory for AI agents.

Your AI forgets everything between sessions. AGENR fixes that.

It extracts structured knowledge from your OpenClaw conversation transcripts - facts, decisions, preferences, todos, relationships, events, lessons - and stores them in a local database with semantic search. Entries strengthen when reinforced, decay when stale, and resolve contradictions. It's not a search engine. It's memory that gets healthier with use.

One local database. Your memory stays on your machine.

## What you need

AGENR uses embeddings to make your memory searchable. The best setup we've found: an **OpenAI API key** with `text-embedding-3-small`. Embeddings cost fractions of a penny per operation - a full ingestion of 100+ session transcripts runs about $0.10 total.

AGENR also supports **OpenAI Pro subscriptions** and **Anthropic Claude subscriptions** (no API key needed) for the LLM extraction step. But for the best balance of speed, accuracy, and cost, we recommend `gpt-4.1-nano` with an API key. `agenr setup` walks you through all of this.

```bash
export OPENAI_API_KEY=sk-...  # for embeddings + extraction
```

## Setup

### 1. Install and ingest your history

```bash
npm install -g agenr

agenr setup        # configure LLM provider + auth
agenr ingest ~/.openclaw/agents/main/sessions/  # bootstrap from existing sessions
agenr recall "what did we decide about the database schema?"
```

### 2. Keep it fresh

```bash
agenr daemon install   # runs in background, watches your sessions automatically
agenr daemon status
agenr daemon logs
```

### 3. Wire your agent

Choose your platform:

#### OpenClaw (recommended)

The agenr OpenClaw plugin handles everything automatically - memory injection at
session start, mid-session signals when important new entries arrive, and
native `agenr_recall`, `agenr_store`, `agenr_extract`, and `agenr_retire`
tools registered directly in the agent toolset.

```bash
openclaw plugins install agenr
```

That's it. Memory injection happens via the plugin's `before_agent_start` hook.
No AGENTS.md edits needed. The bundled `SKILL.md` loads automatically and
instructs the agent when to call `agenr_store` proactively.

Optional config in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "agenr": {
        "config": {
          "budget": 2000,
          "signalMinImportance": 8,
          "signalCooldownMs": 30000,
          "signalMaxPerSession": 10
        }
      }
    }
  }
}
```

Signal config controls how often mid-session notifications fire. See
[docs/OPENCLAW.md](./docs/OPENCLAW.md) for all available options.

#### Claude Code

```bash
agenr init --platform claude-code
```

Adds the `agenr_recall`/`agenr_store` instruction block to
`~/.claude/CLAUDE.md` and wires `~/.mcp.json`. Your agent sees the tools and
knows when to use them.

#### Cursor

```bash
agenr init --platform cursor
```

Adds instructions to `.cursor/rules/agenr.mdc` and wires `.cursor/mcp.json`.

#### Codex

```bash
agenr init --platform codex
```

Adds instructions to `~/.codex/AGENTS.md` and wires `.mcp.json`.

#### Any MCP-compatible tool

```bash
agenr init   # auto-detects platform, falls back to generic AGENTS.md
```

Or configure manually: start `agenr mcp` as a stdio MCP server. Your agent gets
`agenr_recall`, `agenr_store`, `agenr_extract`, and `agenr_retire` as tools.

## What happens when you ingest

AGENR reads your OpenClaw session transcripts, filters out noise (tool calls, file dumps, boilerplate - about 80% of a typical session), and extracts structured knowledge entries:

```
agenr ingest ~/.openclaw/agents/main/sessions/ --glob '**/*.jsonl'

[1/108] session-abc123.jsonl (1.2MB) - 12 extracted, 10 stored, 1 skipped (duplicate), 1 reinforced
[2/108] session-def456.jsonl (800KB) - 8 extracted, 7 stored, 0 skipped, 1 reinforced
...
```

Each entry has a type, subject, content, importance, and expiry. Near-duplicates are caught automatically - if you discussed the same decision in three sessions, you get one entry with higher confirmations, not three copies.

```bash
agenr recall "package manager"
```

```text
1 results (46ms)
1. [decision] project tooling: We switched this project to pnpm.
   importance=7 | today | recalled 3 times
   tags: tooling, package-manager
```

## Live watching

The watcher keeps your memory current as you work. It tails your session files, extracts new knowledge every few minutes, and stores it. If you ingested history first, watch resumes right where ingest left off - no re-processing.

```bash
# Watch your OpenClaw sessions directory (auto-resolves the default path)
agenr watch --platform openclaw

# Install as a background daemon (macOS launchd)
agenr daemon install
agenr daemon status
agenr daemon logs
```

You can also auto-refresh a context file that AI tools read on startup:

```bash
agenr watch --platform openclaw --context ~/.agenr/CONTEXT.md
```

## How it works

**Extract** - An LLM reads your transcripts and pulls out structured entries: facts, decisions, preferences, todos, relationships, events, lessons. Smart filtering removes noise (tool calls, file contents, boilerplate) before the LLM ever sees it. For OpenClaw sessions, hedged or unverified agent claims are detected and capped at importance 5 with an `unverified` tag - so speculative assistant statements do not pollute your memory as facts.

**Store** - Entries get embedded and compared against what's already in the database. Near-duplicates reinforce existing knowledge. New information gets inserted. Online dedup catches copies in real-time.

**Recall** - Semantic search plus memory-aware ranking. Entries you recall often score higher. Stale entries decay. Contradicted entries get penalized.

**Consolidate** - Periodic cleanup: rule-based expiry first, then optional LLM-assisted merging for entries that say the same thing differently.

```
Transcript -> Filter -> Extract -> Store -> Recall
               80%       LLM      dedup    semantic
               noise     typed    + embed  + memory-
               removed   entries  + dedup    aware
```

## MCP integration

agenr exposes four MCP tools: `agenr_recall`, `agenr_store`, `agenr_extract`,
`agenr_retire`.

**OpenClaw** - `openclaw plugins install agenr` (plugin registers tools
natively; no MCP config needed)

**Claude Code / Cursor / Codex** - `agenr init --platform <name>` (wires MCP
config and instructions)

**Manual** - start `agenr mcp` as a stdio server and configure in your tool's
MCP settings.

## Commands

| Command | What it does |
| --- | --- |
| `agenr setup` | Interactive configuration (LLM provider, auth, model defaults) |
| `agenr init [options]` | Wire a project: instructions file + MCP config + project scope. Use `--platform openclaw\|claude-code\|cursor\|codex\|generic` |
| `agenr config` | Show and update agenr configuration |
| `agenr auth` | Authentication status and diagnostics |
| `agenr ingest <paths...>` | Bulk-ingest files and directories |
| `agenr extract <files...>` | Extract knowledge entries from text files |
| `agenr store [files...]` | Store entries with semantic dedup |
| `agenr recall [query]` | Semantic + memory-aware recall. Use `--since` / `--until` for date range queries (e.g. `--since 14d --until 7d` for entries from two weeks ago). |
| `agenr retire [subject]` | Retire a stale entry (hidden, not deleted). Match by subject text or use --id <id> to target by entry ID. |
| `agenr watch [file]` | Live-watch files/directories, auto-extract knowledge |
| `agenr daemon install` | Install background watch daemon (macOS launchd) |
| `agenr daemon status` | Show daemon status (running/stopped, pid, watched file, recent logs) |
| `agenr daemon logs [--lines <n>] [--follow]` | Stream or show recent daemon logs for troubleshooting |
| `agenr consolidate` | Clean up and merge near-duplicates |
| `agenr context` | Generate context file for AI tool integration |
| `agenr health` | Show database health and forgetting candidates |
| `agenr mcp` | Start MCP server (stdio) |
| `agenr todo <subcommand> <subject>` | Manage todos in the knowledge base |
| `agenr db <cmd>` | Database management (stats, version, export, reset, path, check, rebuild-index) |

Full reference: [docs/CLI.md](./docs/CLI.md) | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

## Architecture

- **Runtime:** Node.js 20+, TypeScript, ESM
- **Storage:** libsql/SQLite (`~/.agenr/knowledge.db`)
- **Embeddings:** OpenAI `text-embedding-3-small`, 1024 dimensions
- **Recall scoring:** Vector similarity x recency x memory strength (max(importance, recall strength)), with contradiction penalties

Deep dive: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Status

The core pipeline is stable and tested (841 tests). We use it daily managing
thousands of knowledge entries across OpenClaw sessions.

What works: extraction, storage, recall, MCP integration, online dedup, consolidation, smart filtering, live watching, daemon mode.

What's next: GUI Management Console (browse, search, and curate your knowledge database visually), Cursor live signals, Claude Code UserPromptSubmit adapter, transitive project dependencies.

## Philosophy

The big labs are building bigger brains. We're building better memory. Those are complementary.

Current AI's bottleneck isn't intelligence - it's continuity. A slightly less brilliant model with accumulated context might be more useful than a brilliant amnesiac. What makes a senior engineer senior isn't raw IQ - it's patterns seen, mistakes remembered, approaches that worked. That's memory.

AGENR keeps your memory on your machine because it is yours. It's structured (not just vectors) because "what did we decide about X?" needs a real answer, not a similarity score. It's open source because memory infrastructure should be shared.

## Troubleshooting

| Problem | Fix |
|---|---|
| Embeddings fail | Set `OPENAI_API_KEY` env var or `agenr config set-key openai <key>` |
| Database locked | Wait for consolidation to finish, or check `~/.agenr/consolidation.lock` |
| Recall returns nothing after force-kill | `agenr db rebuild-index` (vector index corruption) |
| Extraction fails mid-file | Retry - dedup skips already-stored entries |

## License

AGPL-3.0 - [LICENSE](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)
