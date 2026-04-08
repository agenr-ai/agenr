# agenr Architecture

This document describes the architecture implemented in the current repository as of April 2026. When code and docs disagree, the code wins.

## 1. System overview

agenr is a local-first memory system for agent runtimes. The codebase currently operates across five closely related capabilities:

1. durable knowledge storage in `entries`
2. episodic session summaries in `episodes`
3. query-time recall over both memory planes
4. live OpenClaw integration for prompt injection, continuity, and tools
5. maintenance workflows through surgeon

The database is the system of record. LLMs and embeddings are used to extract, summarize, rank, and repair memory, but durable state lives in SQLite or libSQL.

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
│   ├── db/
│   ├── files/
│   ├── api/
│   ├── openclaw/
│   ├── surgeon/
│   ├── embeddings.ts
│   └── llm.ts
├── cli/
│   ├── main.ts
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
└── mirrors the main feature areas above
```

Important points about the current tree:

- `src/core/` contains the main domain logic, ranking logic, claim-key lifecycle helpers, and pure interfaces in `src/core/ports.ts`.
- `src/app/` owns workflow orchestration such as multi-file ingest, unified recall routing, episode ingest staging, OpenClaw runtime composition, surgeon runs, recall eval execution, and the claim-key scenario harness.
- `src/adapters/` implements storage, external model clients, transcript parsing, the OpenClaw plugin, and the internal recall-eval HTTP seam.
- `src/adapters/openclaw/runtime.ts` and `src/adapters/surgeon/*` are mostly adapter-facing re-export surfaces over app-layer implementations.
- `packages/openclaw-plugin/` is a thin packaging wrapper that re-exports the built OpenClaw plugin entry from `dist/`.

## 3. Layering and actual boundaries

The intended dependency shape is:

`core -> app -> adapters -> cli/plugin`

That is mostly true in the current codebase.

### 3.1 Core

`src/core/` owns:

- canonical domain types in `src/core/types.ts`
- formal ports in `src/core/ports.ts`
- claim-key normalization and lifecycle derivation
- store-time validation, hashing, embedding text construction, and persistence preparation
- transcript extraction and ingest parsing logic
- entry recall ranking and temporal helpers
- episode search, transcript rendering, and summary prompt generation
- surgeon domain types and presets

Core is infrastructure-agnostic, but not fully deterministic. It depends on ports for LLM and embedding work where the product requires them.

### 3.2 App

`src/app/` coordinates multi-step workflows:

- ingesting many transcripts
- staging episode ingest into preflight, plan, and execute phases
- routing unified recall between entries and episodes
- composing shared OpenClaw runtime services
- running surgeon passes and presets
- serving recall-eval execution
- running claim-key scenarios inside sandboxes

### 3.3 Adapters

`src/adapters/` translates concrete systems into the core and app boundaries:

- `db/` is the primary persistence adapter and query engine
- `files/` discovers local transcript files
- `embeddings.ts` and `llm.ts` resolve external model providers
- `openclaw/` translates host hooks, session state, transcripts, and tools
- `api/` exposes the narrow internal recall-eval route

In practice, the database adapter is the operational center of the system. A large amount of real architecture is encoded in the schema, row mapping, and query helpers.

### 3.4 CLI and runtime surfaces

The current user-facing entry points are:

- CLI commands registered in `src/cli/main.ts`
- the OpenClaw memory plugin in `src/adapters/openclaw/index.ts`
- the internal recall-eval dev server entry point in `src/internal-recall-eval-server.ts`

The CLI currently registers:

- `agenr ingest`
- `agenr db`
- `agenr recall`
- `agenr scenarios`
- `agenr setup`
- `agenr init`
- `agenr surgeon`

There is still no broad public HTTP memory API. The only HTTP surface is the internal recall-eval route.

## 4. Main domain objects

### 4.1 Entries

Durable knowledge rows are modeled by `Entry` in `src/core/types.ts`.

Important characteristics:

- supported entry types: `fact`, `decision`, `preference`, `lesson`, `relationship`, `milestone`
- supported expiry levels: `core`, `permanent`, `temporary`
- lifecycle fields include retirement and supersession metadata
- temporal validity is modeled with `valid_from` and `valid_to`
- claim-key lifecycle metadata is first-class

Claim-key lifecycle is a major current architectural feature. It is implemented across:

- `src/core/claim-key.ts`
- `src/core/claim-key-lifecycle.ts`
- `src/core/claim-key-entity-family.ts`
- `src/core/claim-key-slot-resonance.ts`
- `src/core/supersession.ts`

The current claim-key lifecycle model includes:

- canonical `claim_key`
- preserved `claim_key_raw`
- status: `trusted`, `tentative`, `unresolved`
- source: `manual`, `model`, `json_retry`, `deterministic_repair`, and surgeon-originated sources
- support provenance fields for where the claim came from

### 4.2 Episodes

Episodic summaries are modeled by `Episode` in `src/core/types.ts`.

Important characteristics:

- supported sources: `openclaw`, `codex`, `cli`, `synthesis`
- episode identity is anchored by `(source, sourceId)` when available, with transcript-hash fallback
- episodes store summary text, tags, activity level, timing, optional embeddings, and lifecycle state
- episodic retrieval is separate from durable entry recall

### 4.3 Surgeon runs

Surgeon run metadata lives in:

- `surgeon_runs`
- `surgeon_run_actions`
- `surgeon_run_proposals`

This subsystem tracks:

- pass or preset execution
- token and cost accounting
- dry-run vs apply mode
- action audit trails
- unresolved structural proposals

## 5. Storage architecture

The storage adapter lives in `src/adapters/db/`.

### 5.1 Database model

The current schema version is `8`.

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

### 5.2 Search and indexing

Current storage and query behavior:

- entries use FTS5 via `entries_fts`
- only active entries participate in FTS
- entries and episodes both store embeddings as `F32_BLOB(1024)`
- vector indexes exist for entries and episodes when libSQL vector support is available
- the code tolerates missing vector support and degrades gracefully

### 5.3 Operational mechanics

`src/adapters/db/schema.ts` does more than schema creation. It also owns:

- migrations up to schema v8
- FTS trigger management
- vector index creation and probing
- interrupted bulk-write recovery
- metadata tracking in `_meta`

Bulk entry ingest has a real fast path:

- `prepareForBulkWrites()` drops or disables expensive indexes and triggers
- `finalizeBulkWrites()` rebuilds FTS and vector indexes and records completion metadata
- startup repairs interrupted bulk-write state when needed

That recovery behavior is part of the implemented architecture, not a side concern.

## 6. Main flows

## 6.1 Durable entry ingest

The durable ingest path spans:

- `src/app/ingestion/service.ts`
- `src/core/ingestion/*`
- `src/core/store/pipeline.ts`
- `src/adapters/files/transcript-files.ts`
- `src/adapters/openclaw/transcript/parser.ts`

High-level flow:

1. discover transcript files
2. skip unchanged files using `ingest_log`
3. parse transcripts through a `TranscriptPort`
4. extract candidate memories from transcript chunks
5. deduplicate candidates within the ingest batch
6. preserve explicit claim keys or derive lifecycle metadata
7. validate, hash, embed, and persist entries
8. optionally auto-link supersession for eligible claim-key cases
9. record ingest log rows

Important implementation details:

- chunking is message-boundary aware
- store-time dedup uses both exact and normalized hashes
- batch ingest can run claim extraction before persistence
- one-off store paths can also derive claim keys inside the store pipeline
- transactions are used when the adapter supports them

The store pipeline is not a thin insert helper. It is one of the core product workflows.

## 6.2 Entry recall

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

One repo-specific feature matters here: historical-state expansion. The adapter can bring inactive lineage-linked predecessors back into the result set when the query is about previous state.

## 6.3 Unified recall

The agent-facing router is `runUnifiedRecall()` in `src/app/recall/unified.ts`.

It can query:

- entries only
- episodes only
- both

Routing currently uses actual heuristics in code, including:

- factual vs narrative phrasing
- resolved temporal windows
- topic anchors
- historical-state patterns such as "what changed" or "what was the previous approach"

The router also emits notices about behavior, including episode freshness and entry-only filter handling.

## 6.4 Episode ingest

Episode ingest is explicitly staged in:

- `src/app/episode-ingest/service/preflight.ts`
- `src/app/episode-ingest/service/plan.ts`
- `src/app/episode-ingest/service/execute.ts`

Stage 1 preflight:

- discovers transcript files
- parses and cleans them
- resolves session metadata from the OpenClaw session registry when available
- skips already-ingested sessions unless regenerating
- skips short transcripts with fewer than `MIN_EPISODE_MESSAGES`
- skips transcripts that still appear active
- renders and caps transcript content for summarization

Stage 2 planning:

- filters candidates
- estimates tokens and cost
- prepares the execution set

Stage 3 execution:

- generates structured summaries with an LLM
- optionally embeds the summary
- serializes DB writes while allowing concurrent model work
- upserts based on source identity and summary change detection

Episode ingest is therefore a planned batch workflow, not just a transcript-to-summary helper.

## 6.5 Episode recall

Episode search lives in:

- `src/core/episode/search.ts`
- `src/core/episode/scoring.ts`
- `src/core/episode/temporal-window.ts`

Current behavior:

- temporal-only retrieval
- semantic-only retrieval
- hybrid temporal plus semantic retrieval

Compared with entry recall, episode recall is more time-oriented. It parses richer date and calendar expressions and scores temporal overlap or proximity ahead of weak recency tie-breakers.

Episodes do not currently use FTS. Retrieval is time-window and vector based.

## 6.6 OpenClaw runtime

The OpenClaw integration spans:

- `src/adapters/openclaw/index.ts`
- `src/adapters/openclaw/hooks/*`
- `src/adapters/openclaw/session/*`
- `src/adapters/openclaw/transcript/*`
- `src/adapters/openclaw/format/*`
- `src/adapters/openclaw/memory/*`
- `src/adapters/openclaw/episode/*`
- `src/app/openclaw/runtime.ts`

The plugin is not just tool exposure. It implements live session behavior.

Current registration includes:

- prompt-section injection
- memory runtime status
- memory flush-plan registration
- hooks for `before_prompt_build`, `session_start`, `after_tool_call`, `session_end`, and `gateway_stop`
- tools `agenr_store`, `agenr_recall`, `agenr_retire`, `agenr_update`, and `agenr_trace`

Implemented behaviors include:

- session-start injection of up to four active `core` entries
- predecessor resolution through `resumedFrom` and `sessions.json` fallbacks
- continuity summary read or on-demand generation
- recent-session transcript rendering
- best-effort background predecessor episode writing
- mid-session memory-action tracking and store nudges
- transcript normalization shared by both entry and episode ingest

The transcript parser in `src/adapters/openclaw/transcript/parser.ts` is a major seam. It removes host noise, summarizes or drops noisy tool results, strips metadata blocks, reconstructs surface hints, and produces the cleaned message stream used downstream.

### 6.7 Surgeon

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

Runtime safeguards currently include:

- dry-run by default
- per-run and daily cost caps
- entry protection thresholds
- optional recall simulation when embeddings are configured
- completion guards
- pre-apply database backups when possible

This is closer to a maintenance platform than a single cleanup script.

## 6.8 Claim-key scenario harness

The repo now includes a dedicated scenario runtime under `src/app/scenarios/claim-keys/` with CLI support in `agenr scenarios`.

This harness:

- loads fixture-backed scenarios from `tests/scenarios/claim-keys/`
- creates isolated sandboxes
- runs ingest, store, or surgeon paths
- captures resulting rows, proposals, and summaries
- emits per-scenario artifacts for debugging regressions

That makes scenarios part of the architecture, not just incidental test data.

## 6.9 Internal recall-eval seam

The eval seam is intentionally narrow:

- route implementation: `src/adapters/api/routes/internal-recall-eval.ts`
- local HTTP server: `src/adapters/api/internal-recall-eval-server.ts`
- executable entry point: `src/internal-recall-eval-server.ts`
- app execution: `src/app/evals/recall/*`

This exists to serve `agenr-evals`. It is not a general memory-management API.

## 7. Extension seams

The main formal seams are the ports in `src/core/ports.ts`:

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

- `src/config.ts` supports stage-specific model resolution
- OpenClaw-hosted claim extraction uses host auth and plugin config overrides
- CLI and plugin flows resolve credentials differently even when they share core logic

## 8. Complexity hotspots

The parts of the architecture with the most real complexity are:

### 8.1 Claim-key lifecycle

This cuts across ingest, direct updates, recall, supersession, and surgeon. If you want to understand why memory rows are trusted, tentative, linked, or superseded, start here.

### 8.2 Database schema and queries

`src/adapters/db/schema.ts`, `row-mapping.ts`, `queries.ts`, `recall-adapter.ts`, and the feature-specific query files encode a lot of the actual system behavior.

### 8.3 OpenClaw continuity

The `before_prompt_build` path combines session tracking, predecessor lookup, summary generation, prompt injection, transcript rendering, store nudges, and background episode work.

### 8.4 Dual recall engines plus router

There are separate entry and episode recall systems, with a unified router on top and historical-state expansion beneath the entry side.

### 8.5 Surgeon

Surgeon mixes deterministic structural maintenance, agentic tool loops, persistence, budgets, and safety controls.

## 9. Suggested reading order

If you need to build context quickly, start with:

- `src/core/types.ts`
- `src/core/ports.ts`
- `src/adapters/db/schema.ts`
- `src/core/store/pipeline.ts`
- `src/core/claim-key-lifecycle.ts`
- `src/app/recall/unified.ts`
- `src/app/episode-ingest/service.ts`
- `src/app/openclaw/runtime.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- `src/app/surgeon/service.ts`
- `src/app/scenarios/claim-keys/runtime.ts`

Those files reflect the implemented architecture more accurately than older planning docs.
