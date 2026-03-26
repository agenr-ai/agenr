# Plan: Fresh Start — New Repo, Clean Foundation

Date: 2026-03-25
Status: Draft

## Why Start Fresh

The current codebase is 99K lines / 539 files, and even after removing watcher (14K) and agent tool special treatment, the architecture carries assumptions from features we no longer want. The surgery-to-remove approach has diminishing returns — every cut exposes tendrils, and the file structure was designed for a bloated system.

Starting fresh lets us:

- Design the schema for exactly what we need (23 tables → ~8)
- Build only the modules that earn their existence
- Establish clean module boundaries from day one instead of retrofitting them
- Drop all backwards compatibility tax
- Write focused tests for actual behavior instead of inheriting a 92K-line test suite

## Ground Rules

1. **No backwards compatibility.** Fresh database, fresh config format, fresh everything.
2. **The old repo is reference, not a migration source.** Copy algorithms, not architecture.
3. **Every file must earn its existence.** If you can't explain why it's a separate file, it isn't.
4. **OpenClaw first, but not OpenClaw only.** The core API must be clean enough that any agent system (Cursor, Windsurf, etc.) can plug in by writing an adapter. OpenClaw is the first adapter we build, but it should not leak into the core.
5. **No premature features.** No eval harness, no watcher, no db audit/repair tools. Build them when needed.
6. **No projects or platforms.** All entries live in one flat namespace. No `project` column, no `platform` column, no project-scoped recall, no project inference/attribution/resolution, no session project tools. If scoping is needed in the future, tags (already a JSON array on each entry) are the natural lightweight mechanism — just a query filter, not an attribution engine. But we don't need to figure that out now.
7. **Hexagonal architecture (pragmatic).** Core logic has zero imports from adapters. One level of inside/outside — no nested hexagons. Port interfaces live in one file, not a directory tree. The core API is the contract that all adapters (OpenClaw, CLI, MCP, future Cursor/Windsurf) call into.

## Repository Setup

### Old repo

- Rename to `agenr-v0` (or archive)
- Keep all history and issues for reference
- Do not maintain

### New repo: `agenr`

- Clean git history starting from initial commit
- Fresh issues board — create issues only as work is needed
- Same npm packages: `agenr` (CLI) and `@agenr/openclaw-plugin` (plugin)
- Version: `0.1.0` — signals "this is early, intentionally"

### Tooling (carry over)

- TypeScript + ESM
- tsup for build
- vitest for tests
- commander for CLI
- @libsql/client for SQLite
- @clack/prompts for interactive CLI (setup only — evaluate if needed)
- Same embedding provider

## Architecture

Pragmatic hexagonal: one clean inside/outside boundary. The core API is the contract all adapters call into.

```
                    ┌─────────────────────┐
                    │       CORE          │
                    │  (pure logic, no    │
                    │   infrastructure)   │
                    │                     │
                    │  recall(query)      │
                    │  store(entries)     │
                    │  retire(id)        │
                    │  ingest(file)      │
                    │  surgeon.run()     │
                    │  sessionStart()    │
                    │  handoff()         │
                    └──────────┬──────────┘
                               │ calls ports
              ┌────────────────┼────────────────┐
              │                │                 │
        ┌─────┴─────┐   ┌─────┴─────┐   ┌──────┴──────┐
        │  OpenClaw  │   │    CLI    │   │   Future    │
        │  adapter   │   │  adapter  │   │   adapters  │
        │            │   │           │   │  (Cursor,   │
        │            │   │           │   │  Windsurf)  │
        └────────────┘   └───────────┘   └─────────────┘
```

**The one rule:** `core/` has zero imports from `adapters/`. Core depends on port interfaces, never on concrete implementations.

