```text
 █████╗  ██████╗ ███████╗███╗   ██╗██████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔══██╗
███████║██║  ███╗█████╗  ██╔██╗ ██║██████╔╝
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██╔══██╗
██║  ██║╚██████╔╝███████╗██║ ╚████║██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝
  AGENt memoRy
```

# AGENR

**AY-JEN-ER** - Human memory for AI agents.

Your AI forgets everything between sessions. AGENR fixes that. It extracts structured knowledge from your conversation transcripts - facts, decisions, preferences, todos, relationships, events, lessons - and stores them in a local database with semantic search. Entries strengthen when reinforced, decay when stale, and resolve contradictions. One local database. Your memory stays on your machine.

## Quick Start

```bash
pnpm install -g agenr
agenr init
```

That's it. The interactive wizard handles everything: auth setup, platform detection, plugin installation, session ingestion, and watcher configuration. Run `agenr init` again anytime to reconfigure.

## What It Does

- **Extract** - An LLM reads your transcripts and pulls out structured entries. Smart filtering removes noise (tool calls, file contents, boilerplate - about 80% of a typical session) before the LLM sees it. Hedged or unverified agent claims are capped at importance 5 with an `unverified` tag.
- **Store** - Entries get embedded and compared against existing knowledge. Near-duplicates reinforce existing entries. New information gets inserted. Online dedup catches copies in real-time.
- **Recall** - Semantic search plus memory-aware ranking. Entries you recall often score higher. Stale entries decay. Contradicted entries get penalized.
- **Consolidate** - Periodic cleanup: rule-based expiry first, then optional LLM-assisted merging for entries that say the same thing differently.

```text
Transcript -> Filter -> Extract -> Store -> Recall
               80%       LLM      dedup    semantic
               noise     typed    + embed  + memory-
               removed   entries  + dedup    aware
```

## What You Need

An **OpenAI API key** for embeddings (`text-embedding-3-small`). Embeddings cost fractions of a penny per operation - a full ingestion of 100+ session transcripts runs about $0.10 total.

For the LLM extraction step, AGENR supports:
- **OpenAI API key** (recommended) - `gpt-4.1` is highly recommended for best extraction quality; `gpt-4.1-mini` is the default and works well if cost is a concern; `gpt-4.1-nano` is the budget option
- **OpenAI Pro subscription** - no API key needed
- **Anthropic Claude subscription** - no API key needed

The `agenr init` wizard walks you through all of this.

```bash
export OPENAI_API_KEY=sk-...  # for embeddings + extraction
```

## Platform Setup

### OpenClaw (recommended)

`agenr init` auto-detects OpenClaw, installs the native plugin, and restarts the gateway. The plugin handles everything automatically: three-phase memory injection at session start, mid-session signals when important entries arrive, cross-session handoff summaries, and native `agenr_recall`, `agenr_store`, `agenr_extract`, and `agenr_retire` tools.

No AGENTS.md edits needed. No MCP config needed. The bundled SKILL.md loads automatically and instructs the agent when to call `agenr_store` proactively.

**Manual alternative:**

```bash
openclaw plugins install agenr
```

> **Security notice:** OpenClaw's code scanner will flag a critical warning during install: _"Shell command execution detected (child_process)."_ This is expected. agenr shells out to its own CLI binary for recall and store operations - it does not make external network calls, does not read your OpenClaw credentials, and does not send data anywhere. The plugin source is open and auditable.

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

Signal config controls how often mid-session notifications fire. See [docs/OPENCLAW.md](./docs/OPENCLAW.md) for all available options.

### Claude Code

```bash
agenr init --platform claude-code
```

Adds the `agenr_recall`/`agenr_store` instruction block to `~/.claude/CLAUDE.md` and wires `~/.mcp.json`.

### Codex

```bash
agenr init --platform codex
```

Adds instructions to `~/.codex/AGENTS.md` and wires `~/.codex/config.toml`.

### Cursor

```bash
agenr init --platform cursor
```

Adds instructions to `.cursor/rules/agenr.mdc` and wires `.cursor/mcp.json`.

### Windsurf

```bash
agenr init --platform windsurf
```

Adds instructions to `~/.codeium/windsurf/memories/global_rules.md` and wires `.mcp.json`.

### Generic / Any MCP Tool

