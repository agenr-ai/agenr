# agenr Architecture

This document describes the architecture that is implemented in the repository today. When this document and the code disagree, the code wins.

## 1. System overview

agenr is a local-first memory system for agent runtimes. The current codebase centers on seven connected capabilities:

1. durable knowledge storage in `durables`
2. episodic session summaries in `episodes`
3. repo-authored procedural memory synced into `procedures`
4. hybrid durable recall plus time-aware episode recall
5. a unified recall router for agent-facing host integrations
6. live OpenClaw and Skeln host integrations for prompt injection, continuity or working memory, and memory tools
7. maintenance and repair workflows through dreaming

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
│   ├── procedures/
│   ├── recall/
│   ├── episode/
│   └── dreaming/
├── app/
│   ├── ingestion/
│   ├── episode-ingest/
│   ├── procedures/
│   ├── recall/
│   ├── session-start/
│   ├── before-turn/
│   ├── plugin-runtime/
│   ├── openclaw/
│   ├── skeln/
│   ├── dreaming/
│   ├── evals/recall/
│   └── scenarios/claim-keys/
├── adapters/
│   ├── api/
│   ├── config/
│   ├── db/
│   ├── files/
│   ├── openclaw/
│   ├── skeln/
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

procedures/

tests/
└── mirrors the major feature areas above
```

Important points about the current tree:

- `src/core/` contains the main domain model, claim-key lifecycle logic, procedure normalization and hashing, durable recall, episode search, ingest parsing, and pure port interfaces.
- `src/app/` owns orchestration for durable ingest, episode ingest, procedure sync, unified recall, session-start patch selection, dreaming execution, shared host plugin memory composition (`plugin-runtime/`), OpenClaw and Skeln runtime composition, the narrow recall-eval seam, and the repo-local claim-key scenario harness.
- `src/adapters/` implements libSQL persistence, transcript and procedure-file discovery, config parsing, external model clients, OpenClaw host translation, and the internal HTTP adapter.
- `src/config.ts`, `src/logger.ts`, `src/ui.ts`, and `src/version.ts` are shared runtime infrastructure, not domain logic.
- `packages/openclaw-plugin/` owns the publishable OpenClaw plugin bundle and its OpenClaw SDK runtime dependency. The root `agenr` package does not publish the OpenClaw plugin entry.
- `procedures/` holds the repo-authored procedural-memory corpus that is synced into the database.

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
- procedure validation, normalization, deterministic recall-text generation, and revision hashing
- hybrid durable recall ranking and temporal helpers
- episode search, temporal window parsing, transcript rendering, and summary generation helpers
- dreaming domain types, run tiers, reconcile summaries, and proposal types

Core is infrastructure-agnostic. It still depends on ports for embeddings, LLM calls, transcript parsing, and persistence where the product requires those capabilities.

### 3.2 App

`src/app/` coordinates multi-step workflows:

- durable transcript ingest over discovered file sets
- episode ingest preflight, planning, execution, and embedding backfill
- repo-authored procedure discovery, planning, and sync execution
- unified routing between entry and episode recall
- host-neutral session-start patch selection from predecessor artifacts plus durable memory
- shared OpenClaw runtime service composition
- dreaming run execution, scan/reconcile/apply orchestration, and progress reporting
- internal recall-eval execution
- deterministic claim-key scenario runtimes and sandboxing

### 3.3 Adapters

`src/adapters/` translates external systems into the core and app boundaries:

- `db/` is the main persistence adapter and query layer
- `config/` owns adapter-boundary config parsing, validation, canonicalization, and resolved-default shaping
- `files/` discovers transcript files and procedure YAML files from the local filesystem
- `embeddings.ts` and `llm.ts` resolve external model providers for the CLI and generic runtimes
- `openclaw/` translates host hooks, session state, transcript parsing, formatting, memory runtime hooks, and agent tools
- `api/` exposes the single internal recall-eval HTTP route
  In practice, the database adapter remains an architectural center of gravity. A large amount of system behavior is encoded in schema management, row mapping, and query helpers.

## 4. Runtime entry points

The current user-facing or host-facing entry points are:

- CLI registration in `src/cli/main.ts`
- the OpenClaw memory plugin in `src/adapters/openclaw/index.ts`
- the Skeln memory extension in `src/adapters/skeln/index.ts`
- the internal recall-eval dev server in `src/internal-recall-eval-server.ts`

The CLI currently exposes:

- `agenr init`
- `agenr setup`
- `agenr ingest durables <path>` with `agenr ingest <path>` as the default durable-ingest form
- `agenr ingest episodes [path]`
- `agenr ingest procedures [path]`
- `agenr recall <query>`
- `agenr dream run|status|history`
- `agenr trace`
- `agenr scenarios list|run`
- `agenr db reset`

There are still no standalone CLI commands for `store` or `update`. Those remain host-plugin tool surfaces rather than first-class CLI commands.

The OpenClaw adapter also exposes a deliberately narrow `memoryPolicy.slotPolicies.attributeHeads` config seam so claim-aware read behavior can override slot-policy classes without turning the plugin config into a broad platform API.

## 5. Domain model

### 5.1 Durable memory

Durable knowledge rows are modeled by `Durable` in `src/core/types.ts`.

Current durable characteristics:

- supported durable types: `fact`, `decision`, `preference`, `lesson`, `relationship`, `milestone`, `directive`
- supported expiry levels: `core`, `permanent`, `temporary`
- lifecycle fields for valid-time staleness and explicit supersession
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
- source: `manual`, `model`, `json_retry`, `deterministic_repair`, `dreaming_reconcile`
- support provenance fields for where the claim came from and how it was inferred

### 5.2 Episodes

Episodic summaries are modeled by `Episode` in `src/core/types.ts`.

Current episode characteristics:

- supported sources: `openclaw`, `codex`, `cli`, `synthesis`
- activity levels: `substantial`, `minimal`, `none`
- stable identity prefers `(source, sourceId)` and falls back to `(source, transcriptHash)`
- episodes store summary text, tags, activity level, timing, optional embeddings, and lifecycle state
- episodic retrieval is distinct from durable durable recall

### 5.3 Procedures

Procedural-memory revisions are modeled by `Procedure` in `src/core/types.ts`.

Current procedure characteristics:

- repo-authored YAML is the source of truth and normalized JSON is the stored runtime form
- procedures live in their own `procedures` table and are not another `DurableKind`
- current write behavior supports create, source-only update, semantic supersession, unchanged, and invalid planning outcomes
- procedures store deterministic `recall_text`, `revision_hash`, `source_hash`, optional embeddings, and lifecycle state
- the current public sync surface is `agenr ingest procedures [path]`
- dedicated procedure recall runs through `src/app/procedures/recall/`
- unified recall can route procedural asks into procedures and return a canonical procedure with supporting entries and episodes

### 5.4 Dreaming runs and proposals

Dreaming state is persisted in:

- `dream_runs`
- `dream_run_actions`
- `dream_proposals`
- `dream_state`
- `profile_snapshots`

This subsystem records:

- tiered run execution
- dry-run versus apply mode
- action audit trails
- unresolved structural proposals for later inspection
- active profile snapshot pointers and accumulated unsynthesized importance

## 6. Storage architecture

The storage adapter lives in `src/adapters/db/`.

### 6.1 Database adapter shape

`createDatabase()` in `src/adapters/db/client.ts` returns a single libSQL-backed adapter that implements `DatabasePort`, `EpisodeDatabasePort`, and `ProcedureDatabasePort`, plus transaction and raw SQL helpers used by other adapters.

The adapter is responsible for:

- schema initialization
- durable CRUD and ingest log writes
- episode upsert and embedding backfill writes
- procedure upsert, active-key lookup, lexical/vector lookup, embedding backfill, and lifecycle writes
- working-memory and session-memory repository writes for host adapters
- recall queries
- dreaming persistence and reporting support
- transaction-scoped execution where the backend supports it

### 6.2 Schema

The current database is greenfield-only. Create a fresh database with `agenr db reset` when upgrading. Startup rejects legacy tables and columns, and rejects partially initialized databases unless every required table is already present.

Key tables:

- `durables`
- `durables_fts`
- `episodes`
- `procedures`
- `procedures_fts`
- `ingest_log`
- `recall_events`
- `dream_runs`
- `dream_run_actions`
- `dream_proposals`
- `dream_state`
- `profile_snapshots`
- `working_sets`
- `working_events`
- `session_lineage_edges`
- `session_artifacts`
- `_meta`

The `durables` table carries claim-key lifecycle fields, validity windows, supersession metadata, quality and recall tracking, and project and user scoping. A row goes offline either by supersession (`superseded_by`) or by a closed valid-time window (`valid_to`); there is no separate retirement flag. The `episodes` table carries source identity, transcript and summary hashes, timing, summary metadata, embeddings, and lifecycle state. The `procedures` table carries canonical normalized body JSON, deterministic recall text, authored-source and revision hashes, optional embeddings, and lifecycle state. The working-memory tables store scoped active-task snapshots, ordered working events, checkpoint mirrors, budget counters, continuation policy, and host runtime lease metadata. The session-memory tables store host-neutral lineage edges and bounded session artifacts such as continuity summaries, recent-session tails, compaction checkpoints, branch-abandonment summaries, and episode pointers.

### 6.3 Search and indexing

Current indexing behavior:

- active durables participate in FTS5 through `durables_fts`
- active procedures participate in FTS5 through `procedures_fts`
- superseded durables are excluded from the FTS triggers; stale durables (a closed `valid_to`) stay indexed and are filtered out at query time by the live-clock active gate, because a time-based predicate cannot live in a SQLite trigger or partial index
- superseded procedures are excluded from the FTS triggers; stale procedures are filtered out the same way at query time
- durables, episodes, and procedures all store embeddings as `F32_BLOB(1024)`
- libSQL vector indexes are created for durables, episodes, and procedures when vector support is available
- the code tolerates missing vector support and degrades gracefully

Episodes do not currently use FTS. Episode retrieval is time-window and vector based.

### 6.4 Bulk-write mechanics

`src/adapters/db/schema.ts` owns more than table creation. It also manages:

- greenfield schema initialization with legacy artifact detection, required-table fingerprinting, and no migration path
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

### 7.2 Durable recall

The durable recall engine is implemented across:

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
- explicit `asOf` resolution that prefers validity windows, then claim-support observation time, then created-at
- best-effort recall telemetry writes to `recall_events`

One repo-specific feature matters here: historical-state expansion. The adapter can reintroduce inactive lineage-linked predecessors when the query appears to ask about an earlier or previous state.

The same read boundary also carries a lightweight runtime slot-policy registry. Claim keys still identify exact slots, but read-time shaping can now distinguish `exclusive` slots from `multivalued` slots so same-key siblings are not always treated as mutually competing current truth.

### 7.3 Unified recall

The agent-facing router is `runUnifiedRecall()` in `src/app/recall/unified.ts`.

It can query:

- entries only
- episodes only
- procedures only
- any supported combination of procedures, entries, and episodes

Routing uses actual heuristics in code, including:

- factual versus narrative phrasing
- procedural phrasing such as how-to, steps, method, checklist, and walkthrough asks
- resolved temporal windows
- topic anchors
- historical-state patterns such as "what changed" or "what did we use before"

The router also emits user-facing notices about entry-only filters, episode freshness, semantic episode fallback behavior, and lexical-only procedure fallback. Its response shape includes explicit `asOf` metadata when requested, canonical procedure and procedure-candidate sections when procedures were queried, plus compact claim-transition summaries that can attach nearby episode context without collapsing the different memory types into one undifferentiated result list.

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

Compared with durable recall, episode recall is more time-oriented. It parses richer date and calendar expressions and scores temporal overlap or proximity ahead of weak recency tie-breakers.

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
- `src/app/session-start/*`
- `src/app/before-turn/*`

The plugin is not just tool exposure. It implements live session behavior.

Current plugin registration includes:

- memory prompt-section injection
- memory flush-plan registration
- memory runtime registration
- hooks for `before_prompt_build`, `session_start`, `session_end`, and `gateway_stop`
- tools `agenr_store`, `agenr_recall`, `agenr_fetch`, and `agenr_update`

Implemented behaviors include:

- process-lifetime shared service composition in `src/app/openclaw/runtime.ts`
- app-layer session-start patch selection that merges predecessor artifacts with bounded durable memory
- app-layer before-turn patch selection that merges bounded durable recall with optional canonical procedure suggestion
- predecessor resolution through `resumedFrom` and `sessions.json` fallbacks
- continuity summary reads and on-demand generation
- recent-session transcript rendering
- background predecessor episode writing
- transcript normalization shared by durable ingest and episode ingest

The transcript parser in `src/adapters/openclaw/transcript/parser.ts` is a major seam. It removes host noise, normalizes metadata, summarizes or drops noisy tool results, and produces the cleaned message stream that downstream ingest and episode workflows consume.

### 7.7 Skeln runtime

The Skeln integration spans:

- `src/adapters/skeln/index.ts`
- `src/adapters/skeln/hooks/*`
- `src/adapters/skeln/session/*`
- `src/adapters/skeln/tools/*`
- `src/adapters/skeln/format/*`
- `src/app/skeln/runtime.ts`
- shared app services in `src/app/session-start/*`, `src/app/before-turn/*`, and `src/app/plugin-runtime/*`

Current Skeln registration includes:

- `before_agent_start` injection for session-start and before-turn memory
- tools `agenr_store`, `agenr_recall`, `agenr_update`, `agenr_work`, `get_goal`, `create_goal`, and `update_goal`
- shutdown cleanup for the shared agenr database handle

Implemented behaviors include:

- process-lifetime shared service composition in `src/app/skeln/runtime.ts`
- the same app-layer session-start and before-turn patch selection used by OpenClaw, without predecessor continuity or OpenClaw transcript parsing
- transient working-context injection when `features.workingMemory` is enabled
- trusted Skeln work commands and goal aliases for working-memory lifecycle control

Skeln deliberately omits OpenClaw-only surfaces such as predecessor continuity summaries and background predecessor episode ingest. See [`docs/SKELN-PLUGIN.md`](./SKELN-PLUGIN.md) for the full adapter map.

### 7.8 Dreaming

The dreaming subsystem spans:

- `src/core/dreaming/*`
- `src/app/dreaming/*`
- `src/adapters/db/dreaming-port.ts`
- `src/adapters/db/dreaming-run-log.ts`
- `src/adapters/db/schema/dreaming.ts`

The dreaming pipeline includes:

- `scan` loads active durables and claim-key counters for the requested scope
- `extract` mines durable candidates from recent episode evidence
- `reconcile` runs deterministic claim-key quality maintenance
- `temporalize` revises stale beliefs through supersession
- `project` builds a bounded session-start profile snapshot
- `prune` stales low-signal residue while protecting high-signal durables on `standard` and `deep`
- `apply` persists accepted mutations when `--apply` is set

OpenClaw and Skeln host hooks can launch bounded `light` runs after session-end episode writes or after accumulated durable importance crosses the configured threshold.

Runtime safeguards include:

- dry-run by default
- explicit `--apply` mutation gate
- tier selection (`light`, `standard`, `deep`)
- run history and action audit trails

See [`docs/DREAMING.md`](./DREAMING.md) for the evolving stage map.

### 7.9 Claim-key scenario harness

The repo includes a dedicated scenario runtime under `src/app/scenarios/claim-keys/` with CLI support in `agenr scenarios`.

This harness:

- loads fixture-backed scenarios from `tests/scenarios/claim-keys/`
- validates scenario roots, typed inputs, and expectation blocks before execution
- loads transcript, extraction, claim-extraction, and seed fixtures through dedicated fixture-loader helpers
- creates isolated sandboxes
- runs ingest, store, or dreaming paths
- captures resulting rows, proposals, warnings, and summaries
- writes artifacts under `.hermes/scenario-artifacts/<runId>/`

That makes scenario execution part of the architecture, not just incidental test data.

### 7.10 Internal recall-eval seam

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

- `MemoryRepository` in `src/app/memory/ports.ts`
- `SessionStartRepository` in `src/app/session-start/ports.ts`
- before-turn dependency bundle in `src/app/before-turn/ports.ts`
- dreaming runtime and persistence ports in `src/app/dreaming/ports.ts`
- episode-ingest support ports in `src/app/episode-ingest/ports.ts`

Configuration is another important seam:

- `src/adapters/config/parse-agenr-config.ts` and `src/adapters/config/types.ts` own adapter-side config validation, canonical persisted shape, auth/provider checks, and resolved runtime defaults
- `src/config.ts` handles config file IO, path resolution, credentials, and stage-specific model settings on top of that parser
- OpenClaw-hosted claim extraction uses host auth and plugin config overrides
- CLI and plugin flows can share core logic while resolving credentials differently

## 9. Complexity hotspots

The parts of the architecture with the most real complexity are:

### 9.1 Claim-key lifecycle

This cuts across ingest, direct updates, recall, supersession, dreaming, and scenario coverage. If you want to understand why a durable is trusted, tentative, linked, or superseded, start here.

### 9.2 Database schema and query layer

`src/adapters/db/schema.ts`, `row-mapping.ts`, `queries.ts`, `episode-queries.ts`, and `recall-adapter.ts` encode a large amount of actual system behavior.

### 9.3 OpenClaw continuity and proactive surfacing

The `before_prompt_build` path combines session tracking, predecessor lookup, continuity summaries, proactive before-turn selection, prompt injection, transcript rendering, and background episode work.

### 9.4 Dual recall systems plus router

There are separate entry and episode recall engines, with a unified router on top and historical-state expansion beneath the entry side.

### 9.5 Dreaming

Dreaming mixes deterministic reconcile passes, later LLM extraction stages, persistence, budgets, and safety controls.

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
- `src/app/skeln/runtime.ts`
- `src/adapters/skeln/hooks/before-agent-start.ts`
- `src/app/dreaming/service.ts`
- `src/app/scenarios/claim-keys/runtime.ts`

Those files reflect the implemented architecture more accurately than older planning documents.