```
agenr/
├── src/
│   ├── core/                           # THE INSIDE — pure logic, zero I/O deps
│   │   ├── types.ts                    # domain types: Entry, RecallResult, etc.
│   │   ├── ports.ts                    # ALL port interfaces (DB, embedding, LLM)
│   │   ├── store/                      # entry validation, dedup logic
│   │   │   └── pipeline.ts
│   │   ├── recall/                     # scoring, ranking, candidate selection
│   │   │   ├── search.ts
│   │   │   ├── scoring.ts
│   │   │   └── session-start.ts
│   │   ├── ingestion/                  # chunking, extraction orchestration
│   │   │   ├── extraction.ts
│   │   │   ├── prompts.ts             # system + user prompts (rewrite from scratch)
│   │   │   └── pipeline.ts
│   │   └── surgeon/                    # consolidation, dedup, retirement rules
│   │       └── workflow.ts
│   │
│   ├── adapters/                       # THE OUTSIDE — infrastructure implementations
│   │   ├── db/                         # SQLite: schema, queries, client
│   │   │   ├── client.ts
│   │   │   ├── schema.ts              # single clean CREATE TABLE definitions
│   │   │   └── queries.ts             # all DB queries (or split by concern if large)
│   │   ├── embeddings.ts              # embedding API client (implements EmbeddingPort)
│   │   ├── llm.ts                     # LLM API client (implements LlmPort)
│   │   ├── api/                        # HTTP API — the universal adapter
│   │   │   ├── server.ts              # HTTP server setup
│   │   │   ├── routes.ts              # REST endpoints mapping to core API
│   │   │   └── middleware.ts          # auth, validation
│   │   ├── openclaw/                   # OpenClaw plugin adapter
│   │   │   ├── index.ts               # plugin entry point + registration
│   │   │   ├── tools.ts               # store/retire/update/trace/recall tools
│   │   │   ├── session-start.ts       # session-start recall + memory injection
│   │   │   ├── mid-session-recall.ts  # on-demand recall during session
│   │   │   ├── handoff.ts             # session handoff (fallback + LLM summary)
│   │   │   ├── handoff-transcript.ts  # transcript building for handoff LLM
│   │   │   ├── session-predecessor.ts # predecessor session lookup (simplified)
│   │   │   ├── session-state.ts       # session tracking state
│   │   │   ├── recall-format.ts       # format entries for system prompt injection
│   │   │   ├── openclaw-adapter.ts    # OpenClaw JSONL transcript parsing
│   │   │   └── types.ts
│   │   └── mcp/                        # MCP server adapter
│   │       ├── server.ts
│   │       └── handlers.ts
│   │
│   ├── cli/                            # CLI adapter (thin, wires adapters → core)
│   │   ├── main.ts                     # entry point + command registration
│   │   └── commands/                   # one file per command
│   │       ├── ingest.ts
│   │       ├── recall.ts
│   │       ├── store.ts
│   │       ├── retire.ts
│   │       ├── update.ts
│   │       ├── trace.ts
│   │       ├── surgeon.ts
│   │       ├── mcp.ts
│   │       ├── db.ts                  # reset, stats, path
│   │       ├── setup.ts
│   │       └── config.ts
│   │
│   └── config.ts                       # config loading + types
│
├── tests/
├── docs/
└── package.json
```

**The core API** (in `core/`) is what makes future adapters cheap. Adding Cursor support = write `adapters/cursor/` that maps Cursor's extension protocol to `core.recall()`, `core.store()`, `core.sessionStart()`. The core doesn't know or care who's calling it.

**`core/ports.ts`** is one file containing all port interfaces: `DatabasePort`, `EmbeddingPort`, `LlmPort`, `TranscriptPort`. At this scale, one file is plenty. If it grows past ~200 lines, split by concern.

**Target: ~50–80 source files, ~15–25K lines.** Down from 539 files / 99K lines.

## Database Schema (Clean Design)

From 23 tables to ~8. Design for what exists, not what might exist.

### Core tables

