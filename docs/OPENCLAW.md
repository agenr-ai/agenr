# agenr + OpenClaw: Best Practices Guide

## Overview

[OpenClaw](https://openclaw.ai) is a personal AI assistant platform. agenr ships
as a native OpenClaw plugin, which means your agent gets agenr_recall, agenr_store,
agenr_extract, and agenr_retire as first-class tools without any additional bridge
software.

This guide covers setup, seeding your agent's memory, and best practices for getting real value out of persistent memory.

## Quick Setup

### 1. Install

```bash
openclaw plugins install agenr
agenr setup  # configure LLM provider + auth
```

### 2. Optional plugin config

After install, agenr works with no additional config. To customize, add an agenr
entry to `openclaw.json` in your workspace:

```json
"plugins": {
  "entries": {
    "agenr": {
      "config": {
        "enabled": true,
        "budget": 2000,
        "signalMinImportance": 8
      }
    }
  }
}
```

Set OPENAI_API_KEY as an environment variable or run `agenr setup` to configure it.

### 3. Verify

Start a new OpenClaw session. The four tools (agenr_recall, agenr_store,
agenr_extract, agenr_retire) will appear in the tool list automatically.

From the CLI, confirm recall works:

```bash
agenr recall "test" --limit 3
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

## Calibrating Memory

The OpenClaw plugin handles agent instruction automatically - no `AGENTS.md` changes
needed. When the plugin loads, it registers the four tools and injects guidance via
the built-in skill. Your agent already knows what to store, when to recall, and
how to use importance scores.

What you **can** tune is how aggressively the agent stores and signals.

### Importance calibration

Score 7 is the default for most entries -- stored silently, no alert fires.

Score 8+ fires a real-time cross-session signal. Before using 8, ask:
"Would an active parallel session need to act on this right now?" If no,
use 7. If more than 20% of stored entries are 8 or higher, importance is
being inflated.

Score anchors:
- 10: Once-per-project permanent constraints. "This project must never use
       GPL-licensed dependencies." At most 1-2 per project lifetime.
- 9: Critical breaking changes or immediate cross-session decisions only.
      Major architecture reversals, breaking API changes, critical blockers.
      At most 1 per significant session, often 0.
- 8: Things an active parallel session would act on right now. Fires a
      cross-session signal. Use conservatively.
- 7: Default for most entries. Project facts, decisions, preferences,
      milestones. No signal fired.
- 6: Routine dev observations. "Verified X", "confirmed Y runs",
      "tests passing". Cap at 6 unless the result is surprising or breaking.
- 5: Borderline. Only store if clearly durable beyond today.

### Confidence-aware extraction for OpenClaw transcripts

OpenClaw transcript lines include `[user]` and `[assistant]` role labels.
The extractor now uses that signal to reduce hallucination risk:

- Hedged, unverified assistant factual claims are tagged `unverified` and
  capped at importance 5.
- Tool-verified assistant claims keep normal importance rules.
- User messages are never capped by this confidence rule.

This keeps uncertain assistant assertions from being stored as high-importance
memories while preserving verified outcomes.

### Tuning Signal Noise

Six config fields control signal behavior:

signalsEnabled (boolean, default: true)
  Set to false to disable all mid-session signals.

signalMinImportance (integer, default: 8)
  Only surface entries with importance >= this value.

signalMaxPerSignal (integer, default: 3)
  Maximum entries included in a single signal notification.

signalCooldownMs (integer, default: 30000)
  Minimum milliseconds between signal batches in a session. Set 0 to disable.

signalMaxPerSession (integer, default: 10)
  Maximum signal batches delivered during a session lifetime. Set 0 to disable.

signalMaxAgeSec (integer, default: 300)
  Only surface entries created within the last N seconds. Set 0 to disable.

Example:
```jsonc
"agenr": {
  "config": {
    "signalCooldownMs": 60000,
    "signalMaxPerSession": 5,
    // raise from default 8 to 9 for even stricter signal filtering
    "signalMinImportance": 9,
    "signalMaxAgeSec": 120
  }
}
```

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
    +--> agenr plugin (native, loaded in-process)
              |
              +--> spawns agenr CLI (child_process)
                            |
                            v
                   ~/.agenr/knowledge.db
                   (SQLite + vector index)
```

Network calls: OpenAI embedding API (on store and recall). All storage is local.

## Multi-Agent Memory

### Shared brain (default)

All agents read/write the same `~/.agenr/knowledge.db`. Your OpenClaw agent, Codex, and Claude Code all share one memory.

### Isolated brains

Give each agent its own database:

For the OpenClaw native plugin, set dbPath in openclaw.json:

```json
"agenr": {
  "config": {
    "dbPath": "~/.agenr/openclaw.db"
  }
}
```

```bash
# Codex (in ~/.codex/config.toml)
[mcp_servers.agenr]
command = "npx"
args = ["-y", "agenr", "mcp", "--db", "~/.agenr/codex.db"]
```

Useful when you want coding context separate from personal assistant context.

## Alternative: Direct CLI

If you want to invoke agenr from shell commands or AGENTS.md instructions without
using the plugin tools, you can call the CLI directly:

```bash
agenr recall "query" --limit 5
agenr recall --context session-start --budget 2000
echo '[{"content":"...","type":"fact","subject":"...","importance":7}]' | agenr store
```

This works but the agent needs explicit instructions (in AGENTS.md) to know the commands. The plugin approach is cleaner because the agent discovers the tools automatically.

## See Also

- [CLI Reference](./CLI.md) - full command documentation
- [MCP Integration](./MCP.md) - MCP server details and Codex/Claude Code setup
- [Configuration](./CONFIGURATION.md) - all config options
- [Consolidation](./CONSOLIDATION.md) - how knowledge merging works
