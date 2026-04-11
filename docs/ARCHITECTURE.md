# agenr Architecture

This document describes the architecture that is implemented in the repository today. When this document and the code disagree, the code wins.

## 1. System overview

agenr is a local-first memory system for agent runtimes. The current codebase centers on six connected capabilities:

1. durable knowledge storage in `entries`
2. episodic session summaries in `episodes`
3. hybrid entry recall plus time-aware episode recall
4. a unified recall router for agent-facing host integrations
5. live OpenClaw integration for prompt injection, continuity, and memory tools
6. maintenance and repair workflows through surgeon

SQLite or libSQL is the system of record. LLMs and embeddings support extraction, summarization, ranking, and repair, but durable state lives in the database.

## 2. Repository shape

The current repository is organized like this:

```text
src/
├── core/
│   ├── types.ts
│   ├── ports.ts
│   ├── claim-key*.ts
│   ├── supersession.ts
│   ├── store/
│   ├── ingestion/
│   ├── recall/
│   ├── episode/
│   └── surgeon/
├── app/
│   ├── ingestion/
│   ├── episode-ingest/
│   ├── recall/
│   ├── openclaw/
│   ├── surgeon/
│   ├── evals/recall/
│   └── scenarios/claim-keys/
├── adapters/
│   ├── api/
│   ├── config/
│   ├── db/
│   ├── files/
│   ├── openclaw/
│   ├── surgeon/
│   ├── embeddings.ts
│   └── llm.ts
├── cli/
│   ├── main.ts
│   ├── shared/
│   ├── ui.ts
│   └── commands/
├── config.ts
├── cli.ts
├── internal-recall-eval-server.ts
├── logger.ts
├── ui.ts
└── version.ts

packages/
└── openclaw-plugin/

tests/
└── mirrors the major feature areas above
```

Important points about the current tree:

- `src/core/` contains the main domain model, claim-key lifecycle logic, entry recall, episode search, ingest parsing, and pure port interfaces.
- `src/app/` owns orchestration for durable ingest, episode ingest, unified recall, surgeon execution, OpenClaw runtime composition, the narrow recall-eval seam, and the repo-local claim-key scenario harness.
- `src/adapters/` implements libSQL persistence, transcript discovery, config parsing, external model clients, OpenClaw host translation, and the internal HTTP adapter.
- `src/config.ts`, `src/logger.ts`, `src/ui.ts`, and `src/version.ts` are shared runtime infrastructure, not domain logic.
- `packages/openclaw-plugin/` is a packaging wrapper that re-exports the built plugin entry from `dist/`.

## 3. Layering and dependency boundaries

The implemented dependency direction is still:

`core -> app -> adapters -> cli/plugin`

That shape is materially true in the current codebase.

### 3.1 Core

`src/core/` owns:

- canonical domain types in `src/core/types.ts`
- formal ports in `src/core/ports.ts`
- claim-key normalization, lifecycle, family, and slot-resonance helpers
- store-time validation, hashing, claim extraction support, and embedding text construction
- transcript extraction, chunking, parsing, dedup, and claim-key preservation logic
- hybrid entry recall ranking and temporal helpers
- episode search, temporal window parsing, transcript rendering, and summary generation helpers
- surgeon domain types, pass types, protection rules, and run presets

Core is infrastructure-agnostic. It still depends on ports for embeddings, LLM calls, transcript parsing, and persistence where the product requires those capabilities.

### 3.2 App

`src/app/` coordinates multi-step workflows:

- durable transcript ingest over discovered file sets
- episode ingest preflight, planning, execution, and embedding backfill
- unified routing between entry and episode recall
- shared OpenClaw runtime service composition
- surgeon run execution, budgets, prompts, progress, and completion guards
- internal recall-eval execution
- deterministic claim-key scenario runtimes and sandboxing

### 3.3 Adapters

`src/adapters/` translates external systems into the core and app boundaries:

