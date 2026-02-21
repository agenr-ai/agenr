# agenr Architecture

This document describes how agenr converts raw conversation text into durable, queryable memory using local SQLite/libsql storage, vector search, and memory-aware recall scoring. It is written for contributors to the codebase.

---

## Entry Points

There are three independent entry points into agenr, plus one host-level integration:

**CLI commands** (`src/commands/`)
The primary interface for manual operation. Commands include `store`, `recall`, `ingest`, `consolidate`, and `retire`. Each command initializes the DB, runs its pipeline, and exits. CLI is also used for daemon management (`daemon install/start/stop/...`).

**Watch daemon** (`src/watch/watcher.ts`, `src/commands/daemon.ts`)
A background process that monitors session transcript files continuously. This is the primary ingestion mode in production deployments. It detects new content by byte offset (not re-parsing), extracts knowledge, and stores it incrementally. Managed via macOS launchd. See [Watch System and Daemon](#watch-system-and-daemon).

**MCP server** (`src/mcp/server.ts`)
A stdio JSON-RPC 2.0 server that exposes four tools (`agenr_recall`, `agenr_store`, `agenr_extract`, `agenr_retire`) to any MCP-compatible AI assistant. The server is stateless per call; DB initialization is lazy.

**OpenClaw plugin** (`src/openclaw-plugin/index.ts`)
A host-level integration that hooks into the OpenClaw agent framework. Before each session prompt is built, the plugin injects session-start recall results and any pending signals into the agent context. It also registers the four MCP tools directly into OpenClaw. See [OpenClaw Plugin Architecture](#openclaw-plugin-architecture).

---

## System Overview

```text
  +------------------+  +------------------+  +------------------+  +-------------------+
  |    CLI Commands  |  |    MCP Server    |  |   Watch Daemon   |  | OpenClaw Plugin   |
  | store/recall/    |  | stdio JSON-RPC   |  | launchd, fs-     |  | before_prompt_    |
  | ingest/retire/   |  | 4 tools exposed  |  | events + polling |  | build hook        |
  | consolidate      |  |                  |  | incremental read |  | recall + signals  |
  +--------+---------+  +--------+---------+  +--------+---------+  +---------+---------+
           |                     |                     |                       |
           +---------------------+---------------------+-----------------------+
                                           |
                                           v
              +----------------------------+----------------------------+
              |           Platform Adapter / Input Parser               |
              |  detectAdapter() -> SourceAdapter.parse()               |
              |  openclaw / claude-code / codex / plaud / text / ...    |
              +----------------------------+----------------------------+
                                           |
                                           v
              +----------------------------+----------------------------+
              |             LLM Extraction Layer                        |
              |  extractKnowledgeFromChunks() (src/extractor.ts)        |
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
                       |  entries / tags / relations / FTS /  |
                       |  vector / signal_watermarks /        |
                       |  ingest_log / entry_sources          |
                       +------------------+-------------------+
                                          |
                                          v
                       +------------------+-------------------+
                       |  Recall Pipeline                     |
                       |  vector top-k -> filter -> score ->  |
                       |  rank (src/db/recall.ts)             |
                       +------------------+-------------------+
                                          |
                                          v
                       +------------------+-------------------+
                       |  Consolidation                       |
                       |  Tier 1: rules / expiry / forgetting |
                       |  Tier 2: LLM cluster + merge         |
                       +--------------------------------------+
```

---

## Data Flow

Source: `src/commands/`, `src/extractor.ts`, `src/db/store.ts`, `src/db/recall.ts`

1. **Text ingestion**
   Input comes from transcript files (`.jsonl`, `.md`, `.txt`) via the platform adapter system or directly from CLI/MCP arguments. Adapters normalize heterogeneous source formats into a uniform message list before any further processing, so the rest of the pipeline never needs to know the source format.

2. **LLM extraction**
   `extractKnowledgeFromChunks()` (`src/extractor.ts`) sends chunked text to the configured LLM and receives back `KnowledgeEntry[]`. Extraction runs per-chunk rather than per-file so that large transcripts fit within context window limits and parallelism is possible.

3. **Structured entry normalization**
   Types and enums from `src/types.ts` are enforced at this stage. Normalization catches out-of-range importance values, unknown types, and missing required fields before the entry reaches storage, preventing corrupt records from entering the DB.

4. **Embedding generation**
   `embed()` in `src/embeddings/client.ts` calls the OpenAI embeddings API. Embeddings are generated from the composed text `"<type>: <subject> - <content>"` so that the vector represents the semantic meaning of the full entry, not just its subject. See [Embeddings](#embeddings).

5. **Storage and dedup**
   `storeEntries()` in `src/db/store.ts` performs a similarity search against existing entries, runs dedup decisions (fast-path or LLM-assisted), creates inter-entry relations, and writes the final record. Dedup runs at write time rather than only at consolidation time because catching duplicates early prevents the vector index from accumulating redundant neighbors that degrade future recall quality. See [Deduplication Strategy](#deduplication-strategy-store-pipeline).

6. **Recall**
   `recall()` in `src/db/recall.ts` fetches vector candidates via the vector index, applies filters (scope, type, project, tags, since, until), computes the final composite score, and ranks results. The composite score combines multiple independent signals so that any single disqualifying factor (stale recency, high contradictions, staleness) suppresses the entry even if its vector similarity is high. See [Recall Scoring Model](#recall-scoring-model).

7. **Consolidation**
   A separate offline process that cleans accumulated entries. Tier 1 (rules) runs first and handles the common cases cheaply. Tier 2 (LLM-assisted clustering) runs on what remains and handles semantically similar but not identical entries. See [Consolidation Architecture](#consolidation-architecture).

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

Schema source: `src/db/schema.ts`

Migrations are defined as a series of column-presence checks followed by `ALTER TABLE` statements. They apply automatically on first run after an upgrade. No manual migration steps are needed.

### `entries` table columns

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT | Knowledge type: fact, decision, preference, todo, relationship, event, lesson |
| `subject` | TEXT | Short subject line |
| `canonical_key` | TEXT | Optional canonical key for stable identity across ingestion runs (see note below) |
| `content` | TEXT | Full entry content |
| `importance` | INTEGER | 1-10 (higher means more important to remember) |
| `expiry` | TEXT | core, permanent, temporary |
| `scope` | TEXT | private (default), personal, or public |
| `platform` | TEXT | Platform tag: openclaw, claude-code, codex |
| `project` | TEXT | Project scoping key (from labelProjectMap or explicit) |
| `source_file` | TEXT | Originating file path |
| `source_context` | TEXT | Extraction context |
| `embedding` | F32_BLOB(1024) | 1024-dimensional float32 vector |
| `content_hash` | TEXT | Content hash for idempotency (v2) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_recalled_at` | TEXT | ISO timestamp of last recall |
| `recall_count` | INTEGER | Times this entry has been recalled |
| `recall_intervals` | TEXT | JSON array of epoch-second timestamps; feeds computeSpacingFactor() for spaced-repetition scoring |
| `confirmations` | INTEGER | Reinforcement count from dedup |
| `contradictions` | INTEGER | Contradiction count |
| `superseded_by` | TEXT FK | ID of superseding entry (soft delete) |
| `merged_from` | INTEGER | Number of source entries merged (v3) |
| `consolidated_at` | TEXT | ISO timestamp of last consolidation (v3) |
| `suppressed_contexts` | TEXT | JSON array of context strings; entries with a matching context are excluded from session-start recall |
| `retired` | INTEGER | Soft-delete flag; 1 = retired, 0 = active (default 0) |
| `retired_at` | TEXT | ISO timestamp when entry was retired (nullable) |
| `retired_reason` | TEXT | Free-text reason for retirement (nullable) |

> Note: (v2) and (v3) annotations in the table above indicate the schema migration that added the column. Migrations apply automatically on first run after an upgrade.

**Note on `canonical_key`:** When two ingestion runs encounter logically identical facts (e.g., a user preference that appears in multiple transcripts), the canonical key provides a stable identity so that the dedup pipeline can recognize them as the same entry and update-in-place rather than creating a sibling duplicate. Without canonical keys, near-identical entries that differ only in phrasing may slip past similarity thresholds.

**Note on `recall_intervals`:** Each time an entry is recalled, the current epoch-second timestamp is appended to this JSON array. `computeSpacingFactor()` uses the distribution of intervals between recalls to compute a spaced-repetition bonus: entries recalled at expanding intervals score higher than those recalled in rapid succession, reflecting stronger encoding.

Primary tables:
- `entries`: core memory records, including metadata and `embedding F32_BLOB(1024)`.
- `tags`: normalized tag mapping (`entry_id`, `tag`).
- `relations`: inter-entry links (`supersedes`, `contradicts`, `elaborates`, `related`).
- `ingest_log`: ingest idempotency and run history.
- `entry_sources`: provenance snapshots for merged entries. Columns include `original_confirmations`, `original_recall_count`, and `original_created_at`.
- `signal_watermarks`: per-consumer rowid cursor for the signal/notification system.

Search and index objects:
- Vector index: `idx_entries_embedding` using `libsql_vector_idx(... metric=cosine ...)`. Cosine similarity is the standard metric for comparing text embedding vectors.
- Full-text index: `entries_fts` virtual table with insert/update/delete triggers.

---

## Entry Model

Source: `src/types.ts`

Knowledge types (7): `fact`, `decision`, `preference`, `todo`, `relationship`, `event`, `lesson`

Importance (integer 1..10):
- Score 7 is the coached default; most stored entries should be 7.
- Scores >= 8 trigger real-time cross-session signals in OpenClaw.
- Score 10 is always protected from forgetting regardless of age.
- Full per-score calibration is defined in the LLM prompt in `src/extractor.ts`.

Expiry levels: `core`, `permanent`, `temporary`
- Only `temporary` entries are subject to forgetting/expiry.

Scope levels: `private`, `personal`, `public`

Stored entry metadata includes: `recall_count`, `last_recalled_at`, `recall_intervals`, `confirmations`, `contradictions`, `superseded_by`, and merge lineage fields from migration v3 (`merged_from`, `consolidated_at`).

---

## Embeddings

Source: `src/embeddings/client.ts`

- Model: `text-embedding-3-small`
- Dimensions: `1024`
- Batch size: `200`
- Max concurrency: `3`
- Input text format: `"<type>: <subject> - <content>"` (composed by `composeEmbeddingText`)

**Why 1024 dimensions instead of 1536:** `text-embedding-3-small` supports a truncated 1024-dimension variant via the `dimensions` parameter. This trades a small amount of recall coverage for a 33% reduction in storage size and embedding API compute cost. For a personal knowledge base where entries number in the thousands rather than millions, the coverage tradeoff is acceptable and the storage savings are significant over time.

Embedding API key resolution order (`resolveEmbeddingApiKey`):
1. `config.embedding.apiKey`
2. `config.credentials.openaiApiKey`
3. `OPENAI_API_KEY` env var

See also: [Recall Scoring Model](#recall-scoring-model) for how embeddings feed into the recall score.

---

## Deduplication Strategy (Store Pipeline)

Source: `src/db/store.ts`

Store uses an online, per-entry dedup model. Online dedup is complementary to batch consolidation: online dedup prevents duplicates from accumulating at write time, which keeps the vector index clean and reduces the work consolidation must do. Batch consolidation handles semantic near-duplicates that slip through online dedup due to phrasing variation.

**Why per-entry transactions:** LLM dedup calls take seconds. Holding a write lock across an LLM call would block all concurrent readers for the duration. Instead, each entry uses its own `BEGIN IMMEDIATE`/`COMMIT` so the lock is held only during the actual DB write.

### Dedup steps

1. **Content-hash fast path**
   If `content_hash` already exists in the DB, the entry is skipped before any embedding or vector work. This catches exact re-ingestions cheaply.

2. **Fast vector path**
   Find top-k similar active entries (`superseded_by IS NULL`).
   - `>= 0.95` + same type: skip as near-exact semantic duplicate.
   - `>= 0.88` + same subject + same type: reinforce existing entry (`confirmations += 1`).
   - `0.88..0.95` + same subject + different type: insert new entry and create a `related` relation.

3. **Online LLM decision path**
   For remaining candidates above `dedupThreshold` (default `0.72`; `0.62` in aggressive mode), the LLM returns one of:
   - `ADD`: insert new entry.
   - `UPDATE`: update target content, re-embed, bump confirmations.
   - `SKIP`: skip insert, bump confirmations on target.
   - `SUPERSEDE`: insert new entry, mark target `superseded_by`, create `supersedes` relation.

4. **Failure fallback**
   If the LLM fails or returns invalid output, fall back to `ADD` to avoid data loss.

Ingest behavior: `ingest` uses the same online dedup path (including LLM decisions) as regular store writes.

Transaction mode:
- Online dedup enabled: per-entry `BEGIN IMMEDIATE`/`COMMIT`.
- Online dedup disabled: single batch transaction for throughput.

See also: [Consolidation Architecture](#consolidation-architecture) for the complementary batch dedup pipeline.

---

## Recall Scoring Model

Source: `src/db/recall.ts`

Recall starts with vector top-k candidates from `idx_entries_embedding`, then applies filters (scope, type, project, tags, since, until) and scoring.

**Why multiplicative scoring:** Each factor in the score is a multiplier. A single disqualifying factor - stale recency, many contradictions, a past-due todo - suppresses the entry even if its vector similarity is high. Additive scoring would merely reduce the score, allowing stale or contradicted entries to still appear in results. Multiplicative scoring makes bad signals disqualifying rather than just penalizing.

### Scoring formula

```pseudocode
effectiveNow     = untilCeiling ?? now

sim              = rawVectorSimilarity ^ 0.7

rec              = recency(daysOld(effectiveNow), entry.expiry)
                   -- expiry half-lives:
                   --   core      = infinite (no decay)
                   --   permanent = 365 days
                   --   temporary = 30 days

imp              = importanceScore(entry.importance)

recallBase       = recallStrength(recall_count, daysSinceRecall(effectiveNow), expiry)

spacingFactor    = computeSpacingFactor(recall_intervals)
                   -- log-scale spaced-repetition bonus derived from
                   -- the history of recall interval timestamps stored
                   -- in the recall_intervals column

spacedRecallBase = min(recallBase * spacingFactor, 1.0)

fresh            = freshnessBoost(entry, now)
                   -- 1.5x  if entry age < 1 hour
                   -- 1.25x if entry age < 6 hours
                   -- 1.1x  if entry age < 24 hours
                   -- 1.0x  otherwise

memoryStrength   = min(max(imp, spacedRecallBase) * fresh, 1.0)

todoPenalty      = todoStaleness(entry, effectiveNow) if entry.type == "todo" else 1.0
                   -- exponential decay with 7-day half-life
                   -- penalizes todos that have not been updated recently

contradictionPenalty = 0.8 if entry.contradictions >= 2 else 1.0

fts              = 0.15 if ftsMatch else 0.0

score = sim * (0.3 + 0.7 * rec) * memoryStrength * todoPenalty * contradictionPenalty + fts
```

### Temporal window filters

Recall supports two time bounds parsed by `parseSince()`:
- `since` is the lower bound (inclusive), expressed as ISO date or relative duration from now.
- `until` is the upper bound (inclusive), expressed with the same subtraction semantics as `since` (`until: "7d"` means entries created at or before `now - 7 days`).
- Using both defines a bounded window (`since <= created_at <= until`).

If both bounds are present and `since > until`, recall throws an `Invalid date range` error instead of returning an empty list.

When `until` is present, decay-based scoring anchors to `effectiveNow = until` so the newest in-window entry is not over-penalized by global time decay. `freshnessBoost` still anchors to real query `now` because it is a live-query signal rather than a historical-window signal.

`recall_intervals` is a JSON array of epoch-second timestamps appended on each recall. `computeSpacingFactor()` uses the distribution of intervals between successive recalls to compute the spaced-repetition bonus: entries recalled at expanding intervals (spaced practice) score higher than entries recalled repeatedly in a short window.

The `freshnessBoost` applies a temporary multiplier to entries created very recently, reflecting the observation that newly learned information is highly relevant before it has had time to be tested by recall patterns.

`todoPenalty` applies only to `todo`-type entries and decays with a 7-day half-life. A todo that has not been marked done and has not been updated in weeks should surface less prominently than one created today.

See also: [Embeddings](#embeddings) for how the vector component is generated.

---

## Consolidation Architecture

Source: `src/commands/consolidate.ts`, `src/consolidate/rules.ts`, `src/consolidate/cluster.ts`, `src/consolidate/merge.ts`, `src/consolidate/verify.ts`

Consolidation is a two-tier offline pipeline. Tier 1 runs first and handles the common cases using cheap rule-based logic. Tier 2 runs on what remains after Tier 1 and handles semantically similar but not identical entries using LLM-assisted clustering and merging.

Locking: File lock at `~/.agenr/consolidation.lock` prevents concurrent consolidation runs from creating conflicting writes.

### Tier 1: Rules-based cleanup

- Applies forgetting/expiry to low-scoring temporary entries (see [Forgetting and Decay](#forgetting-and-decay) below).
- Merges near-exact duplicates with structural safeguards.
- Cleans orphaned non-`supersedes` relations.

### Tier 2: LLM-assisted clustering and merge

- Builds semantic clusters using union-find with diameter-capped validation. The diameter cap prevents large heterogeneous clusters where a chain of pairwise similarities spans semantically unrelated entries.
- Generates canonical entries via LLM tool-calling.
- Verifies merged semantics before commit. Entries where verification fails are flagged to the review queue rather than committed. The review queue is a holding state where uncertain merges are logged for human inspection; they are not deleted or applied until manually reviewed.

### Forgetting and Decay

Source: `src/consolidate/rules.ts`

Tier 1 expiry uses the same `recency()` function as recall scoring (see [Recall Scoring Model](#recall-scoring-model)). For `temporary`-expiry entries this is a 30-day half-life. An entry is deleted when:

```pseudocode
score = recency(ageDays, entry.expiry)   -- same formula as recall scoring recency term
if score < EXPIRE_THRESHOLD (0.05):
    expire entry
```

With a 30-day half-life, a `temporary` entry that has never been recalled falls below the 0.05 threshold after approximately 130 days. Recall activity resets the `last_recalled_at` timestamp and extends the effective life of the entry.

Only `temporary`-expiry entries are subject to expiry. `core` and `permanent` entries are never expired by this mechanism.

Protection rules (checked before expiry):
- Entries with `importance >= 10` are always protected regardless of recency.
- Entries whose `subject` matches any pattern in `forgetting.protect[]` are always protected. Patterns are matched case-insensitively; a trailing `*` acts as a prefix wildcard.

`forgettingScore()` is also defined in `rules.ts` (90-day half-life, recall bonus, importance floor) and is exported for display and audit use, but is not the function that drives the consolidation expiry decision.

Config keys: `forgetting.enabled`, `forgetting.scoreThreshold`, `forgetting.maxAgeDays`, `forgetting.protect[]`.

---

## Watch System and Daemon

Source: `src/watch/watcher.ts`, `src/commands/daemon.ts`, `src/watch/resolvers/`

The watch system is the primary continuous-ingestion mode in production deployments. Rather than requiring manual `ingest` commands after each session, the daemon monitors session transcript files and processes new content as it appears.

### Watcher

`runWatcher()` in `src/watch/watcher.ts` operates as follows:

- Detects file changes via filesystem events with debounce, plus a timed polling fallback for environments where FS events are unreliable.
- Reads files incrementally by byte offset. It does NOT re-parse the whole file on each cycle; it picks up from the last known `byteOffset`. This means large transcript files are processed efficiently even after hundreds of sessions.
- After each cycle, writes a health file to signal that the watcher is alive.
- Writes its PID to `~/.agenr/watcher.pid`.

Watch state is persisted at `~/.agenr/watch-state.json`. The state tracks per-file: `byteOffset`, `lastRunAt`, `totalEntriesStored`, `totalRunCount`.

Platform detection (`WatchPlatform`): `"openclaw" | "claude-code" | "codex" | "mtime"`. The platform is auto-detected from the watched directory path:
- `/.openclaw/` -> `openclaw`
- `/.claude/` -> `claude-code`
- `/.codex/` -> `codex`
- no match -> `mtime` (sort by modification time)

Per-platform session resolvers (`src/watch/resolvers/`) determine which file in a watched directory is the active session. Different platforms store their transcript files differently (naming conventions, directory layout), so each resolver implements platform-specific logic.

### Daemon

The daemon wraps the watcher as a macOS launchd service managed by `src/commands/daemon.ts`.

- Plist installed at: `~/Library/LaunchAgents/com.agenr.watch.plist`
- Logs written to: `~/.agenr/logs/`

Daemon CLI commands: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`

---

## Platform Adapter System

Source: `src/adapters/registry.ts`, `src/adapters/`

The adapter system normalizes heterogeneous input file formats into a uniform message list that the rest of the pipeline can process without knowing the source format.

### SourceAdapter interface

```typescript
interface SourceAdapter {
  name: string;
  canHandle(filePath: string, firstLine?: string): boolean;
  parse(filePath: string, options: AdapterParseOptions): Promise<ParseResult>;
}
```

`detectAdapter()` in `src/adapters/registry.ts` selects the appropriate adapter by file extension and, for `.jsonl` files, first-line sniffing to distinguish between openclaw, claude-code, and codex formats.

### Adapters

| Adapter | File types | Notes |
|---|---|---|
| `openclaw` | `.jsonl` | OpenClaw session transcripts |
| `claude-code` | `.jsonl` | Claude Code session transcripts |
| `codex` | `.jsonl` | Codex session transcripts |
| `plaud` | `.md` | Plaud voice memo transcripts |
| `text` | `.txt`, fallback | Plain text, no structure assumed |
| `cursor` | `.vscdb` | SQLite DB from Cursor IDE |
| `vscode-copilot` | `.vscdb` | SQLite DB from VS Code Copilot |

### ParseResult

```typescript
interface ParseResult {
  messages: Message[];
  warnings: string[];
  metadata: {
    sessionId?: string;
    platform?: string;
    model?: string;
    cwd?: string;
    sessionLabel?: string;
  };
}
```

### AdapterParseOptions

- `raw`: bypass noise filtering (include all messages regardless of content).
- `verbose`: emit detailed parsing diagnostics.

---

## Signal/Notification System

Source: `src/db/signals.ts`, `src/openclaw-plugin/index.ts`

The signal system delivers real-time notifications when high-importance entries are stored, so that the host agent (e.g., OpenClaw) can surface them to the user without waiting for the next session-start recall.

### Storage

`signal_watermarks` table: one row per consumer, tracking a `rowid`-based monotonic cursor. This is the simplest at-least-once delivery mechanism compatible with SQLite's rowid sequence.

### Delivery

`fetchNewSignalEntries()` queries entries where `importance >= N AND rowid > watermark AND retired = 0`, advances the watermark, and returns the results. New consumers are initialized at the current max rowid so they do not replay pre-existing high-importance entries.

At-least-once delivery: the watermark is advanced before results are returned. Transient failures after the watermark advance may cause re-delivery of the same entries on the next call.

Formatted output:
```
AGENR SIGNAL: N new high-importance entries
- [type, imp:X] subject
```

### Plugin-side signal config

| Key | Default | Description |
|---|---|---|
| `signalMinImportance` | 8 | Minimum importance to trigger a signal |
| `signalMaxPerSignal` | 3 | Max entries per signal batch |
| `signalCooldownMs` | 30000 | Per-session cooldown between signals |
| `signalMaxPerSession` | 10 | Max total signals per session |
| `signalMaxAgeSec` | 300 | Max age of entries to include in a signal |

---

## OpenClaw Plugin Architecture

Source: `src/openclaw-plugin/index.ts`, `openclaw.plugin.json`

See also: `docs/OPENCLAW.md` for end-user setup and configuration details.

The OpenClaw plugin integrates agenr into the OpenClaw agent framework at the host level, providing automatic memory injection and tool registration without requiring manual recall commands.

### Plugin manifest

`openclaw.plugin.json` declares:
- `id`: `"agenr"`
- `skills`: the four registered tools
- `configSchema`: plugin configuration keys

### Lifecycle

The plugin entry point (`src/openclaw-plugin/index.ts`) registers a `before_prompt_build` hook. This hook:

1. Fires once per session (LRU dedup, max 1000 sessions tracked). Sessions already seen in this process lifetime are skipped.
2. Skips subagent and cron sessions. Sessions whose label matches `:subagent:` or `:cron:` are excluded because injecting recall context into sub-processes would be redundant and wasteful.
3. Runs session-start recall: queries the DB for relevant entries, formats them as markdown, and truncates to the configured budget.
4. Fetches any pending signals from `fetchNewSignalEntries()`.
5. Combines the recall markdown and signal string as `prependContext` added to the agent prompt.

Errors from any step are swallowed. The plugin must never block or crash a prompt build, since that would prevent the agent from responding.

### Tools registered into OpenClaw

- `agenr_recall`: semantic search over the knowledge base.
- `agenr_store`: store a new entry directly (single entry, bypasses extraction).
- `agenr_extract`: extract and store knowledge from raw text using the LLM extractor.
- `agenr_retire`: soft-delete an entry by ID with an optional reason.

### Plugin config keys

| Key | Description |
|---|---|
| `agenrPath` | Path to the agenr installation |
| `dbPath` | Override for the DB path |
| `budget` | Token budget for session-start recall context |
| `enabled` | Enable/disable the plugin |
| `signalMinImportance` | Minimum importance for signals (default 8) |
| `signalMaxPerSignal` | Max entries per signal batch (default 3) |
| `signalCooldownMs` | Per-session signal cooldown in ms (default 30000) |
| `signalMaxPerSession` | Max signals per session (default 10) |
| `signalMaxAgeSec` | Max age of signal entries in seconds (default 300) |
| `signalsEnabled` | Enable/disable the signal subsystem |

---

## Retirement System

Source: `src/commands/retire.ts`, `src/db/retirements.ts`, `src/types.ts`

Retirement is the standard way to soft-delete an entry. Retired entries remain in the DB (for provenance) but are excluded from all recall, signal, and dedup queries via the `retired = 0` filter.

### CLI

`src/commands/retire.ts` implements an interactive CLI flow:
1. Fuzzy or exact subject match to find candidates.
2. Confirmation prompt before applying.
3. Optional reason prompt.
4. `--persist` flag to write the retirement to the ledger.

### Storage

`src/db/retirements.ts` sets `retired = 1`, `retired_at`, and `retired_reason` on matched entries.

`RetirementRecord` is defined in `src/types.ts`. The retirement ledger is stored at `~/.agenr/retirements.json`.

### Persistence and replay

With `--persist`, the retirement is written to the ledger in addition to the DB. On DB initialization, the ledger is replayed so that retirements survive DB rebuilds (e.g., after deleting and recreating the DB file). Without `--persist`, the retirement applies only to the current DB and is lost if the DB is rebuilt.

### MCP

The `agenr_retire` MCP tool accepts `entry_id` (required), `reason` (optional), and `persist` (optional, boolean). This allows AI assistants to retire entries on behalf of the user without requiring CLI access.

---

## MCP Server Architecture

Source: `src/mcp/server.ts`

Transport: stdio
Protocol: JSON-RPC 2.0, protocol version `2024-11-05`

The MCP server exposes four tools. Input validation is strict: enum values, numeric ranges, and required fields are checked before dispatch. Invalid calls return a structured error rather than throwing.

### Exposed tools

**`agenr_recall`**
Semantic search over the knowledge base. Accepts a query string, optional filters (type, scope, project, tags, since, until), and a result limit. Returns a ranked list of matching entries with their scores. Updating `recall_count` and `last_recalled_at` (and appending to `recall_intervals`) is performed as a side effect.

**`agenr_store`**
Stores a single structured entry directly, bypassing LLM extraction. Accepts the full entry fields (type, subject, content, importance, expiry, scope, tags, canonical_key, platform, project). Runs online dedup before writing. Useful when the caller has already structured the knowledge and does not need extraction.

**`agenr_extract`**
Accepts raw text and runs the full LLM extraction pipeline (`extractKnowledgeFromChunks`) followed by `storeEntries`. The caller does not need to pre-structure the input; the extractor identifies and structures knowledge entries from natural language.

**`agenr_retire`**
Soft-deletes an entry by `entry_id`. Accepts an optional `reason` string and an optional `persist` boolean. When `persist` is true, the retirement is written to the ledger at `~/.agenr/retirements.json` so it survives DB rebuilds.

### Lifecycle

- Lazy DB initialization (`getDb` + migrations) on first tool call.
- Per-call tool dispatch with structured text responses.
- No persistent state between calls; the server process may be long-lived but each call is independent.

---

## Auth and Model Resolution

Source: `src/config.ts`, `src/types.ts`, `src/llm/credentials.ts`, `src/llm/models.ts`, `src/llm/client.ts`

Supported auth methods (5):
- `anthropic-oauth`
- `anthropic-token`
- `anthropic-api-key`
- `openai-subscription`
- `openai-api-key`

Credential resolution (`src/llm/credentials.ts`) supports env/config credentials plus local CLI credential discovery:
- Codex: `~/.codex/auth.json` or keychain on macOS
- Claude: `~/.claude/.credentials.json` / `credentials.json` or keychain on macOS

Provider and model normalization: `src/llm/models.ts`, `src/llm/client.ts`