```sql
-- The knowledge entries
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- fact, decision, preference, lesson, etc.
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL,
  expiry TEXT NOT NULL,                  -- core, permanent, temporary
  tags TEXT,                             -- JSON array (denormalized — no separate tags table)
  source_file TEXT,
  source_context TEXT,
  embedding F32_BLOB(1024),
  content_hash TEXT,
  norm_content_hash TEXT,
  minhash_sig BLOB,
  quality_score REAL NOT NULL DEFAULT 0.5,
  recall_count INTEGER DEFAULT 0,
  last_recalled_at TEXT,
  superseded_by TEXT REFERENCES entries(id),
  cluster_id TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT,
  retired_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search
CREATE VIRTUAL TABLE entries_fts USING fts5(
  content, subject, content=entries, content_rowid=rowid
);

-- Vector index
CREATE INDEX idx_entries_embedding ON entries (
  libsql_vector_idx(embedding, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=50')
) WHERE embedding IS NOT NULL AND retired = 0 AND superseded_by IS NULL;

-- Ingest tracking (which files have been processed)
CREATE TABLE ingest_log (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  entry_count INTEGER DEFAULT 0
);

-- Recall events (for quality scoring feedback loop)
CREATE TABLE recall_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  query TEXT,
  session_key TEXT,
  recalled_at TEXT NOT NULL
);

-- Surgeon run tracking
CREATE TABLE surgeon_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  actions_taken INTEGER DEFAULT 0,
  summary TEXT
);

-- Metadata
CREATE TABLE _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### What's gone

- `tags` table → denormalized as JSON array in `entries.tags`
- `relations` table → evaluate if surgeon needs it; if so, add back minimal
- `clusters` table → keep only if surgeon clustering is ported
- `entry_sources` / `entry_supports` → gone
- `seen_sessions` → gone (ingest_log handles dedup)
- `session_identity_breadcrumbs` → gone
- `signal_watermarks` → gone
- `conflict_log` → gone
- `co_recall_edges` → gone
- `review_queue` → gone
- `maintenance_runs` → gone
- `surgeon_run_actions` → gone (summary in surgeon_runs is enough)
- `project_recovery_runs` / `project_recovery_run_entries` → gone
- `brain_health_snapshots` → gone
- `reflections` → evaluate if surgeon uses it

## Module Porting Strategy

### Order of implementation (dependency chain)

```
1. core/types + core/ports     ← domain types and port interfaces first
2. config + adapters/db        ← schema, client, queries (implements DatabasePort)
3. adapters/embeddings + llm   ��� infrastructure clients (implement ports)
4. core/store                  ← pure logic, depends only on ports
5. core/recall                 ← pure logic, depends only on ports
6. core/ingestion              ← depends on ports (LLM, store, embedding)
7. core/surgeon                ← depends on ports
8. adapters/openclaw           ← wires OpenClaw's plugin API → core
9. adapters/mcp                ← wires MCP protocol → core
10. cli/                       ← thin wrappers: wire adapters → core → output
```

Core modules (4-7) are built against port interfaces, tested with in-memory test doubles. Adapters (2-3, 8-10) are integration-tested against real infrastructure via the sandbox.

### Per-module guidance

**Config** — Single file. One TypeScript type. No legacy handling, no deprecated fields, no normalization of old formats. If the config is wrong, error and tell the user.

**DB/Schema** — Single `schema.ts` with all CREATE statements. `client.ts` for connection. Query modules organized by concern. No migration runner.

**Store** — Port the core pipeline: validate → dedup (content hash + norm hash + minhash) → embed → insert. Drop claims/contradiction system unless it's demonstrably improving quality. Drop the `within-batch-dedup.ts` boundary leak — dedup logic lives in one place.

**Recall** — Port the retrieval pipeline: vector search → lexical boost → scoring → ranking. Collapse from 63 files to ~4. The scoring algorithm is good; the file structure is not. Drop graph neighborhood, co-recall edges, and reranking unless proven valuable.

**Ingestion** — One adapter (OpenClaw), one extraction pipeline, one orchestrator. No adapter registry. The OpenClaw JSONL parser is genuinely good code — port the parsing logic. **Rewrite the system prompt from scratch** — the reviews identified it as overlong, self-contradicting, and neutralizing importance. The new prompt should be short, clear, and let the LLM actually assign meaningful importance scores.

**Surgeon** — Port the consolidation workflow: find similar entries → merge/supersede → retire stale entries → cluster. This is valuable maintenance logic.

**OpenClaw Plugin** — The big simplification target. 60 files → ~10-12. The core behaviors:

1. **Session start recall** — recall relevant entries and format as system prompt injection
2. **Mid-session recall** — on-demand search during a session
3. **Tools** — store, retire, update, trace, recall, set/get/clear project
4. **Session handoff** — this is critical and non-trivial. When a session resets (before_reset), the plugin:
   - Extracts the last exchange as a fallback handoff entry (immediate, so the next session always has context)
   - Optionally runs an LLM summary of the session for a richer handoff
   - Retires the fallback entry once the LLM summary is stored
   - The next session's start recall retrieves the handoff entry as predecessor context
5. **Session tracking** — knowing which session is the predecessor of the current one across surfaces. The current system (6 files / 2,800 lines of continuity + identity + breadcrumbs + family policy) is over-engineered but the core problem is real: which previous session on this surface/channel should provide handoff context? This needs to be **re-thought and simplified**, not deleted. A simpler model:
   - Parse the session key to determine surface (telegram, discord, webchat, etc.) and lane (chat ID, thread ID)
   - Look up the most recent handoff entry matching that surface+lane
   - Done. No breadcrumb persistence, no family policy engine, no explicit predecessor resolution chains.

**What should NOT port from the current plugin:**

- Surfaced memory ledger (782 lines) — tracks which entries were shown to the agent. Unclear value.
- Memory surface contract (877 lines) — complex partitioning/admission logic for what to show. Simplify.
- Session start selector analysis (527 lines) — over-engineered selection logic for which entries to inject.
- Session identity breadcrumbs (160 lines) — persistent breadcrumb trail in DB. Unnecessary if session tracking is simplified.
- Memory reliability diagnostics (229 lines) — telemetry. Premature.
- Session continuity diagnostics (135 lines) — debug logging for the complex system. Unnecessary if simplified.

**What to re-think and simplify:**

- Session continuity: collapse the 6-file system into a single `session-predecessor.ts` (~100-200 lines)
- Handoff: the two-phase approach (fallback + LLM upgrade) is good. Port the logic, simplify the code.
- Recall formatting: how entries are rendered into the system prompt. Port but simplify.

**MCP** — Lift nearly as-is. It's already lean at ~2K lines.

## CLI Surface

```
agenr ingest <path> [options]        # ingest session files
agenr recall <query> [options]       # search knowledge
agenr store [options]                # store entry (interactive or piped)
agenr retire <id|subject>            # retire an entry
agenr update <id|subject>            # update importance/expiry
agenr trace <id|subject>             # trace entry provenance
agenr surgeon [options]              # run maintenance
agenr mcp                            # start MCP server
agenr db reset                       # reset database
agenr db stats                       # show db statistics
agenr db path                        # print db file path
agenr setup                          # interactive setup
agenr config                         # show/edit config
```

13 commands. Down from 30+.

## HTTP API

The core API exposed over HTTP — the most universal integration point. Any agent in any language that can make HTTP calls can use the brain.

```
POST   /v1/store              → store entries
POST   /v1/recall             → search knowledge
POST   /v1/retire             → retire an entry
POST   /v1/update             → update importance/expiry
GET    /v1/trace/:id          → trace entry provenance
POST   /v1/ingest             → ingest a session file
POST   /v1/session/start      → session-start recall
POST   /v1/session/handoff    → session handoff
GET    /v1/health             → health check + stats
```

An agent's system prompt just needs: "You have a memory API at `http://localhost:3000/v1`" plus endpoint docs. No SDK, no plugin protocol, no custom integration. This is what makes agenr useful beyond OpenClaw — Cursor, Windsurf, Claude Code, or any future agent can use it immediately.

