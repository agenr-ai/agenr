# agenr Architecture

This document describes how agenr converts raw conversation text into durable, queryable memory using local SQLite/libsql storage, vector search, and memory-aware recall scoring. It is written for contributors to the codebase.

---

## Table of Contents

- [Entry Points](#entry-points)
- [System Overview](#system-overview)
- [Source Directory Structure](#source-directory-structure)
- [Data Flow](#data-flow)
- [Config System](#config-system)
- [Storage Layer](#storage-layer)
- [Entry Model](#entry-model)
- [Embeddings](#embeddings)
- [Platform Adapter System](#platform-adapter-system)
- [Deduplication Strategy (Store Pipeline)](#deduplication-strategy-store-pipeline)
- [Recall Scoring Model](#recall-scoring-model)
- [Session-Start Context Injection](#session-start-context-injection)
- [Cross-Session Handoff](#cross-session-handoff)
- [Consolidation Architecture](#consolidation-architecture)
- [Watch System](#watch-system)
- [Watcher Management (CLI)](#watcher-management-cli)
- [OpenClaw Plugin Architecture](#openclaw-plugin-architecture)
- [Signal/Notification System](#signalnotification-system)
- [Init Wizard](#init-wizard)
- [CLI Commands](#cli-commands)
- [MCP Server Architecture](#mcp-server-architecture)
- [Auth and Model Resolution](#auth-and-model-resolution)
- [Retirement System](#retirement-system)
- [Benchmark and Eval](#benchmark-and-eval)

---

## Entry Points

There are four independent entry points into agenr:

**CLI commands** (`src/commands/`, `src/cli-main.ts`)
The primary interface for manual operation. Commands include `store`, `recall`, `ingest`, `consolidate`, `retire`, `init`, `health`, `context`, `eval`, `todo`, `db`, and `watcher`. Each command initializes the DB, runs its pipeline, and exits.

**Watch system** (`src/watch/watcher.ts`, `src/commands/watch.ts`)
A background process that monitors session transcript files continuously. This is the primary ingestion mode in production deployments. It detects new content by byte offset (not re-parsing), extracts knowledge, and stores it incrementally. Managed via macOS launchd through the `agenr watcher` CLI.

**MCP server** (`src/mcp/server.ts`)
A stdio JSON-RPC 2.0 server that exposes four tools (`agenr_recall`, `agenr_store`, `agenr_extract`, `agenr_retire`) to any MCP-compatible AI assistant. The server is stateless per call; DB initialization is lazy.

**OpenClaw plugin** (`src/openclaw-plugin/index.ts`)
A host-level integration that hooks into the OpenClaw agent framework. Before each session prompt is built, the plugin injects three-phase context (recent turns, browse recall, semantic recall) and any pending signals. It also handles cross-session handoff via `before_reset` and registers the four MCP tools directly into OpenClaw. See [OpenClaw Plugin Architecture](#openclaw-plugin-architecture).

---

## System Overview

```
  +------------------+  +------------------+  +------------------+  +-------------------+
  |   CLI Commands   |  |   MCP Server     |  |  Watch System    |  |  OpenClaw Plugin  |
  | store/recall/    |  | stdio JSON-RPC   |  | launchd, fs-     |  | before_prompt_    |
  | ingest/retire/   |  | 4 tools exposed  |  | events + polling |  | build hook        |
  | consolidate/init |  |                  |  | incremental read |  | 3-phase recall    |
  | health/context.. |  |                  |  |                  |  | handoff system    |
  +--------+---------+  +--------+---------+  +--------+---------+  +---------+---------+
           |                     |                     |                       |
           +---------------------+---------------------+-----------------------+
                                           |
                                           v
              +----------------------------+----------------------------+
              |           Platform Adapter / Input Parser               |
              |  detectAdapter() -> SourceAdapter.parse()               |
              |  openclaw / claude-code / codex / plaud / text /        |
              |  cursor / vscode-copilot                                |
              +----------------------------+----------------------------+
                                           |
                                           v
              +----------------------------+----------------------------+
              |             LLM Extraction Layer                        |
              |  extractKnowledgeFromChunks() (src/extractor.ts)        |
              |  whole-file mode (src/ingest/whole-file.ts) or chunked  |
              |  -> KnowledgeEntry[]                                    |
              +----------------------------+----------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
     +--------------+---------------+            +---------------+--------------+
     |  Embeddings Client           |            |  Store Pipeline              |
     |  OpenAI text-embedding-3-    |            |  dedup + relations + log     |
     |  small, 1024 dimensions      |            |  (src/db/store.ts)           |
     +--------------+---------------+            +---------------+--------------+
                    |                                             |
                    +---------------------+-----------------------+
                                          |
                                          v
                       +------------------+-------------------+
                       |  SQLite/libsql (local file DB)       |
                       |  entries / tags / relations / FTS /   |
                       |  vector / signal_watermarks /         |
                       |  ingest_log / entry_sources           |
                       +------------------+-------------------+
                                          |
                  +-----------------------+-----------------------+
                  |                                               |
                  v                                               v
  +---------------+----------------+            +----------------+---------------+
  |  Recall Pipeline               |            |  Consolidation                 |
  |  vector top-k -> filter ->     |            |  Tier 1: rules / expiry        |
  |  score -> rank                 |            |  Tier 2: LLM cluster + merge   |
  |  (src/db/recall.ts)            |            |  (src/consolidate/)            |
  +--------------------------------+            +--------------------------------+
```

---

## Source Directory Structure

```
src/
  cli.ts                        # Process-level entry, warning suppression
  cli-main.ts                   # Commander program definition, all subcommands
  config.ts                     # Config read/write, auth method definitions
  extractor.ts                  # LLM extraction (chunked + whole-file dispatch)
  parser.ts                     # Transcript chunking (chunkMessages)
  types.ts                      # Core types, enums (KnowledgeEntry, etc.)
  schema.ts                     # Zod/Typebox validation schemas
  platform.ts                   # Platform normalization
  project.ts                    # Project filter parsing
  setup.ts                      # Interactive setup wizard (auth, model, embedding)
  output.ts                     # Output formatting utilities
  ui.ts                         # Terminal UI helpers (clack wrappers)
  version.ts                    # APP_VERSION constant
  dedup.ts                      # Standalone dedup utilities
  shutdown.ts                   # Graceful shutdown handler
  auth-status.ts                # Auth probe + connection test

  adapters/
    types.ts                    # SourceAdapter interface, ParseResult, Message
    registry.ts                 # detectAdapter() - selects adapter by file/content
    jsonl-base.ts               # Shared JSONL parsing logic
    jsonl-registry.ts           # JSONL format sniffing
    jsonl-generic.ts            # Generic JSONL fallback
    openclaw.ts                 # OpenClaw .jsonl adapter
    claude-code.ts              # Claude Code .jsonl adapter
    codex.ts                    # Codex .jsonl adapter
    cursor.ts                   # Cursor IDE .vscdb adapter
    vscode-copilot.ts           # VS Code Copilot .vscdb adapter
    plaud.ts                    # Plaud voice memo .md adapter
    text.ts                     # Plain text fallback adapter

  benchmark/
    scorer.ts                   # Benchmark scoring logic
    types.ts                    # Benchmark types

  cli/
    option-parsers.ts           # CLI option parsing helpers

  commands/
    shared.ts                   # Shared command utilities (DB path resolution)
    benchmark.ts                # `agenr benchmark` - recall quality benchmarks
    consolidate.ts              # `agenr consolidate` - batch cleanup pipeline
    context.ts                  # `agenr context` - generate CONTEXT.md snapshot
    db.ts                       # `agenr db` - stats/export/check/reset/rebuild
    eval.ts                     # `agenr eval` - recall evaluation + baselines
    health.ts                   # `agenr health` - DB health + forgetting stats
    ingest.ts                   # `agenr ingest` - file ingestion pipeline
    init.ts                     # `agenr init` - project init wizard
    mcp.ts                      # `agenr mcp` - start MCP stdio server
    recall.ts                   # `agenr recall` - semantic search CLI
    reset.ts                    # `agenr reset` - DB reset with backup
    retire.ts                   # `agenr retire` - interactive entry retirement
    store.ts                    # `agenr store` - store single entry
    todo.ts                     # `agenr todo` - interactive todo management
    watch.ts                    # `agenr watch` - foreground watcher
    watcher.ts                  # `agenr watcher` - launchd service management

  consolidate/
    orchestrate.ts              # Two-tier consolidation orchestrator
    rules.ts                    # Tier 1: rule-based expiry + forgetting
    cluster.ts                  # Tier 2: union-find semantic clustering
    merge.ts                    # Tier 2: LLM-assisted canonical merge
    verify.ts                   # Post-merge semantic verification
    util.ts                     # Shared consolidation utilities

  db/
    client.ts                   # DB connection, initDb, migrations, backup
    schema.ts                   # Table DDL, migration steps, initSchema
    store.ts                    # storeEntries() with online dedup
    recall.ts                   # recall() with vector search + scoring
    session-start.ts            # Session-start recall (budget-aware, categorized)
    relations.ts                # Inter-entry relation management
    retirements.ts              # Retirement DB operations
    signals.ts                  # Signal watermark + fetch
    stored-entry.ts             # StoredEntry mapping from DB rows
    vector-index.ts             # Vector index rebuild/reindex
    lockfile.ts                 # File-based locking
    minhash.ts                  # MinHash signatures for bulk dedup

  embeddings/
    cache.ts                    # Embedding cache layer
    client.ts                   # OpenAI embedding API client

  ingest/
    whole-file.ts               # Whole-file extraction mode logic
    write-queue.ts              # Batched write queue for ingest

  llm/
    client.ts                   # LLM client factory (Anthropic/OpenAI)
    credentials.ts              # Credential discovery (env, config, keychain)
    models.ts                   # Model registry, alias resolution
    stream.ts                   # Streaming LLM response handler

  mcp/
    server.ts                   # MCP stdio JSON-RPC server

  openclaw-plugin/
    index.ts                    # Plugin entry: hooks, lifecycle, handoff
    recall.ts                   # Recall subprocess spawning for plugin
    session-query.ts            # Session file parsing (turns, seeds, metadata)
    signals.ts                  # Signal checking for plugin
    tools.ts                    # Tool execution (store/recall/retire/extract)
    types.ts                    # Plugin-specific types

  utils/
    entry-utils.ts              # Entry utility functions
    string.ts                   # String utilities
    time.ts                     # Time/date utilities

  watch/
    watcher.ts                  # Core watcher loop (fs events + polling)
    health.ts                   # Health file write/read/staleness check
    pid.ts                      # PID file management
    state.ts                    # Watch state persistence (per-file offsets)
    platform-defaults.ts        # Default watch directories per platform
    session-resolver.ts         # SessionResolver interface
    resolvers/
      index.ts                  # Platform detection + resolver dispatch
      auto.ts                   # Auto-detection resolver
      claude-code.ts            # Claude Code session resolver
      codex.ts                  # Codex session resolver
      openclaw.ts               # OpenClaw session resolver
      mtime.ts                  # Fallback: sort by mtime
```

---

## Data Flow

Source: `src/commands/`, `src/extractor.ts`, `src/db/store.ts`, `src/db/recall.ts`

```
Session files (.jsonl, .md, .txt, .vscdb)
        |
        v
  detectAdapter() selects SourceAdapter
        |
        v
  adapter.parse() -> ParseResult { messages[], metadata }
        |
        v
  extractKnowledgeFromChunks() or whole-file extraction
        |  (LLM call: structured output -> KnowledgeEntry[])
        v
  Embedding generation (text-embedding-3-small, 1024 dims)
        |
        v
  storeEntries() - online dedup (content hash -> vector -> LLM)
        |
        v
  SQLite/libsql (entries + tags + relations + vectors)
        |
        +---> recall() - vector top-k -> filter -> score -> rank
        |
        +---> consolidate() - Tier 1 rules, Tier 2 LLM cluster+merge
```

### Extraction Modes

Two extraction paths exist:

- **Whole-file mode** (default `auto`): when a transcript fits within the model context window, the full session is sent as a single LLM call. Text is reconstructed from the parsed message list via `renderTranscriptLine()` to avoid chunk-overlap duplication. Pre-fetch and the post-extraction LLM dedup pass are both skipped. Retries up to 3 times with exponential backoff before falling back to chunked. Helpers live in `src/ingest/whole-file.ts`.

- **Chunked mode** (`--chunk` flag or when the file exceeds the context window): the transcript is split into ~3K-token chunks with 1,200-character overlap via `chunkMessages()` in `src/parser.ts`. Chunks are extracted in parallel up to `llmConcurrency`, then a post-extraction LLM dedup pass merges near-duplicates across chunk boundaries.

Mode is auto-detected per file against a model context window registry in `src/ingest/whole-file.ts`. Unknown models always fall back to chunked. Watch mode always uses chunked (whole-file would re-extract the full file on every append event). CLI flags `--whole-file` and `--chunk` override auto-detect; they are mutually exclusive.

---

## Config System

Source: `src/config.ts`

Config file location: `~/.agenr/config.json` (mode `0o600`).
Override via env var: `AGENR_CONFIG_PATH`.
DB path override: `AGENR_DB_PATH` env var.

Full config schema:

```json
{
  "auth": "anthropic-oauth | anthropic-token | anthropic-api-key | openai-subscription | openai-api-key",
  "provider": "anthropic | openai | openai-codex",
  "model": "<model-id>",
  "labelProjectMap": {
    "<session-label>": "<project-name>"
  },
  "forgetting": {
    "protect": ["pattern-*"],
    "scoreThreshold": 0.05,
    "maxAgeDays": 60,
    "enabled": true
  },
  "credentials": {
    "anthropicApiKey": "...",
    "anthropicOauthToken": "...",
    "openaiApiKey": "..."
  },
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1024,
    "apiKey": "..."
  },
  "db": {
    "path": "~/.agenr/knowledge.db"
  },
  "dedup": {
    "aggressive": false,
    "threshold": 0.72
  }
}
```

`labelProjectMap` maps session label strings to project names. When an ingest or watch cycle resolves a session label that appears in this map, the stored entries are tagged with the mapped project name, enabling per-project scoping of recall results.

---

## Storage Layer

Source: `src/db/client.ts`, `src/db/schema.ts`

agenr uses libsql/SQLite via `@libsql/client`. SQLite was chosen because agenr is local-first by design: no internet dependency for storage, no external service to configure, and the entire knowledge base is a single portable file. libsql provides the vector index extension (`libsql_vector_idx`) on top of standard SQLite.

Default DB path: `~/.agenr/knowledge.db` (resolved in `src/db/client.ts`). Override with `AGENR_DB_PATH` env var or `db.path` in config.

Migrations are defined as a series of column-presence checks followed by `ALTER TABLE` statements in `src/db/schema.ts`. They apply automatically on first run after an upgrade. No manual migration steps are needed.

### Database Schema

**`entries` table columns:**

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT | Knowledge type (see Entry Model) |
| `subject` | TEXT | Short subject line |
| `canonical_key` | TEXT | Optional stable identity for cross-ingestion dedup |
| `content` | TEXT | Full entry content |
| `importance` | INTEGER | 1-10 |
| `expiry` | TEXT | core, permanent, temporary |
| `scope` | TEXT | private, personal, public |
| `platform` | TEXT | openclaw, claude-code, codex |
| `project` | TEXT | Project scoping key |
| `source_file` | TEXT | Originating file path |
| `source_context` | TEXT | Extraction context |
| `embedding` | F32_BLOB(1024) | 1024-dim float32 vector |
| `content_hash` | TEXT | Content hash for idempotency |
| `norm_content_hash` | TEXT | SHA-256 of normalized content (bulk dedup) |
| `minhash_sig` | BLOB | 512-byte MinHash signature (bulk dedup) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_recalled_at` | TEXT | ISO timestamp of last recall |
| `recall_count` | INTEGER | Times recalled |
| `recall_intervals` | TEXT | JSON array of epoch-second timestamps |
| `confirmations` | INTEGER | Reinforcement count from dedup |
| `contradictions` | INTEGER | Contradiction count |
| `superseded_by` | TEXT FK | ID of superseding entry (soft delete) |
| `merged_from` | INTEGER | Number of source entries merged |
| `consolidated_at` | TEXT | ISO timestamp of last consolidation |
| `suppressed_contexts` | TEXT | JSON array; matching contexts excluded from session-start recall |
| `retired` | INTEGER | Soft-delete flag (0/1) |
| `retired_at` | TEXT | ISO timestamp |
| `retired_reason` | TEXT | Free-text reason |

**Additional tables:**

| Table | Purpose |
|---|---|
| `tags` | Normalized tag mapping (`entry_id`, `tag`) |
| `relations` | Inter-entry links: `supersedes`, `contradicts`, `elaborates`, `related` |
| `ingest_log` | Ingest idempotency and run history |
| `entry_sources` | Provenance snapshots for merged entries |
| `signal_watermarks` | Per-consumer rowid cursor for signal delivery |

**Search and index objects:**

- Vector index: `idx_entries_embedding` using `libsql_vector_idx(... metric=cosine ...)`
- Full-text index: `entries_fts` virtual table with insert/update/delete triggers

---

## Entry Model

Source: `src/types.ts`

Knowledge types (7): `fact`, `decision`, `preference`, `todo`, `relationship`, `event`, `lesson`

Importance (integer 1-10):
- Score 7 is the coached default
- Scores >= 8 trigger real-time cross-session signals in OpenClaw
- Score 10 is always protected from forgetting regardless of age
- Full per-score calibration is defined in the LLM prompt in `src/extractor.ts`

Expiry levels: `core`, `permanent`, `temporary`
- Only `temporary` entries are subject to forgetting/expiry

Scope levels: `private`, `personal`, `public`

---

## Embeddings

Source: `src/embeddings/client.ts`, `src/embeddings/cache.ts`

- Model: `text-embedding-3-small`
- Dimensions: `1024` (truncated from 1536 for 33% storage savings)
- Batch size: `200`
- Max concurrency: `3`
- Input text format: `"<type>: <subject> - <content>"` (composed by `composeEmbeddingText`)

Embedding API key resolution order (`resolveEmbeddingApiKey`):
1. `config.embedding.apiKey`
2. `config.credentials.openaiApiKey`
3. `OPENAI_API_KEY` env var

---

## Platform Adapter System

Source: `src/adapters/registry.ts`, `src/adapters/`

The adapter system normalizes heterogeneous input file formats into a uniform message list.

### SourceAdapter interface

```typescript
interface SourceAdapter {
  name: string;
  canHandle(filePath: string, firstLine?: string): boolean;
  parse(filePath: string, options: AdapterParseOptions): Promise<ParseResult>;
}
```

`detectAdapter()` in `src/adapters/registry.ts` selects the adapter by file extension and, for `.jsonl` files, first-line sniffing to distinguish between openclaw, claude-code, and codex formats.

### Adapters

| Adapter | File types | Notes |
|---|---|---|
| `openclaw` | `.jsonl` | OpenClaw session transcripts |
| `claude-code` | `.jsonl` | Claude Code session transcripts |
| `codex` | `.jsonl` | Codex session transcripts |
| `cursor` | `.vscdb` | SQLite DB from Cursor IDE |
| `vscode-copilot` | `.vscdb` | SQLite DB from VS Code Copilot |
| `plaud` | `.md` | Plaud voice memo transcripts |
| `text` | `.txt`, fallback | Plain text, no structure assumed |

Shared JSONL logic lives in `src/adapters/jsonl-base.ts`. The `jsonl-registry.ts` module handles format sniffing for JSONL variants. `jsonl-generic.ts` provides a fallback for unrecognized JSONL formats.

---

## Deduplication Strategy (Store Pipeline)

Source: `src/db/store.ts`

Store uses an online, per-entry dedup model. Online dedup prevents duplicates from accumulating at write time, keeping the vector index clean and reducing consolidation work.

**Per-entry transactions:** LLM dedup calls take seconds. Each entry uses its own `BEGIN IMMEDIATE`/`COMMIT` so the lock is held only during the actual DB write, not during LLM calls.

### Dedup Steps

1. **Content-hash fast path** - If `content_hash` exists in DB, skip before any embedding work.

2. **Fast vector path** - Find top-k similar active entries (`superseded_by IS NULL`):
   - >= 0.95 + same type: skip (near-exact duplicate)
   - >= 0.88 + same subject + same type: reinforce (`confirmations += 1`)
   - 0.88-0.95 + same subject + different type: insert + create `related` relation

3. **Online LLM decision** - For candidates above `dedupThreshold` (default 0.72; 0.62 in aggressive mode), LLM returns: `ADD`, `UPDATE`, `SKIP`, or `SUPERSEDE`.

4. **Failure fallback** - LLM failure falls back to `ADD` to avoid data loss.

### Bulk Ingest Mode (`--bulk`)

For large-scale ingests, `--bulk` defers FTS trigger maintenance and vector index updates to a single post-write rebuild pass:

1. Drop FTS triggers and vector index
2. Write `bulk_ingest_state` to `_meta` table (crash recovery signal)
3. Write entries in batches of 500
4. Rebuild FTS content and recreate vector index
5. Clear `bulk_ingest_state`

Bulk dedup uses `norm_content_hash` (exact) and MinHash signatures (near-duplicate) instead of per-entry vector similarity. Run `agenr consolidate --sim-threshold 0.76` after bulk ingest to catch semantic near-duplicates.

Crash recovery: `checkAndRecoverBulkIngest()` runs during `initDb({ checkBulkRecovery: true })` and rebuilds any missing indexes.

---

## Recall Scoring Model

Source: `src/db/recall.ts`

Recall starts with vector top-k candidates from `idx_entries_embedding`, then applies filters (scope, type, project, tags, since, until) and multiplicative scoring.

**Why multiplicative scoring:** A single disqualifying factor (stale recency, many contradictions, past-due todo) suppresses the entry even if vector similarity is high.

### Scoring Formula

```
effectiveNow     = untilCeiling ?? now

sim              = rawVectorSimilarity ^ 0.7

rec              = recency(daysOld(effectiveNow), entry.expiry)
                   -- half-lives: core=infinite, permanent=365d, temporary=30d

imp              = importanceScore(entry.importance)

recallBase       = recallStrength(recall_count, daysSinceRecall, expiry)
spacingFactor    = computeSpacingFactor(recall_intervals)
                   -- log-scale spaced-repetition bonus
spacedRecallBase = min(recallBase * spacingFactor, 1.0)

fresh            = freshnessBoost(entry, now)
                   -- 1.5x < 1h, 1.25x < 6h, 1.1x < 24h, 1.0x otherwise

memoryStrength   = min(max(imp, spacedRecallBase) * fresh, 1.0)

todoPenalty      = todoStaleness(entry) if type == "todo" else 1.0
                   -- exponential decay, 7-day half-life

contradictionPenalty = 0.8 if contradictions >= 2 else 1.0

fts              = 0.15 if ftsMatch else 0.0

score = sim * (0.3 + 0.7 * rec) * memoryStrength * todoPenalty * contradictionPenalty + fts
```

### Temporal Window Filters

- `since`: lower bound (inclusive), ISO date or relative duration
- `until`: upper bound (inclusive), same semantics
- When `until` is present, decay scoring anchors to `effectiveNow = until`
- `freshnessBoost` always anchors to real query time

### Spaced Repetition

`recall_intervals` is a JSON array of epoch-second timestamps appended on each recall. `computeSpacingFactor()` rewards entries recalled at expanding intervals (spaced practice) over entries recalled repeatedly in a short window.

---

## Session-Start Context Injection

Source: `src/openclaw-plugin/index.ts`, `src/openclaw-plugin/recall.ts`, `src/openclaw-plugin/session-query.ts`, `src/db/session-start.ts`

When the OpenClaw plugin fires `before_prompt_build` for a new session, it assembles context in three phases that run concurrently where possible:

```
Phase 1A: Recent Turns          Phase 1B: Browse Recall
(previous session file)          (temporal, last 1d, limit 20)
  |                                |
  +-----> buildSemanticSeed() <----+
                  |
                  v
          Phase 2: Semantic Recall
          (query = seed from 1A + current prompt)
          (deduplicated against Phase 1B results)
```

### Phase 1A - Recent Turns

`findPreviousSessionFile()` locates the prior session transcript in the sessions directory. `extractRecentTurns()` pulls the last N user/assistant exchanges (default 7, capped at 300 chars each) to provide immediate continuity.

### Phase 1B - Browse Recall

A temporal browse query (`--browse --since 1d --limit 20`) fetches the most recent knowledge entries by date and importance. No semantic query is needed; this surfaces what was learned recently. Browse results also trigger handoff entry retirement (see [Cross-Session Handoff](#cross-session-handoff)).

### Phase 2 - Semantic Recall

`buildSemanticSeed()` combines the previous session turns and the current prompt into a query seed. This seed drives a semantic recall query. Results that already appeared in Phase 1B are filtered out by entry ID to avoid duplication.

### Assembled Output

The three phases are combined as markdown sections injected via `prependContext`:

```markdown
## Recent session
<Phase 1A: last few turns from previous session>

## Recent memory
<Phase 1B: browse recall results>

## Relevant memory
<Phase 2: semantic recall results>
```

### Budget-Aware Session-Start Recall

`src/db/session-start.ts` implements categorized budget allocation for session-start recall. Entries are classified into categories (`core`, `active`, `preferences`, `recent`) and the token budget is split across them. Token estimation uses a word-count heuristic with 1.3x multiplier.

---

## Cross-Session Handoff

Source: `src/openclaw-plugin/index.ts` (functions: `runHandoffForSession`, `summarizeSessionForHandoff`)

The handoff system ensures context flows between sessions. It triggers on two hooks:

- **`before_reset`** - Fires when a session is about to be cleared
- **`session_start`** (within `before_prompt_build`) - Fires for the previous session if it was not already handled by `before_reset`

### Two-Phase Fallback+Upgrade Architecture

```
Session ends (before_reset or session_start)
        |
        v
  Phase 1: FALLBACK (immediate, no LLM)
    extractLastExchangeText() -> store as "session handoff <timestamp>"
    Tagged: ["handoff", "session"]
    This ensures the next session always has *something* to read.
        |
        v
  Phase 2: LLM UPGRADE (awaited, may take seconds)
    summarizeSessionForHandoff() -> LLM summarization of full transcript
    If successful:
      - Store LLM summary as new handoff entry
      - Retire the Phase 1 fallback entry (superseded)
    If failed:
      - Phase 1 fallback remains as-is
```

### LLM Summarization

`summarizeSessionForHandoff()` builds a transcript from the session messages, optionally including the prior session's context for continuity. It:

1. Reads and normalizes messages from the session JSONL file
2. Optionally reads the prior session's reset file for merged context
3. Caps transcript length to fit within model context
4. Sends to LLM with a dedicated system prompt
5. Returns the summary text

Skip conditions: too few messages, transcript too short, no API key available, LLM error.

Handoff logs (request/response) can be written to disk when `handoff.logEnabled` is true in plugin config.

### Handoff Lifecycle

1. At `before_reset`: handoff runs with `source: "before_reset"`
2. At next `session_start`: browse recall surfaces handoff entries
3. Handoff entries with subject starting "session handoff" are retired after consumption
4. `handoffSeenSessionIds` set prevents duplicate handoffs for the same session

---

## Consolidation Architecture

Source: `src/consolidate/orchestrate.ts`, `src/consolidate/rules.ts`, `src/consolidate/cluster.ts`, `src/consolidate/merge.ts`, `src/consolidate/verify.ts`

Consolidation is a two-tier offline pipeline. Tier 1 handles common cases cheaply. Tier 2 handles semantic near-duplicates with LLM assistance.

Locking: File lock at `~/.agenr/consolidation.lock` prevents concurrent runs.

### Tier 1: Rules-based Cleanup

- Applies forgetting/expiry to low-scoring temporary entries
- Merges near-exact duplicates with structural safeguards
- Cleans orphaned non-`supersedes` relations

### Tier 2: LLM-assisted Clustering and Merge

- Builds semantic clusters using union-find with diameter-capped validation
- Generates canonical entries via LLM tool-calling
- Verifies merged semantics before commit (failed verifications go to review queue)

### Forgetting and Decay

Tier 1 expiry uses the same `recency()` function as recall scoring. For `temporary`-expiry entries (30-day half-life), an entry is deleted when its recency score falls below 0.05 (approximately 130 days without recall).

Protection rules:
- Entries with `importance >= 10` are always protected
- Entries matching `forgetting.protect[]` patterns are always protected

---

## Watch System

Source: `src/watch/watcher.ts`, `src/watch/state.ts`, `src/watch/health.ts`

The watch system is the primary continuous-ingestion mode.

### Watcher Loop

`runWatcher()` in `src/watch/watcher.ts`:

- Detects file changes via filesystem events with debounce, plus timed polling fallback
- Reads files incrementally by byte offset (not re-parsing entire files)
- Writes health file (`watcher.health.json`) on each cycle
- Writes PID to `~/.agenr/watcher.pid`

### Watch State

Persisted at `~/.agenr/watch-state.json`. Per-file tracking: `byteOffset`, `lastRunAt`, `totalEntriesStored`, `totalRunCount`.

### Session Resolvers

Source: `src/watch/resolvers/`, `src/watch/session-resolver.ts`

Each platform has a resolver that implements `SessionResolver`:

```typescript
interface SessionResolver {
  filePattern: string;
  resolveActiveSession(dir: string): Promise<string | null>;
  findRenamedFile?(originalPath: string): Promise<string | null>;
}
```

| Resolver | Platform | Detection |
|---|---|---|
| `openclaw.ts` | OpenClaw | `/.openclaw/` in path |
| `claude-code.ts` | Claude Code | `/.claude/` in path |
| `codex.ts` | Codex | `/.codex/` in path |
| `mtime.ts` | Fallback | Sort by modification time |

Platform auto-detection: `detectPlatformFromDir()` in `src/watch/resolvers/index.ts` inspects the watched directory path.

### Health Monitoring

`src/watch/health.ts` manages a health file that tracks: PID, start time, last heartbeat, sessions watched, entries stored. Staleness threshold: 5 minutes.

---

## Watcher Management (CLI)

Source: `src/commands/watcher.ts`

The `agenr watcher` command manages the watcher as a macOS launchd service.

- Plist: `~/Library/LaunchAgents/com.agenr.watch.plist`
- Logs: `~/.agenr/logs/`

Subcommands: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`

`agenr watch` (without the 'er') runs the watcher in the foreground.

---

## OpenClaw Plugin Architecture

Source: `src/openclaw-plugin/index.ts`, `openclaw.plugin.json`

### Plugin Manifest

`openclaw.plugin.json` declares the plugin ID (`"agenr"`), skills (the four tools), and config schema.

### Lifecycle

The plugin registers three hooks:

**`before_prompt_build`** - Fires on every prompt. For new sessions (LRU dedup, max 1000 tracked):
1. Skips subagent (`:subagent:`) and cron (`:cron:`) sessions
2. Runs three-phase context injection (see [Session-Start Context Injection](#session-start-context-injection))
3. Triggers handoff for the previous session if not already handled
4. Retires consumed handoff entries
5. Checks for pending signals
6. Returns combined context as `prependContext`

**`before_reset`** - Fires when a session is cleared:
1. Runs cross-session handoff (see [Cross-Session Handoff](#cross-session-handoff))

**`command`** - Fires on explicit handoff commands:
1. Runs handoff for the current session

Errors from any hook are swallowed. The plugin must never block or crash a prompt build.

### Tools Registered into OpenClaw

| Tool | Description |
|---|---|
| `agenr_recall` | Semantic search over the knowledge base |
| `agenr_store` | Store a single structured entry (bypasses extraction) |
| `agenr_extract` | Extract and store knowledge from raw text via LLM |
| `agenr_retire` | Soft-delete an entry by ID |

### Plugin Config Keys

| Key | Description |
|---|---|
| `agenrPath` | Path to the agenr installation |
| `dbPath` | Override for the DB path |
| `budget` | Token budget for session-start recall |
| `enabled` | Enable/disable the plugin |
| `project` | Default project for recall/store |
| `sessionsDir` | Override sessions directory |
| `handoff.includeBackground` | Include prior session in handoff transcript |
| `handoff.logEnabled` | Write handoff LLM request/response logs |
| `handoff.logDir` | Directory for handoff logs |
| `signalMinImportance` | Minimum importance for signals (default 8) |
| `signalMaxPerSignal` | Max entries per signal batch (default 3) |
| `signalCooldownMs` | Per-session signal cooldown (default 30000) |
| `signalMaxPerSession` | Max signals per session (default 10) |
| `signalMaxAgeSec` | Max age of signal entries in seconds (default 300) |
| `signalsEnabled` | Enable/disable signal subsystem |

---

## Signal/Notification System

Source: `src/db/signals.ts`, `src/openclaw-plugin/signals.ts`

Delivers real-time notifications when high-importance entries are stored, so the host agent can surface them without waiting for the next session-start recall.

### Storage

`signal_watermarks` table: one row per consumer, tracking a `rowid`-based monotonic cursor. Simplest at-least-once delivery compatible with SQLite.

### Delivery

`fetchNewSignalEntries()` queries entries where `importance >= N AND rowid > watermark AND retired = 0`, advances the watermark, and returns results.

Rate limiting (plugin-side):
- Per-session cooldown (`signalCooldownMs`, default 30s)
- Per-session cap (`signalMaxPerSession`, default 10)
- Max entry age (`signalMaxAgeSec`, default 300s)

---

## Init Wizard

Source: `src/commands/init.ts`, `src/setup.ts`

The `agenr init` command sets up agenr for a project. It operates in two modes:

### Non-Interactive (CLI flags)

When `--platform` and/or `--project` are provided:

1. **Platform detection** - Auto-detects from project directory (`.claude/` -> claude-code, `.cursor/` -> cursor, `.windsurfrules` -> windsurf) or uses explicit `--platform`
2. **Project slug** - Derived from directory name or explicit `--project`
3. **Config write** - Creates `.agenr.json` in project root
4. **Instructions file** - Injects agenr prompt block (with markers for idempotent updates) into platform-specific instructions file:
   - Claude Code: `~/.claude/CLAUDE.md`
   - Cursor: `.cursor/rules/agenr.mdc` or `.cursorrules`
   - Windsurf: `~/.codeium/windsurf/memories/global_rules.md`
   - Codex: `~/.codex/AGENTS.md` (special TOML config for Codex)
   - OpenClaw: skipped (plugin handles injection)
   - Generic: `AGENTS.md` in project root
5. **MCP config** - Writes MCP server entry to platform-specific config
6. **Gitignore** - Adds `.agenr.json` to `.gitignore`

### Interactive Wizard

`runInitWizard()` provides a guided setup using `@clack/prompts` for terminal UI. Currently handles initial config setup; full wizard features (platform selection, project wiring) are in progress.

### Global Setup

`src/setup.ts` handles the global `agenr setup` flow:
1. Auth method selection (5 methods: anthropic-oauth, anthropic-token, anthropic-api-key, openai-subscription, openai-api-key)
2. Credential entry and validation
3. Model selection (provider-aware, with recommended defaults)
4. Embedding API key configuration
5. Connection test

---

## CLI Commands

Source: `src/cli-main.ts`, `src/commands/`

| Command | Description |
|---|---|
| `agenr setup` | Global config wizard (auth, model, embedding) |
| `agenr init` | Project init wizard (platform, MCP, instructions) |
| `agenr store` | Store a single knowledge entry |
| `agenr recall` | Semantic search with scoring |
| `agenr ingest` | Ingest transcript files (whole-file or chunked) |
| `agenr consolidate` | Run consolidation pipeline (Tier 1 + Tier 2) |
| `agenr retire` | Interactive entry retirement |
| `agenr health` | DB health stats and forgetting analysis |
| `agenr context` | Generate CONTEXT.md snapshot for static injection |
| `agenr eval` | Recall quality evaluation with baselines |
| `agenr benchmark` | Recall scoring benchmarks |
| `agenr todo` | Interactive todo management |
| `agenr watch` | Run watcher in foreground |
| `agenr watcher` | Manage launchd watcher service |
| `agenr db` | DB utilities: stats, export, check, reset, rebuild, path, version |
| `agenr mcp` | Start MCP stdio server |

---

## MCP Server Architecture

Source: `src/mcp/server.ts`

Transport: stdio. Protocol: JSON-RPC 2.0, version `2024-11-05`.

Exposes four tools: `agenr_recall`, `agenr_store`, `agenr_extract`, `agenr_retire`. Input validation is strict with structured errors for invalid calls.

Lazy DB initialization on first tool call. No persistent state between calls.

---

## Auth and Model Resolution

Source: `src/config.ts`, `src/llm/credentials.ts`, `src/llm/models.ts`, `src/llm/client.ts`

### Auth Methods

| Method | Provider | Credential Source |
|---|---|---|
| `anthropic-oauth` | Anthropic | OAuth flow |
| `anthropic-token` | Anthropic | Long-lived token |
| `anthropic-api-key` | Anthropic | API key |
| `openai-subscription` | OpenAI | Subscription auth |
| `openai-api-key` | OpenAI | API key |

### Credential Discovery

`src/llm/credentials.ts` probes multiple sources:
1. Config file credentials
2. Environment variables
3. Local CLI credential files:
   - Codex: `~/.codex/auth.json` or macOS keychain
   - Claude: `~/.claude/.credentials.json` / `credentials.json` or macOS keychain

### Model Resolution

`src/llm/models.ts` handles model alias resolution and validation. `src/llm/client.ts` creates the appropriate LLM client (Anthropic or OpenAI) based on provider config.

---

## Retirement System

Source: `src/commands/retire.ts`, `src/db/retirements.ts`

Retirement is the standard soft-delete mechanism. Retired entries remain in the DB for provenance but are excluded from all recall, signal, and dedup queries via `retired = 0` filters.

### CLI Flow

1. Fuzzy or exact subject match to find candidates
2. Confirmation prompt
3. Optional reason
4. `--persist` writes to ledger at `~/.agenr/retirements.json`

### Persistence

With `--persist`, retirements are written to a ledger that is replayed on DB initialization, surviving DB rebuilds. Without `--persist`, retirement applies only to the current DB.

The `agenr_retire` MCP tool also supports `persist` as an optional boolean parameter.

---

## Benchmark and Eval

Source: `src/commands/benchmark.ts`, `src/commands/eval.ts`, `src/benchmark/`

### Eval

`agenr eval` tests recall quality against a set of queries (`~/.agenr/eval-queries.json`). Supports saving baselines and comparing against them to detect recall regressions.

### Benchmark

`agenr benchmark` runs scoring benchmarks using the scorer in `src/benchmark/scorer.ts`. Types are defined in `src/benchmark/types.ts`.