```bash
agenr init   # auto-detects platform, falls back to generic AGENTS.md
```

Or start `agenr mcp` as a stdio MCP server and configure it in your tool's MCP settings manually. Your agent gets `agenr_recall`, `agenr_store`, `agenr_extract`, and `agenr_retire` as tools.

## How Memory Works

### Extraction & Storage

AGENR reads your session transcripts, filters out noise, and extracts structured knowledge entries. Each entry has a type, subject, content, importance, and expiry. Near-duplicates are caught automatically - if you discussed the same decision in three sessions, you get one entry with higher confirmations, not three copies.

```bash
agenr ingest ~/.openclaw/agents/main/sessions/ --glob '**/*.jsonl'

[1/108] session-abc123.jsonl (1.2MB) - 12 extracted, 10 stored, 1 skipped (duplicate), 1 reinforced
[2/108] session-def456.jsonl (800KB) - 8 extracted, 7 stored, 0 skipped, 1 reinforced
...
```

### Recall (semantic + memory-aware)

```bash
agenr recall "package manager"
```

```text
1 results (46ms)
1. [decision] project tooling: We switched this project to pnpm.
   importance=7 | today | recalled 3 times
   tags: tooling, package-manager
```

Recall supports date range queries (`--since 14d --until 7d`), temporal browse mode (`--browse --since 1d`), and around-date targeting (`--around 2026-02-15 --around-radius 14`) to rank entries by distance from a specific date.

### Cross-session Handoff

When you start a new session, the OpenClaw plugin runs a three-phase context injection:

1. **Phase 1A** - Reads the last 7 user+assistant turns from the most recent session file for immediate continuity
2. **Phase 1B** - Runs browse-mode recall for the last 24 hours, picking up importance-10 handoff entries written when the previous session ended
3. **Phase 2** - Semantic recall seeded from Phase 1A turns plus the first user message, deduplicated against Phase 1B results

When a session ends, the plugin builds a merged transcript from the current and prior sessions, summarizes it via LLM into a structured handoff entry at importance 10, and stores it. The next session consumes and retires the handoff entry after use.

A two-phase storage strategy prevents race conditions: Phase 1 stores a raw fallback immediately, then Phase 2 asynchronously upgrades it to the LLM summary and retires the fallback.

### Consolidation

Periodic cleanup merges near-duplicates and expires stale entries. Run manually or let the init wizard prompt you after a bulk ingest:

```bash
agenr consolidate
```

## Advanced

### Multi-instance & DB Isolation

When running multiple OpenClaw instances (or mixing OpenClaw and Codex), each instance gets registered in a global projects map at `~/.agenr/config.json`. By default, all instances share `~/.agenr/knowledge.db` with data separated by project tags.

For non-default OpenClaw paths, the init wizard offers isolated databases:

```text
~/.agenr/knowledge.db          # shared (default)
~/my-openclaw/agenr-data/knowledge.db  # isolated
```

The wizard writes the isolated DB path directly to the OpenClaw plugin config so no manual editing is needed.

### Manual Ingest

```bash
agenr ingest <paths...> --bulk --workers 10 --whole-file
```

The init wizard offers cost estimation before ingestion using model pricing, showing estimated token counts and costs for recent (last 7 days) vs full history ingestion.

### Live Watching & Watcher

The watcher tails your session files, extracts new knowledge every few minutes, and stores it. If you ingested history first, watch resumes right where ingest left off.

```bash
# Watch your sessions directory
agenr watch --platform openclaw

# Install as a background daemon (macOS launchd, 120s interval)
agenr watcher install
agenr watcher status
agenr watcher logs
```

### Benchmarking

Evaluate extraction quality against scored rubrics:

```bash
agenr benchmark
```

Runs extraction against benchmark session fixtures, scores results against rubric JSON, and reports per-session plus overall metrics (recall, partial recall, precision proxy, composite score, pass rate). Supports multi-run aggregation with mean/min/stdev reporting.

### MCP Integration (manual)

If you prefer manual MCP setup over `agenr init`, start the stdio server:

```bash
agenr mcp
```

This exposes four tools: `agenr_recall`, `agenr_store`, `agenr_extract`, `agenr_retire`. Configure it in your tool's MCP settings as a stdio server.

## Commands

