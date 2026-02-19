# AGENR

**AY-JEN-ER** - Human memory for AI agents.

Your AI forgets everything between sessions. AGENR fixes that.

It extracts structured knowledge from your OpenClaw conversation transcripts - facts, decisions, preferences, todos, relationships, events, lessons - and stores them in a local database with semantic search. Entries strengthen when reinforced, decay when stale, and resolve contradictions. It's not a search engine. It's memory that gets healthier with use.

One local database. Your memory stays on your machine.

## What you need

AGENR uses embeddings to make your memory searchable. The best setup we've found: an **OpenAI API key** with `text-embedding-3-small`. Embeddings cost fractions of a penny per operation - a full ingestion of 100+ session transcripts runs about $0.10 total.

AGENR also supports **OpenAI Pro subscriptions** and **Anthropic Claude subscriptions** (no API key needed) for the LLM extraction step. But for the best balance of speed, accuracy, and cost, we recommend `gpt-4o-mini` with an API key. `agenr setup` walks you through all of this.

```bash
export OPENAI_API_KEY=sk-...  # for embeddings + extraction
```

## Setup

### 1. Install and ingest your history

```bash
# Install
npm install -g agenr
# or
pnpm add -g agenr

# Configure (picks your LLM provider, walks you through auth)
agenr setup

# Ingest all your OpenClaw sessions
agenr ingest ~/.openclaw/agents/main/sessions/ --glob '**/*.jsonl'

# Query your memory
agenr recall "what did we decide about the database schema?"
```

### 2. Keep it fresh

Start the watcher so new conversations get captured automatically:

```bash
# Watch your current session file
agenr watch ~/.openclaw/agents/main/sessions/current.jsonl --interval 120

# Or watch a whole directory
agenr watch --dir ~/.openclaw/agents/main/sessions/

# Or install as a background daemon so it runs on its own
agenr daemon install
```

### 3. Give your agent memory

**Option A: CLI in AGENTS.md (no MCP needed, works everywhere)**

Add this to your OpenClaw `AGENTS.md`:

```markdown
## Memory (agenr)
On every session start, run this BEFORE responding to the first message:
  agenr recall --context session-start --budget 2000
IMPORTANT: use --budget 2000, not just --limit. Budget triggers balanced output:
  - 20% active todos
  - 30% preferences and decisions
  - 50% recent facts and events
Without --budget, score ranking skews toward old high-importance todos.
```

Your agent runs the command on startup and gets its memory back. No MCP, no extra config.

**Option B: MCP server (richer integration)**

If your tool supports MCP (OpenClaw via mcporter, Claude Code, Codex, Cursor):

```bash
# Add to OpenClaw (via mcporter)
mcporter config add agenr --stdio agenr --arg mcp --env OPENAI_API_KEY=your-key-here
```

This gives your agent `agenr_recall`, `agenr_store`, and `agenr_extract` as tools it can call anytime - not just on startup.

Done. Your agent now has persistent memory that survives compaction, session restarts, and everything in between.

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

# Deprecated: --auto still works (defaults to OpenClaw) but will be removed in a future version
agenr watch --auto

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

**Extract** - An LLM reads your transcripts and pulls out structured entries: facts, decisions, preferences, todos, relationships, events, lessons. Smart filtering removes noise (tool calls, file contents, boilerplate) before the LLM ever sees it.

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

AGENR exposes three MCP tools: `agenr_recall`, `agenr_store`, `agenr_extract`. Any tool that speaks MCP can use your memory.

**OpenClaw** (via [mcporter](https://mcporter.dev)):
```bash
mcporter config add agenr --stdio agenr --arg mcp --env OPENAI_API_KEY=your-key-here
```

Verify with `mcporter list agenr`. See [docs/OPENCLAW.md](./docs/OPENCLAW.md) for the full guide.

## Commands

| Command | What it does |
| --- | --- |
| `agenr setup` | Interactive configuration |
| `agenr config` | Show and update agenr configuration |
| `agenr auth` | Authentication status and diagnostics |
| `agenr ingest <paths...>` | Bulk-ingest files and directories |
| `agenr extract <files...>` | Extract knowledge from text |
| `agenr store [files...]` | Store entries with semantic dedup |
| `agenr recall [query]` | Semantic + memory-aware recall |
| `agenr watch [file]` | Live-watch files, directories, or auto-detect |
| `agenr daemon install` | Install background watch daemon |
| `agenr consolidate` | Clean up and merge near-duplicates |
| `agenr context` | Generate context file for AI tool integration |
| `agenr mcp` | Start MCP server (stdio) |
| `agenr db <cmd>` | Database management (stats, version, export, reset, path, check, rebuild-index). Run `agenr db --help` for all subcommands. |

Full reference: [docs/CLI.md](./docs/CLI.md) | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

## Architecture

- **Runtime:** Node.js 20+, TypeScript, ESM
- **Storage:** libsql/SQLite (`~/.agenr/knowledge.db`)
- **Embeddings:** OpenAI `text-embedding-3-small`, 1024 dimensions
- **Recall scoring:** Vector similarity x recency x memory strength (max(importance, recall strength)), with contradiction penalties

Deep dive: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Status

Alpha. The core pipeline is stable and tested (445 tests). We use it daily managing thousands of knowledge entries across OpenClaw sessions.

What works: extraction, storage, recall, MCP integration, online dedup, consolidation, smart filtering, live watching, daemon mode.

What's next: local embeddings support, entity resolution, auto-scheduled consolidation.

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