- `db/` is the main persistence adapter and query layer
- `config/` owns adapter-boundary config parsing, validation, canonicalization, and resolved-default shaping
- `files/` discovers transcript files from the local filesystem
- `embeddings.ts` and `llm.ts` resolve external model providers for the CLI and generic runtimes
- `openclaw/` translates host hooks, session state, transcript parsing, formatting, memory runtime hooks, and agent tools
- `api/` exposes the single internal recall-eval HTTP route
- `surgeon/` contains adapter-facing prompt and tool surfaces that sit on top of app-layer surgeon logic

In practice, the database adapter remains an architectural center of gravity. A large amount of system behavior is encoded in schema management, row mapping, and query helpers.

## 4. Runtime entry points

The current user-facing or host-facing entry points are:

- CLI registration in `src/cli/main.ts`
- the OpenClaw memory plugin in `src/adapters/openclaw/index.ts`
- the internal recall-eval dev server in `src/internal-recall-eval-server.ts`

The CLI currently exposes:

- `agenr init`
- `agenr setup`
- `agenr ingest entries <path>` with `agenr ingest <path>` as the default durable-ingest form
- `agenr ingest episodes [path]`
- `agenr recall <query>`
- `agenr surgeon run|status|history|actions|proposals`
- `agenr trace`
- `agenr scenarios list|run`
- `agenr db reset`

There are still no standalone CLI commands for `store`, `retire`, or `update`. Those remain OpenClaw tool surfaces rather than first-class CLI commands.

## 5. Domain model

### 5.1 Entries

Durable knowledge rows are modeled by `Entry` in `src/core/types.ts`.

Current entry characteristics:

- supported entry types: `fact`, `decision`, `preference`, `lesson`, `relationship`, `milestone`
- supported expiry levels: `core`, `permanent`, `temporary`
- lifecycle fields for retirement and explicit supersession
- temporal validity via `valid_from` and `valid_to`
- first-class claim-key lifecycle metadata

Claim-key lifecycle is a major current architectural feature. It is implemented across:

- `src/core/claim-key.ts`
- `src/core/claim-key-lifecycle.ts`
- `src/core/claim-key-entity-family.ts`
- `src/core/claim-key-slot-resonance.ts`
- `src/core/claim-key-support.ts`
- `src/core/supersession.ts`

The implemented claim-key model includes:

- canonical `claim_key`
- preserved `claim_key_raw`
- status: `trusted`, `tentative`, `unresolved`
- source: `manual`, `model`, `json_retry`, `deterministic_repair`, `surgeon_metadata_rewrite`, `surgeon_family_reuse`, `surgeon_compaction`
- support provenance fields for where the claim came from and how it was inferred

### 5.2 Episodes

Episodic summaries are modeled by `Episode` in `src/core/types.ts`.

Current episode characteristics:

- supported sources: `openclaw`, `codex`, `cli`, `synthesis`
- activity levels: `substantial`, `minimal`, `none`
- stable identity prefers `(source, sourceId)` and falls back to `(source, transcriptHash)`
- episodes store summary text, tags, activity level, timing, optional embeddings, and lifecycle state
- episodic retrieval is distinct from durable entry recall

### 5.3 Surgeon runs and proposals

Surgeon state is persisted in:

- `surgeon_runs`
- `surgeon_run_actions`
- `surgeon_run_proposals`

This subsystem records:

- pass or preset execution
- token and cost accounting
- dry-run versus apply mode
- action audit trails
- unresolved structural proposals for later inspection

## 6. Storage architecture

The storage adapter lives in `src/adapters/db/`.

### 6.1 Database adapter shape

`createDatabase()` in `src/adapters/db/client.ts` returns a single libSQL-backed adapter that implements both `DatabasePort` and `EpisodeDatabasePort`, plus transaction and raw SQL helpers used by other adapters.

The adapter is responsible for:

- schema initialization
- durable entry CRUD and ingest log writes
- episode upsert and embedding backfill writes
- recall queries
- surgeon persistence and reporting support
- transaction-scoped execution where the backend supports it