| Command | What it does |
| --- | --- |
| `agenr init` | Interactive setup wizard: auth, platform detection, plugin install, ingestion, watcher. Replaces the old `setup` flow. Use `--platform` to skip auto-detection. |
| `agenr setup` | Configure LLM provider, auth, and model defaults (also available inside `init`) |
| `agenr config` | Show and update agenr configuration |
| `agenr auth` | Authentication status and diagnostics |
| `agenr ingest <paths...>` | Bulk-ingest files and directories |
| `agenr extract <files...>` | Extract knowledge entries from text files |
| `agenr store [files...]` | Store entries with semantic dedup |
| `agenr recall [query]` | Semantic + memory-aware recall. Use `--since`/`--until` for date ranges, `--around` for target-date ranking, `--browse` for temporal mode. |
| `agenr retire [subject]` | Retire a stale entry (hidden, not deleted). Match by subject or `--id`. |
| `agenr watch [file]` | Live-watch files/directories, auto-extract knowledge |
| `agenr watcher install` | Install background watch daemon (macOS launchd) |
| `agenr watcher status` | Show daemon status (running/stopped, pid, watched file, recent logs) |
| `agenr watcher logs` | Stream or show recent daemon logs |
| `agenr consolidate` | Clean up and merge near-duplicates |
| `agenr benchmark` | Run extraction against benchmark fixtures and score results |
| `agenr context` | Generate context file for AI tool integration |
| `agenr health` | Show database health and forgetting candidates |
| `agenr mcp` | Start MCP server (stdio) |
| `agenr todo <subcommand>` | Manage todos in the knowledge base |
| `agenr db <cmd>` | Database management (stats, version, export, reset, path, check, rebuild-index) |

Full reference: [docs/CLI.md](./docs/CLI.md) | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

## Architecture

- **Runtime:** Node.js 20+, TypeScript, ESM
- **Storage:** libsql/SQLite - default at `~/.agenr/knowledge.db`, optionally isolated per instance
- **Embeddings:** OpenAI `text-embedding-3-small`, 1024 dimensions
- **Recall scoring:** Vector similarity x recency x memory strength (max(importance, recall strength)), with contradiction penalties
- **Global config:** `~/.agenr/config.json` - stores auth, model, and a projects map keyed by directory path with platform, project slug, and optional isolated DB path per instance

Deep dive: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Status

The core pipeline is stable and tested. We use it daily managing thousands of knowledge entries across OpenClaw sessions.

**Shipped:** extraction, storage, recall (semantic + browse), MCP integration, online dedup, consolidation, smart filtering, live watching, daemon mode, cross-session handoff (LLM-summarized), three-phase context injection, interactive init wizard, cost estimation, DB isolation, benchmarking.

**Next:** GUI Management Console (browse, search, and curate your knowledge database visually), Cursor live signals, Claude Code UserPromptSubmit adapter, transitive project dependencies.

## Philosophy

The big labs are building bigger brains. We're building better memory. Those are complementary.

Current AI's bottleneck isn't intelligence - it's continuity. A slightly less brilliant model with accumulated context might be more useful than a brilliant amnesiac. What makes a senior engineer senior isn't raw IQ - it's patterns seen, mistakes remembered, approaches that worked. That's memory.

AGENR keeps your memory on your machine because it is yours. It's structured (not just vectors) because "what did we decide about X?" needs a real answer, not a similarity score. It's open source because memory infrastructure should be shared.

## Troubleshooting

| Problem | Fix |
|---|---|
| `agenr init` wizard fails to detect platform | Pass `--platform openclaw` (or `codex`, `claude-code`, etc.) explicitly |
| Plugin install fails during wizard | Run `openclaw plugins install agenr` manually, then `openclaw gateway restart` |
| Embeddings fail | Set `OPENAI_API_KEY` env var or `agenr config set-key openai <key>` |
| Database locked | Wait for consolidation to finish, or check `~/.agenr/consolidation.lock` |
| Recall returns nothing after force-kill | `agenr db rebuild-index` (vector index corruption) |
| Extraction fails mid-file | Retry - dedup skips already-stored entries |
| Stale handoff entries persist | Run `agenr recall --browse --since 1d` to check, then `agenr retire --id <id>` |
| Gateway doesn't pick up plugin | Run `openclaw gateway restart` after plugin install |

## License

AGPL-3.0 - [LICENSE](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)