## Sandbox & Dev Loop (Day One)

The sandbox infrastructure already exists and should be re-purposed from the start so every module is testable the moment it's written.

### Existing sandbox infrastructure

```
~/.openclaw-sandbox/                    # OPENCLAW_HOME for sandbox gateway
  .openclaw/openclaw.json               # sandbox gateway config (port 18790)
  .openclaw/agents/main/sessions/       # isolated session files
  .openclaw/agents/main/agent/          # auth-profiles.json (API keys)
  agenr-data/knowledge.db               # isolated agenr database
  agenr-data/config.json                # isolated agenr config
  workspace/                            # sandbox workspace files

~/.local/bin/sandbox-agenr              # CLI wrapper: AGENR_DB_PATH + AGENR_CONFIG_PATH → dist/cli.js
```

### What to update

1. **`sandbox-agenr`** — update `cd` target from `~/Code/agenr` to wherever the new repo lives (probably still `~/Code/agenr` after renaming the old one)

2. **`sandbox-openclaw` config** — update `plugins.load.paths` to point at the new repo, strip `coreProjects` (no project concept), simplify plugin config:

   ```json
   {
     "plugins": {
       "load": { "paths": ["/Users/jmartin/Code/agenr"] },
       "entries": {
         "agenr": {
           "enabled": true,
           "config": {
             "dbPath": "/Users/jmartin/.openclaw-sandbox/agenr-data/knowledge.db",
             "debug": true
           }
         }
       },
       "allow": ["agenr"]
     }
   }
   ```

