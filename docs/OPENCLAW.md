# agenr + OpenClaw: Best Practices Guide

## Overview

[OpenClaw](https://openclaw.ai) is a personal AI assistant platform. It supports MCP servers via [mcporter](https://mcporter.dev), which means agenr integrates natively - your agent gets `agenr_recall`, `agenr_store`, and `agenr_extract` as first-class tools.

This guide covers setup, seeding your agent's memory, and best practices for getting real value out of persistent memory.

## Quick Setup

### 1. Install

```bash
npm install -g agenr mcporter
agenr setup  # walks you through LLM provider + auth
```

### 2. Add agenr as an MCP server

From your OpenClaw workspace:

```bash
mcporter config add agenr \
  --stdio agenr \
  --arg mcp \
  --env OPENAI_API_KEY=your-key-here
```

### 3. Verify

```bash
mcporter list agenr              # shows 3 tools
mcporter call agenr.agenr_recall query="test" limit=3
```

That's the wiring. Now the important part.

## Seed Your Agent's Memory

A fresh agenr database is empty - your agent has the tools but nothing to recall. The fastest way to bootstrap is to **feed it your existing OpenClaw session transcripts**.

OpenClaw stores every conversation as JSONL files:

```
~/.openclaw/agents/main/sessions/*.jsonl
```

These are gold. Every decision you've made, every preference you've expressed, every project you've discussed - it's all in there.

### Bulk ingest

```bash
# Ingest all session transcripts
agenr ingest ~/.openclaw/agents/main/sessions/

# Or specific files
agenr ingest ~/.openclaw/agents/main/sessions/recent-session.jsonl
```

`agenr ingest` handles JSONL (OpenClaw transcripts), Markdown, and plain text. It chunks large files, extracts structured knowledge entries, deduplicates against what's already stored, and logs what it processed so re-runs skip already-ingested files.

### What to expect

A typical OpenClaw user with a few months of history might have 50-100 session files. Ingestion extracts structured entries - facts, decisions, preferences, todos, relationships, events, lessons - and stores them with embeddings for semantic search.

After ingestion, your agent can recall things like:
- "What did we decide about the database schema?"
- "What's Jim's preferred tech stack?"
- "What happened in last week's meeting?"

### Start small

If you have a lot of history, start with recent sessions:

```bash
# Ingest only files modified in the last 30 days
find ~/.openclaw/agents/main/sessions/ -name "*.jsonl" -mtime -30 | xargs agenr ingest
```

You can always ingest older sessions later.

## Teaching Your Agent

The agent needs to know it has memory and how to use it. Add this to your workspace `AGENTS.md`:

```markdown
## Memory (agenr)

You have persistent memory via agenr MCP tools (mcporter). This is your
long-term brain - use it.

### Every session
- On startup: `agenr_recall` with a broad context query to bootstrap
- Before answering from memory: recall the specific topic first
- After important decisions or events: store them

### What to store
- Decisions and the reasoning behind them
- User preferences and constraints
- Project context (architecture, key files, tech choices)
- Lessons learned from mistakes
- Relationships between people, projects, and concepts

### What NOT to store
- Verbatim conversation (that's what session transcripts are for)
- Temporary state ("currently debugging X")
- Secrets, tokens, or credentials

### Entry types
fact, decision, preference, todo, relationship, event, lesson

### Tools
- `agenr_recall(query, limit, types, since, threshold)` - search memory
- `agenr_store(entries)` - save new knowledge
- `agenr_extract(text, store, source)` - extract entries from raw text
```

The key insight: **tell the agent what's worth remembering and what isn't.** Without guidance, agents either store everything (noisy) or nothing (defeats the purpose).

## Consolidation

Over time, your knowledge base accumulates duplicates and near-duplicates. The same fact gets stored slightly differently across sessions. Consolidation merges these into clean canonical entries.

### Rules-based (fast, no LLM)

```bash
# Preview what would change
agenr consolidate --rules-only --dry-run

# Run it
agenr consolidate --rules-only
```

Handles exact duplicates and expired entries. Safe to run frequently.

### Full consolidation (LLM-assisted)

```bash
agenr consolidate
```

Uses semantic clustering to find related entries across sessions and merges them with an LLM. More thorough but costs API calls. Run this after major ingestion batches or every few weeks.

### Recommended cadence

| Event | Action |
|-------|--------|
| After bulk ingestion | Full consolidation |
| Weekly | Rules-only consolidation |
| Monthly | Full consolidation |
| After 1000+ new entries | Full consolidation |

## Monitoring

```bash
# Database health
agenr db stats     # entry counts by type, active vs superseded
agenr db check     # integrity check + vector index probe

# If recall gets slow or returns bad results
agenr db rebuild-index   # drops and recreates the vector index
```

## Architecture

```
User message
    |
    v
OpenClaw agent
    |
    |--> mcporter --> agenr MCP server (stdio)
    |                    |
    |                    v
    |              ~/.agenr/knowledge.db
    |              (SQLite + vector index)
    |
    v
Agent response (informed by recalled memories)
```

Everything is local. The only network calls are to the embedding API (OpenAI) for generating vectors on recall and store. A future version will support local embeddings to eliminate even that.

## Multi-Agent Memory

### Shared brain (default)

All agents read/write the same `~/.agenr/knowledge.db`. Your OpenClaw agent, Codex, and Claude Code all share one memory.

### Isolated brains

Give each agent its own database:

```bash
# OpenClaw agent
mcporter config add agenr --stdio agenr --arg mcp \
  --arg --db --arg ~/.agenr/openclaw.db

# Codex (in ~/.codex/config.toml)
[mcp_servers.agenr]
command = "npx"
args = ["-y", "agenr", "mcp", "--db", "~/.agenr/codex.db"]
```

Useful when you want coding context separate from personal assistant context.

## Alternative: Direct CLI

If you prefer not to use mcporter, OpenClaw agents can call agenr directly via shell:

```bash
agenr recall "query" --limit 5
agenr recall --context session-start --limit 10
echo '[{"content":"...","type":"fact","subject":"...","importance":7}]' | agenr store
```

This works but the agent needs explicit instructions (in AGENTS.md) to know the commands. The MCP approach is cleaner because the agent discovers the tools automatically.

## See Also

- [CLI Reference](./CLI.md) - full command documentation
- [MCP Integration](./MCP.md) - MCP server details and Codex/Claude Code setup
- [Configuration](./CONFIGURATION.md) - all config options
- [Consolidation](./CONSOLIDATION.md) - how knowledge merging works