### 6.2 Schema

The current logical schema version is `8`.

Key tables:

- `entries`
- `entries_fts`
- `episodes`
- `ingest_log`
- `recall_events`
- `surgeon_runs`
- `surgeon_run_actions`
- `surgeon_run_proposals`
- `_meta`

The `entries` table now carries claim-key lifecycle fields, validity windows, supersession metadata, quality and recall tracking, project and user scoping, and retirement state. The `episodes` table carries source identity, transcript and summary hashes, timing, summary metadata, embeddings, and lifecycle state.

### 6.3 Search and indexing

Current indexing behavior:

- active entries participate in FTS5 through `entries_fts`
- retired or superseded entries are excluded from active FTS triggers
- entries and episodes both store embeddings as `F32_BLOB(1024)`
- libSQL vector indexes are created for entries and episodes when vector support is available
- the code tolerates missing vector support and degrades gracefully

Episodes do not currently use FTS. Episode retrieval is time-window and vector based.

### 6.4 Bulk-write mechanics

`src/adapters/db/schema.ts` owns more than table creation. It also manages:

- migrations up to schema version `8`
- FTS trigger creation and rebuilds
- vector index creation and feature probing
- interrupted bulk-write recovery via `_meta`
- bulk ingest state tracking and completion metadata

Bulk durable ingest uses a real fast path:

- `prepareForBulkWrites()` disables or drops expensive triggers and indexes
- `finalizeBulkWrites()` rebuilds them and records completion state
- startup repairs interrupted bulk-write state when needed

That behavior is part of the implemented architecture, not just an optimization detail.

## 7. Main workflows

### 7.1 Durable entry ingest

The durable ingest path spans:

- `src/app/ingestion/service.ts`
- `src/core/ingestion/*`
- `src/core/store/*`
- `src/adapters/files/transcript-files.ts`
- `src/adapters/openclaw/transcript/parser.ts`

High-level flow:

1. discover transcript files
2. skip unchanged files using `ingest_log`
3. parse transcripts through a `TranscriptPort`
4. extract candidate entries from message-aware transcript chunks
5. deduplicate candidates within the ingest batch
6. preserve explicit claim keys or derive lifecycle metadata
7. validate, hash, embed, and persist entries
8. optionally auto-link supersession for eligible claim-key cases
9. record ingest-log rows

Important implementation details:

- whole-file extraction is configurable in the CLI
- batch ingest has configurable concurrency
- generic entry discovery accepts `*.jsonl` plus rotated `.jsonl.reset.*` and `.jsonl.deleted.*` variants, but rejects lookalikes such as `.jsonl.bak`
- chunking stays aware of transcript message boundaries
- store-time dedup uses both exact and normalized hashes
- claim extraction can run before persistence and can preserve trusted explicit keys
- the database fast path is used for large bulk writes

The store pipeline is not a thin insert helper. It is one of the core product workflows.

### 7.2 Entry recall

The entry recall engine is implemented across:

- `src/core/recall/search.ts`
- `src/core/recall/scoring.ts`
- `src/core/recall/lexical.ts`
- `src/core/recall/temporal.ts`
- `src/adapters/db/recall-adapter.ts`

Current behavior:

- hybrid semantic plus lexical retrieval
- lexical tiers for exact phrase, all-token, and any-token matches
- relevance combined with recency and importance
- optional temporal biasing through `since`, `until`, `around`, and `aroundRadius`
- best-effort recall telemetry writes to `recall_events`

One repo-specific feature matters here: historical-state expansion. The adapter can reintroduce inactive lineage-linked predecessors when the query appears to ask about an earlier or previous state.

### 7.3 Unified recall

The agent-facing router is `runUnifiedRecall()` in `src/app/recall/unified.ts`.

It can query:

- entries only
- episodes only
- both

Routing uses actual heuristics in code, including:

- factual versus narrative phrasing
- resolved temporal windows
- topic anchors
- historical-state patterns such as "what changed" or "what did we use before"

The router also emits user-facing notices about entry-only filters, episode freshness, and semantic episode fallback behavior.

### 7.4 Episode ingest

Episode ingest is explicitly staged in:

- `src/app/episode-ingest/service/preflight.ts`
- `src/app/episode-ingest/service/plan.ts`
- `src/app/episode-ingest/service/execute.ts`
- `src/app/episode-ingest/service/backfill.ts`

Stage 1 preflight:

- discovers transcript files
- parses and cleans them
- resolves session metadata from the OpenClaw session registry when available, with best-effort fallback when `sessions.json` is missing or malformed
- skips already-ingested sessions unless regenerating
- skips short or still-active sessions
- renders transcript text for summarization

Stage 2 planning:

- filters preflight candidates
- applies recency filters such as `--recent`
- estimates tokens and cost
- prepares the execution set

Stage 3 execution:

- generates structured summaries with an LLM
- optionally embeds the summary
- serializes database writes while allowing concurrent model work
- upserts based on source identity and summary change detection

There is also a dedicated embedding-only backfill path for episodes that are missing vectors.

### 7.5 Episode recall

Episode search lives in:

- `src/core/episode/search.ts`
- `src/core/episode/scoring.ts`
- `src/core/episode/temporal-window.ts`

Current behavior:

- temporal-only retrieval
- semantic-only retrieval
- hybrid temporal plus semantic retrieval

Compared with entry recall, episode recall is more time-oriented. It parses richer date and calendar expressions and scores temporal overlap or proximity ahead of weak recency tie-breakers.

### 7.6 OpenClaw runtime

The OpenClaw integration spans:

- `src/adapters/openclaw/index.ts`
- `src/adapters/openclaw/hooks/*`
- `src/adapters/openclaw/session/*`
- `src/adapters/openclaw/transcript/*`
- `src/adapters/openclaw/format/*`
- `src/adapters/openclaw/memory/*`
- `src/adapters/openclaw/episode/*`
- `src/adapters/openclaw/llm/*`
- `src/app/openclaw/runtime.ts`

The plugin is not just tool exposure. It implements live session behavior.

Current plugin registration includes:

- memory prompt-section injection
- memory flush-plan registration
- memory runtime registration
- hooks for `before_prompt_build`, `session_start`, `after_tool_call`, `session_end`, and `gateway_stop`
- tools `agenr_store`, `agenr_recall`, `agenr_retire`, `agenr_update`, and `agenr_trace`

Implemented behaviors include:

- process-lifetime shared service composition in `src/app/openclaw/runtime.ts`
- session-start injection of active `core` entries
- predecessor resolution through `resumedFrom` and `sessions.json` fallbacks
- continuity summary reads and on-demand generation
- recent-session transcript rendering
- background predecessor episode writing
- mid-session memory-action tracking and store nudges
- transcript normalization shared by durable ingest and episode ingest

The transcript parser in `src/adapters/openclaw/transcript/parser.ts` is a major seam. It removes host noise, normalizes metadata, summarizes or drops noisy tool results, and produces the cleaned message stream that downstream ingest and episode workflows consume.

### 7.7 Surgeon

The surgeon subsystem spans:

- `src/app/surgeon/*`
- `src/core/surgeon/*`
- `src/adapters/db/surgeon-port.ts`
- `src/adapters/db/surgeon-run-log.ts`
- `src/adapters/db/surgeon-queries.ts`

Implemented passes:

- `claim_key_quality`
- `supersession`
- `retirement`

Implemented presets:

- `claim-key-only`
- `structural`
- `full`

The execution model is mixed:

- `claim_key_quality` is deterministic app logic
- `supersession` and `retirement` run through `pi-agent-core` loops with tool sets

Runtime safeguards include:

- dry-run by default
- per-run and daily cost caps
- context-limit controls
- entry protection thresholds
- optional recall simulation when embeddings are configured
- completion guards
- pre-apply database backups when possible

This is closer to a maintenance platform than a single cleanup script.

### 7.8 Claim-key scenario harness

The repo includes a dedicated scenario runtime under `src/app/scenarios/claim-keys/` with CLI support in `agenr scenarios`.

This harness:

- loads fixture-backed scenarios from `tests/scenarios/claim-keys/`
- validates scenario roots, typed inputs, and expectation blocks before execution
- loads transcript, extraction, claim-extraction, and seed fixtures through dedicated fixture-loader helpers
- creates isolated sandboxes
- runs ingest, store, or surgeon paths
- captures resulting rows, proposals, warnings, and summaries
- writes artifacts under `.hermes/scenario-artifacts/<runId>/`

That makes scenario execution part of the architecture, not just incidental test data.

### 7.9 Internal recall-eval seam

The eval seam is intentionally narrow:

- route implementation: `src/adapters/api/routes/internal-recall-eval.ts`
- local HTTP server: `src/adapters/api/internal-recall-eval-server.ts`
- executable entry point: `src/internal-recall-eval-server.ts`
- app execution: `src/app/evals/recall/*`

The only HTTP route is:

- `POST /internal/evals/recall/run`

This exists to serve local `agenr-evals` runs. It is not a general memory-management API.

## 8. Formal extension seams

The main formal seams are still the ports in `src/core/ports.ts`:

- `DatabasePort`
- `EpisodeDatabasePort`
- `EmbeddingPort`
- `RecallPorts`
- `LlmPort`
- `TranscriptPort`

Feature-scoped seams also matter:

- `OpenClawRepository` in `src/app/openclaw/ports.ts`
- surgeon runtime and persistence ports in `src/app/surgeon/ports.ts`
- episode-ingest support ports in `src/app/episode-ingest/ports.ts`

Configuration is another important seam:

- `src/adapters/config/parse-agenr-config.ts` and `src/adapters/config/types.ts` own adapter-side config validation, canonical persisted shape, auth/provider checks, and resolved runtime defaults
- `src/config.ts` handles config file IO, path resolution, credentials, and stage-specific model settings on top of that parser
- OpenClaw-hosted claim extraction uses host auth and plugin config overrides
- CLI and plugin flows can share core logic while resolving credentials differently

## 9. Complexity hotspots

The parts of the architecture with the most real complexity are:

### 9.1 Claim-key lifecycle

This cuts across ingest, direct updates, recall, supersession, surgeon, and scenario coverage. If you want to understand why an entry is trusted, tentative, linked, or superseded, start here.

### 9.2 Database schema and query layer

`src/adapters/db/schema.ts`, `row-mapping.ts`, `queries.ts`, `episode-queries.ts`, and `recall-adapter.ts` encode a large amount of actual system behavior.

### 9.3 OpenClaw continuity

The `before_prompt_build` path combines session tracking, predecessor lookup, continuity summaries, prompt injection, transcript rendering, and background episode work.

### 9.4 Dual recall systems plus router

There are separate entry and episode recall engines, with a unified router on top and historical-state expansion beneath the entry side.

### 9.5 Surgeon

Surgeon mixes deterministic structural maintenance, agentic tool loops, persistence, budgets, and safety controls.

## 10. Suggested reading order

If you need to build context quickly, start with:

- `src/core/types.ts`
- `src/core/ports.ts`
- `src/adapters/db/client.ts`
- `src/adapters/db/schema.ts`
- `src/core/store/pipeline.ts`
- `src/core/claim-key-lifecycle.ts`
- `src/core/recall/search.ts`
- `src/app/recall/unified.ts`
- `src/app/episode-ingest/service.ts`
- `src/app/openclaw/runtime.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- `src/app/surgeon/service.ts`
- `src/app/scenarios/claim-keys/runtime.ts`

Those files reflect the implemented architecture more accurately than older planning documents.