3. **Fresh sandbox database** — delete `~/.openclaw-sandbox/agenr-data/knowledge.db` when ready. The new schema creates it clean.

4. **VS Code launch configs** — set up from the start in the new repo:
   - `agenr: sandbox ingest (debug)` — ingest against sandbox DB with sourcemaps
   - `agenr: sandbox ingest single file (debug)` — single session file
   - `agenr: debug vitest current file` — test runner

   All with `AGENR_DB_PATH` and `AGENR_CONFIG_PATH` env vars pointing at sandbox data.

5. **Build with sourcemaps** — `tsup --sourcemap` as a `build:debug` script from the start

### Dev loop

**Human (VS Code):**

```
edit → pnpm build:debug → F5 → step through with breakpoints
```

**Agent (headless):**

```
pnpm build → sandbox-agenr ingest <file> --verbose → inspect output
pnpm build → sandbox-agenr recall "query" --verbose → verify recall
pnpm test → run full suite
sqlite3 ~/.openclaw-sandbox/agenr-data/knowledge.db "SELECT ..." → verify DB state
```

**Plugin testing:**

```
pnpm build → sandbox-openclaw gateway run → test at localhost:18790
```

Every CLI command must support `--verbose` and `--dry-run` flags from the start so agents can inspect behavior without a GUI debugger. The sandbox DB is a plain SQLite file — agents can query it directly to verify what got stored, what got recalled, etc.

### Real session files for testing

`~/.openclaw-sandbox/.openclaw/agents/main/real_seed_sessions_2_days/` — real OpenClaw sessions for ingest testing.

## Execution Approach

This is a build, not a migration. Estimated timeline with Codex doing implementation:

1. **Skeleton + config + schema + sandbox** — repo init, build tooling, config loader, schema definition, db client, VS Code debug configs, sandbox wrappers verified. (~1 session)
2. **Store + embeddings** — embedding client, store pipeline with dedup. (~1 session)
3. **Recall** — vector/lexical retrieval, scoring, session-start workflow. (~1-2 sessions)
4. **Ingestion** — OpenClaw adapter, new extraction prompt, pipeline orchestration. (~2 sessions — prompt rewrite is the hard part)
5. **Surgeon** — consolidation, dedup, retirement. (~1 session)
6. **OpenClaw plugin** — session start, mid-session recall, tools, handoff, session predecessor. (~2 sessions)
7. **MCP** — lift and adapt. (~1 session)
8. **CLI** — thin command handlers. (~1 session)
9. **Integration testing** — end-to-end with real session files via sandbox. (~1 session)

**Estimated total: ~10-12 Codex sessions**, with Jim reviewing between each.

## What Gets Left Behind

Things in v0 that explicitly do NOT port to v1 unless proven needed:

- Eval module / eval harness
- Claims / contradiction system
- Graph neighborhood in recall
- Co-recall edges
- Surfaced memory ledger (tracking which entries were shown)
- Memory surface contract (complex admission/partitioning)
- Session continuity predecessor chains (6-file system — replaced by simple predecessor lookup)
- Identity breadcrumb persistence
- Session start selector analysis (over-engineered selection)
- Session family policy engine
- Session continuity diagnostics
- Memory reliability diagnostics
- Project attribution (entire concept removed)
- Platform concept (entire concept removed)
- Session project tools (set/get/clear project)
- Project-scoped recall
- Project inference and resolution
- All db audit/repair/backfill/recovery commands
- Review queue
- Todo system
- Benchmark command
- Context command
- Edges command
- Health command
- Init wizard (setup is enough)
- Checkpoint command
- Clusters command (CLI — surgeon may still use clustering internally)
- Conflicts command
- All migration machinery
- Legacy config normalization
