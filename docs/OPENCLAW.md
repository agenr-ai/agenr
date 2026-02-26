# agenr + OpenClaw Integration Guide

## Overview

[OpenClaw](https://openclaw.ai) is a personal AI assistant platform. agenr ships
as a native OpenClaw plugin, giving your agent `agenr_recall`, `agenr_store`,
`agenr_extract`, and `agenr_retire` as first-class tools with no additional
bridge software.

The recommended setup path is `agenr init`, an interactive wizard that handles
auth, plugin installation, session ingestion, consolidation, and watcher setup
in one command. Manual setup instructions are available below for advanced users.

## Quick Start: agenr init

```bash
agenr init
```

The wizard walks you through everything:

1. **Auth and model configuration** - sets up your LLM provider and API key
   (runs `agenr setup` internally if not already configured)
2. **Platform detection** - finds your OpenClaw installation directory automatically
3. **Plugin install** - runs `openclaw plugins install agenr`, writes plugin config
   to `openclaw.json`, and restarts the gateway
4. **Session scan** - finds your existing session transcripts in
   `~/.openclaw/agents/main/sessions/`
5. **Cost estimate** - shows token count and estimated cost for ingesting recent
   (last 7 days) vs full history
6. **Ingestion** - extracts structured knowledge entries from your sessions
7. **Consolidation** - merges duplicates and related entries after bulk ingestion
8. **Watcher** - installs a launchd service (macOS) that watches for new
   sessions and ingests them automatically

### What you get after the wizard

- The four agenr tools appear in every OpenClaw session automatically
- Your existing session history is extracted into searchable knowledge
- New sessions are ingested continuously by the watcher
- Cross-session context is injected at the start of every conversation

### Non-interactive mode

When CLI flags are provided, the wizard skips interactive prompts:

```bash
agenr init --platform openclaw --project my-project --path ~/.openclaw
```

This is useful for scripted setups or CI environments.

### Re-running the wizard

Running `agenr init` again shows your current configuration and asks if you
want to reconfigure. If you changed your LLM model, the wizard offers to
re-ingest your sessions with the new model (this resets the database).

### Re-ingesting after a model change

If you upgrade your extraction model later (e.g., from gpt-4.1-mini to
gpt-4.1), the wizard detects the change and offers to:

- **Re-ingest** - resets the database and re-extracts everything with the new model
- **Keep existing data** - new sessions use the new model going forward, old
  entries stay as-is

Re-ingesting with a better model can significantly improve extraction quality.

## Manual Setup

For advanced users who want to configure things individually.

### 1. Install the plugin

```bash
openclaw plugins install agenr
agenr setup  # configure LLM provider + API key
```

> **Security notice:** OpenClaw's code scanner flags a critical warning during
> install: _"Shell command execution detected (child_process)."_ This is
> expected - agenr shells out to its own CLI binary for recall and store
> operations. It does not make external network calls, read your OpenClaw
> credentials, or exfiltrate data. The plugin source is open at
> https://github.com/agenr-ai/agenr.

### 2. Optional plugin config

agenr works with no additional config after install. To customize, add an agenr
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

### 3. Verify

Start a new OpenClaw session. The four tools (`agenr_recall`, `agenr_store`,
`agenr_extract`, `agenr_retire`) appear in the tool list automatically.

```bash
agenr recall "test" --limit 3
```

### 4. Ingest existing sessions

```bash
agenr ingest ~/.openclaw/agents/main/sessions/ \
  --bulk --platform openclaw --project openclaw --whole-file
```

### 5. Set up the watcher

```bash
agenr watcher install --dir ~/.openclaw/agents/main/sessions/ --platform openclaw
```

## How It Works

### Session-Start Context Injection

On the first message of each new session, agenr injects three context blocks:

- **Phase 1A - Recent session:** The last 7 user+assistant turns from the most
  recently modified session JSONL file. Provides immediate conversational
  continuity.
- **Phase 1B - Recent memory:** Top 20 importance-ranked entries from the last
  24 hours via browse-mode recall. This picks up the importance-10 handoff entry
  written when the previous session ended (via `/new` or session reset).
- **Phase 2 - Relevant memory:** Semantic recall seeded from Phase 1A turns plus
  the first user message (if 5+ words). Results are deduplicated against Phase 1B
  by entry ID.

This fires unconditionally - even short messages like "hey" get full context injection.

After injection, handoff entries surfaced in Phase 1B are automatically retired
to avoid repeated carryover.

### Cross-Session Handoff

When a session ends (via `/new`, session reset, or surface switch), the plugin
writes a handoff entry using a two-phase approach:

1. **Phase 1 (immediate):** A fallback entry is stored at importance 9 with the
   raw recent exchange text (`U:`/`A:` formatted turns). This is synchronous and
   guarantees something is written even if the LLM call fails.
2. **Phase 2 (async upgrade):** The plugin builds a merged transcript from the
   current session and the most recent prior session (if under 24h old), labeled
   with timestamps and surface info (webchat/telegram/etc). An LLM summarizes
   this into a structured four-section handoff entry at importance 10. On success,
   the Phase 1 fallback entry is retired.

The LLM handoff uses your configured extraction model (default: gpt-4.1-nano).
Transcript content is cleaned before summarization - OpenClaw/agenr injected
context (memory blocks, signals, conversation metadata) is stripped so the
summarizer only sees actual conversation.

Configuration options in `openclaw.json` plugin config:

- `handoff.includeBackground` - include prior session messages as background
  context for the LLM (default: false)
- `handoff.logDir` - write LLM request/response transcripts for debugging

### Continuous Ingestion (Watcher)

The watcher monitors your sessions directory and automatically ingests
new or modified session files.

**Install via the wizard** (recommended):

The `agenr init` wizard offers to set up the watcher as part of the setup flow.

**Install manually** (macOS):

```bash
agenr watcher install \
  --dir ~/.openclaw/agents/main/sessions/ \
  --platform openclaw \
  --interval 120
```

This creates a launchd service (`com.agenr.watch`) that runs every 120 seconds.

**Manage the daemon:**

```bash
agenr watcher status    # check if running, view recent logs
agenr watcher logs      # view watcher logs
agenr watcher stop      # stop the daemon
agenr watcher start     # start the daemon
agenr watcher uninstall # remove the launchd service
```

**Manual watch** (any platform):

```bash
agenr watch --dir ~/.openclaw/agents/main/sessions/ --platform openclaw
```

This runs the watcher in the foreground. Useful for Linux/Windows where the
launchd daemon is not available.

## Calibrating Memory

The OpenClaw plugin handles agent instruction automatically - no `AGENTS.md`
changes needed. When the plugin loads, it registers the four tools and injects
guidance via the built-in skill. Your agent already knows what to store, when
to recall, and how to use importance scores.

What you **can** tune is how aggressively the agent stores and signals.

### Importance calibration

Score 7 is the default for most entries - stored silently, no alert fires.

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

Whole-file extraction calibration (when the extractor processes a full session):
- Typical session: 5-15 entries. Dense sessions may warrant 30-50.
- You are seeing the complete conversation. Extract complete, coherent entries
  that capture multi-part discussions as single entries, not fragments.
- Score 9 or 10: very rare, at most 1 per session, often 0
- Score 8: at most 2-3 per session; ask the cross-session-alert question
  before assigning
- Score 7: this is your workhorse; most emitted entries should be 7
- Score 6: routine dev observations worth storing
- TODO completion: if a TODO is raised AND completed within this session,
  emit only the completion event - not the original todo.
- If more than 30% of your emitted entries are score 8 or higher, you are
  inflating.
- Do NOT extract the same fact multiple times even if stated differently in
  the session.

### Platform-aware extraction

agenr injects a platform-specific addendum to the extraction prompt based on
the `--platform` flag (or adapter auto-detection).

**openclaw** - confidence-aware extraction:
- Transcript lines include `[user]` and `[assistant]` role labels.
- Hedged, unverified assistant factual claims are tagged `unverified` and
  capped at importance 5.
- Tool-verified claims and user messages keep normal importance rules.

**codex / claude-code** - code session rules:
- Confirmed bugs and architectural decisions with file/line evidence are
  stored at importance 8+ with permanent expiry.
- Navigation noise ("I explored N files", "I read X") is skipped.
- Confidence cap applies identically to openclaw (hedged factual claims
  capped at 5).

**plaud** - meeting transcript rules:
- Explicit and implicit action items are extracted with speaker attribution
  from `[HH:MM] Name:` labels.
- Meeting chunks use a higher entry density target (3-8 entries) than agent
  session chunks.
- The `unverified` tag is prohibited (no tool-call verification signal in
  meeting transcripts).

Transcripts with no platform tag get the base extraction prompt with no addendum.

## Tuning Signal Noise

Six config fields control signal behavior:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `signalsEnabled` | boolean | `true` | Set to `false` to disable all mid-session signals |
| `signalMinImportance` | integer | `8` | Only surface entries with importance >= this value |
| `signalMaxPerSignal` | integer | `3` | Maximum entries per signal notification |
| `signalCooldownMs` | integer | `30000` | Minimum ms between signal batches. `0` to disable |
| `signalMaxPerSession` | integer | `10` | Maximum signal batches per session lifetime. `0` to disable |
| `signalMaxAgeSec` | integer | `300` | Only surface entries created within last N seconds. `0` to disable |

Example:

```jsonc
"agenr": {
  "config": {
    "signalCooldownMs": 60000,
    "signalMaxPerSession": 5,
    // raise from default 8 to 9 for stricter signal filtering
    "signalMinImportance": 9,
    "signalMaxAgeSec": 120
  }
}
```

## Consolidation

Over time, your knowledge base accumulates duplicates and near-duplicates.
Consolidation merges these into clean canonical entries.

The `agenr init` wizard runs consolidation automatically after ingestion.

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

Uses semantic clustering to find related entries and merges them with an LLM.
More thorough but costs API calls. Run after major ingestion batches or every
few weeks.

### Recommended cadence

| Event | Action |
|-------|--------|
| After bulk ingestion | Full consolidation (wizard does this) |
| Weekly | Rules-only consolidation |
| Monthly | Full consolidation |
| After 1000+ new entries | Full consolidation |

## Multi-Agent Memory

### Shared brain (default)

All agents read/write the same `~/.agenr/knowledge.db`. Your OpenClaw agent,
Codex, and Claude Code all share one memory.

The `agenr init` wizard handles project isolation via project tags. When
multiple platforms share the same database, data is separated by project tag
in recall queries.

### Isolated brains

Give each agent its own database. The wizard offers this option when it detects
a non-default OpenClaw directory.

For manual setup, set `dbPath` in `openclaw.json`:

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

## Monitoring

```bash
# Database health
agenr db stats          # entry counts by type, active vs superseded
agenr db check          # integrity check + vector index probe

# If recall gets slow or returns bad results
agenr db rebuild-index  # drops and recreates the vector index

# Watcher health
agenr watcher status     # daemon loaded/running, current file, recent logs
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

## Troubleshooting

### Plugin install fails

If `openclaw plugins install agenr` fails:

```bash
# Check if openclaw is on PATH
which openclaw

# Try uninstall + reinstall
openclaw plugins uninstall agenr
openclaw plugins install agenr

# Restart the gateway after install
openclaw gateway restart
```

### Gateway not picking up the plugin

The plugin must be listed in `openclaw.json` under `plugins.allow`:

```json
"plugins": {
  "allow": ["agenr"]
}
```

The wizard writes this automatically. After any manual config change:

```bash
openclaw gateway restart
```

### Watcher not running

```bash
# Check daemon status
agenr watcher status

# Reinstall if needed
agenr watcher install --force \
  --dir ~/.openclaw/agents/main/sessions/ \
  --platform openclaw

# View logs for errors
agenr watcher logs --lines 50
```

### Recall returns no results

```bash
# Check database has entries
agenr db stats

# If empty, run ingestion
agenr ingest ~/.openclaw/agents/main/sessions/ \
  --bulk --platform openclaw --project openclaw --whole-file

# If entries exist but recall is bad, rebuild the vector index
agenr db rebuild-index
```

### Re-ingest with a different model

If you changed your extraction model and want to re-extract everything:

```bash
# Stop the watcher first
agenr watcher stop

# Reset the database (destructive!)
agenr db reset --full --yes

# Re-ingest
agenr ingest ~/.openclaw/agents/main/sessions/ \
  --bulk --platform openclaw --project openclaw --whole-file

# Consolidate
agenr consolidate

# Restart the watcher
agenr watcher start
```

Or just run `agenr init` again - the wizard handles this flow.

## Alternative: Direct CLI

If you want to invoke agenr from shell commands or AGENTS.md instructions
without using the plugin tools, you can call the CLI directly:

```bash
agenr recall "query" --limit 5
agenr recall --context session-start --budget 2000
echo '[{"content":"...","type":"fact","subject":"...","importance":7}]' | agenr store
```

This works but the agent needs explicit instructions (in AGENTS.md) to know
the commands. The plugin approach is cleaner because the agent discovers the
tools automatically.

## See Also

- [CLI Reference](./CLI.md) - full command documentation
- [MCP Integration](./MCP.md) - MCP server details and Codex/Claude Code setup
- [Configuration](./CONFIGURATION.md) - all config options
- [Consolidation](./CONSOLIDATION.md) - how knowledge merging works
