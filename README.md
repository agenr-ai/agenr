# agenr

**/eɪ.dʒɛn.ɚ/** (AY-GEN-ER) - local-first memory for AI agents.

Your AI forgets everything between sessions. agenr fixes that.

It extracts structured knowledge from your OpenClaw conversation transcripts - facts, decisions, preferences, todos, relationships, events, lessons - and stores them in a local database with semantic search. Entries strengthen when reinforced, decay when stale, and resolve contradictions. It's not a search engine. It's memory that gets healthier with use.

One local database. Your memory stays on your machine.

## Setup

```bash
# Install
npm install -g agenr

# Configure (picks your LLM provider, walks you through auth)
agenr setup

# Ingest all your OpenClaw sessions
agenr ingest ~/.openclaw/agents/main/sessions/ --glob '**/*.jsonl'

# Query your memory
agenr recall "what did we decide about the database schema?"
```

Now hook it up to your agent via MCP so it can actually use the memory:

```bash
# Add to OpenClaw (via mcporter)
mcporter config add agenr --stdio agenr --arg mcp --env OPENAI_API_KEY=your-key-here

# Start watching for new sessions (keeps memory up to date automatically)
agenr watch --dir ~/.openclaw/agents/main/sessions/

# Or install as a background daemon so it runs on its own
agenr daemon install
```

Add this to your OpenClaw `AGENTS.md`:

```markdown
## Memory (agenr)
- On session start: call agenr_recall with context "session-start" to load relevant memories
- During work: recall specific topics as needed
- When you learn something important: store it with agenr_store
```

Done. Your agent now has persistent memory that survives compaction, session restarts, and everything in between.

> **Note:** Embeddings use OpenAI's API (`text-embedding-3-small`) regardless of your LLM provider. You'll need an `OPENAI_API_KEY` even if you use Anthropic for extraction. `agenr setup` walks you through it.

## What happens when you ingest

agenr reads your OpenClaw session transcripts, filters out noise (tool calls, file dumps, boilerplate - about 80% of a typical session), and extracts structured knowledge entries:

```
agenr ingest ~/.openclaw/agents/main/sessions/ --glob '**/*.jsonl'

[1/108] session-abc123.jsonl (1.2MB) - 12 extracted, 10 stored, 1 skipped (duplicate), 1 reinforced
[2/108] session-def456.jsonl (800KB) - 8 extracted, 7 stored, 0 skipped, 1 reinforced
...
```

Each entry has a type, subject, content, importance, and expiry. Near-duplicates are caught automatically - if you discussed the same decision in three sessions, you get one entry with higher confidence, not three copies.

```bash
agenr recall "package manager"
```

```
fact (0.94) - project tooling
We switched this project to pnpm.
Confirmed 3x | Last recalled 2 days ago
```

## Live watching

Don't want to batch-ingest? Watch your sessions in real-time:

```bash
# Watch your OpenClaw sessions directory
agenr watch --dir ~/.openclaw/agents/main/sessions/

# Auto-detect your session directory
agenr watch --auto

# Install as a background daemon (macOS launchd)
agenr daemon install
agenr daemon status
agenr daemon logs
```

New sessions are picked up automatically. If you ingested first, watch resumes right where ingest left off - no re-processing.

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

agenr exposes three MCP tools: `agenr_recall`, `agenr_store`, `agenr_extract`. Any tool that speaks MCP can use your memory.

**OpenClaw** (via [mcporter](https://mcporter.dev)):
```bash
mcporter config add agenr --stdio agenr --arg mcp --env OPENAI_API_KEY=your-key-here
```

Verify with `mcporter list agenr`. See [docs/OPENCLAW.md](./docs/OPENCLAW.md) for the full guide.

## Commands

| Command | What it does |
| --- | --- |
| `agenr setup` | Interactive configuration |
| `agenr ingest <paths...>` | Bulk-ingest files and directories |
| `agenr extract <files...>` | Extract knowledge from text |
| `agenr store [files...]` | Store entries with semantic dedup |
| `agenr recall [query]` | Semantic + memory-aware recall |
| `agenr watch [file]` | Live-watch files, directories, or auto-detect |
| `agenr daemon install` | Install background watch daemon |
| `agenr consolidate` | Clean up and merge near-duplicates |
| `agenr mcp` | Start MCP server (stdio) |
| `agenr db stats` | Database statistics |

Full reference: [docs/CLI.md](./docs/CLI.md) | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

## Architecture

- **Runtime:** Node.js 20+, TypeScript, ESM
- **Storage:** libsql/SQLite (`~/.agenr/knowledge.db`)
- **Embeddings:** OpenAI `text-embedding-3-small`, 1024 dimensions
- **Recall scoring:** Vector similarity x recency x confidence x recall strength, with contradiction penalties

Deep dive: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Status

Alpha. The core pipeline is stable and tested (350+ tests). We use it daily managing thousands of knowledge entries across OpenClaw sessions.

What works: extraction, storage, recall, MCP integration, online dedup, consolidation, smart filtering, live watching, daemon mode.

What's next: local embeddings support, entity resolution, auto-scheduled consolidation.

## Philosophy

The big labs are building bigger brains. We're building better memory. Those are complementary.

Current AI's bottleneck isn't intelligence - it's continuity. A slightly less brilliant model with accumulated context might be more useful than a brilliant amnesiac. What makes a senior engineer senior isn't raw IQ - it's patterns seen, mistakes remembered, approaches that worked. That's memory.

agenr is local-first because your memory is yours. It's structured (not just vectors) because "what did we decide about X?" needs a real answer, not a similarity score. It's open source because memory infrastructure should be shared.

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
