# agenr Architecture

This document describes the architecture that is actually implemented in the current codebase under `src/` and `packages/openclaw-plugin/`. When code and older docs disagree, the code wins.

## 1. What agenr is

agenr is a local-first memory system for agents. In the current implementation it manages two related but distinct memory planes:

1. **Durable knowledge entries** in `entries`
   - facts, decisions, preferences, lessons, relationships, milestones
2. **Session-level episodic memory** in `episodes`
   - summarized prior sessions, mostly from OpenClaw transcripts

On top of those stores, agenr provides:

- a hybrid entry recall pipeline
- an episodic recall pipeline
- a unified router that decides which one to use
- transcript ingestion pipelines for both entries and episodes
- an OpenClaw plugin that injects memory and continuity into live sessions
- a maintenance subsystem called **surgeon** for claim-key cleanup, supersession, and retirement

The system is centered on a local libSQL / SQLite database, with LLMs and embeddings used as services, not as the system of record.

## 2. Repository shape

The code is organized around these top-level areas:

- `src/core`
  - domain types, ports, validation, ranking, transcript extraction, store pipeline, episode search, surgeon domain types
- `src/app`
  - orchestration and use-case services for ingestion, episode ingest, unified recall, OpenClaw runtime composition, surgeon execution, evals
- `src/adapters`
  - libSQL database adapter, LLM and embedding clients, transcript/file adapters, OpenClaw plugin adapter, internal eval HTTP adapter
- `src/cli`
  - Commander CLI surface
- `packages/openclaw-plugin`
  - packaging wrapper that re-exports the main OpenClaw plugin entry
- `tests`
  - tests roughly mirroring core, app, adapters, cli, and scenarios

The current CLI is wired in `src/cli/main.ts` and registers:

- `agenr ingest` (`entries` and `episodes`)
- `agenr db`
- `agenr recall`
- `agenr scenarios`
- `agenr setup`
- `agenr init`
- `agenr surgeon`

Notably, there is **no broad external HTTP memory API** in the current tree. The only HTTP adapter present is the internal recall-eval server in `src/adapters/api/internal-recall-eval-server.ts`.

## 3. Layering, intended vs actual

### Intended layering

The intended dependency shape is mostly:

`core -> app -> adapters -> cli/plugin`

In practice:

- `core` defines the main domain contracts in `src/core/ports.ts` and the canonical types in `src/core/types.ts`
- `app` coordinates multi-step workflows like ingestion, unified recall, episode ingest, and surgeon runs
- `adapters` connect those workflows to libSQL, OpenClaw, filesystem, embeddings, and LLM providers
- `cli` and the OpenClaw plugin are the user-facing entry points

### Where reality differs

The code mostly follows that layering, but there are important exceptions:

1. **"Core" is infrastructure-agnostic, not deterministic**
   - Core code imports no database or SDK clients, but it still depends on ports for embeddings and LLM calls. The ingestion and store pipelines are pure in dependency shape, not purely algorithmic.

2. **The OpenClaw adapter is heavier than a thin adapter**
   - `src/adapters/openclaw` does not just translate I/O. It contains substantial orchestration for session-start recall, predecessor continuity, read-time continuity summary generation, transcript normalization, mid-session nudges, and best-effort predecessor episode ingestion.

3. **Application composition is split across app and adapters**
   - `src/app/openclaw/runtime.ts` composes shared services, but those services are concrete adapters like `createDatabase`, `createRecallAdapter`, and `createOpenClawRepository`.

4. **Database adapters expose multiple feature-specific ports**
   - The same libSQL adapter implements `DatabasePort`, `EpisodeDatabasePort`, recall support, OpenClaw read models, and surgeon persistence. The DB layer is both storage and the main query engine.

5. **Surgeon is not one thing**
   - The current surgeon subsystem has three passes with different execution styles:
     - `claim_key_quality`, deterministic
     - `supersession`, agentic
     - `retirement`, agentic
   - So "surgeon" is a family of maintenance workflows, not just a retirement bot.

## 4. Core subsystems

### 4.1 Durable entry subsystem

Main files:

- `src/core/types.ts`
- `src/core/store/*`
- `src/core/ingestion/*`
- `src/core/recall/*`
- `src/adapters/db/queries.ts`
- `src/adapters/db/recall-adapter.ts`

Responsibilities:

- define the durable memory schema
- validate and store new entries
- deduplicate and supersede entries
- compute hybrid recall results
- track recall telemetry

### 4.2 Episodic memory subsystem

Main files:

- `src/core/episode/*`
- `src/app/episode-ingest/*`
- `src/adapters/db/episode-queries.ts`
- `src/adapters/openclaw/episode/episode-writer.ts`

Responsibilities:

- summarize completed sessions into episodes
- store episode summaries with metadata and embeddings
- search episodes temporally, semantically, or both
- support background episode creation from OpenClaw continuity hooks

### 4.3 OpenClaw integration subsystem

Main files:

- `src/adapters/openclaw/index.ts`
- `src/adapters/openclaw/hooks/*`
- `src/adapters/openclaw/session/*`
- `src/adapters/openclaw/tools/*`
- `src/app/openclaw/runtime.ts`
- `src/adapters/db/openclaw-repository.ts`

Responsibilities:

- expose agenr as an OpenClaw memory plugin
- register memory tools
- inject session-start memory and continuity context
- track session state and memory activity
- normalize OpenClaw transcripts for both entry extraction and episode generation

### 4.4 Surgeon subsystem

Main files:

- `src/app/surgeon/*`
- `src/core/surgeon/*`
- `src/adapters/db/surgeon-port.ts`
- `src/adapters/db/surgeon-run-log.ts`
- `src/adapters/db/surgeon-queries.ts`

Responsibilities:

- inspect corpus health
- repair claim-key quality
- create supersession lineage between active entries
- retire stale or low-value entries
- persist run history, action audit trails, and unresolved proposals

### 4.5 CLI and eval surfaces

Main files:

- `src/cli/main.ts`
- `src/cli/commands/*`
- `src/app/evals/recall/*`
- `src/adapters/api/internal-recall-eval-server.ts`

Responsibilities:

- operator workflows for ingest, recall, DB management, setup, and surgeon
- recall evaluation harness via a narrow internal-only HTTP route

## 5. Data model and storage

## 5.1 Entries

The canonical durable record is `Entry` in `src/core/types.ts`.

Important fields include:

- identity and content
  - `id`, `type`, `subject`, `content`
- ranking and lifecycle
  - `importance`, `expiry`, `quality_score`, `recall_count`, `last_recalled_at`
- dedup and storage metadata
  - `content_hash`, `norm_content_hash`, `embedding`
- temporal validity
  - `valid_from`, `valid_to`
- claim-key structure
  - `claim_key`
  - `claim_key_raw`
  - `claim_key_status` (`trusted`, `tentative`, `unresolved`)
  - `claim_key_source`
  - confidence, rationale, and claim-support provenance fields
- lineage and retirement
  - `superseded_by`, `supersession_kind`, `supersession_reason`
  - `retired`, `retired_at`, `retired_reason`
- scoping
  - `cluster_id`, `user_id`, `project`, `tags`

The database schema in `src/adapters/db/schema.ts` stores entries in `entries` and keeps an FTS shadow table `entries_fts` for active entries only.

## 5.2 Episodes

The canonical episodic record is `Episode` in `src/core/types.ts`.

Important fields include:

- identity and source
  - `id`, `source`, `sourceId`, `sourceRef`
- transcript lineage
  - `transcriptHash`, `summaryHash`
- session metadata
  - `agentId`, `surface`, `startedAt`, `endedAt`, `messageCount`
- generated content
  - `summary`, `tags`, `activityLevel`, `project`
- generation metadata
  - `genModel`, `genVersion`
- retrieval and lifecycle
  - `embedding`, `retired`, `supersededBy`

Episodes live in `episodes`. The schema maintains a partial unique index on `(source, source_id)` when `source_id` is present.

## 5.3 Auxiliary tables

The current schema version is **8**.

Important auxiliary tables:

- `ingest_log`
  - file-path and file-hash based skip logic for entry ingest
- `recall_events`
  - entry recall telemetry, query text, session key, timestamp
- `surgeon_runs`
  - run-level surgeon metadata, tokens, cost, dry-run/apply state, summary JSON, errors
- `surgeon_run_actions`
  - per-action audit trail
- `surgeon_run_proposals`
  - unresolved structural proposals, mainly for claim-key-quality work
- `_meta`
  - schema version, bulk-write state, last bulk ingest timestamp

## 5.4 Storage mechanics

The libSQL adapter in `src/adapters/db/client.ts` is the operational center.

Key details:

- entries and episodes store embeddings as `F32_BLOB(1024)`
- vector indexes exist for both entries and episodes when the libSQL vector extension is available
- the code **tolerates missing vector support** and degrades gracefully
- the DB is opened with foreign keys enabled, a busy timeout, and WAL mode for file-backed DBs
- the adapter exposes `withTransaction()` for workflows that need atomic multi-row mutations

Bulk entry ingest has an explicit fast path:

- `prepareBulkWrites()` drops entry FTS triggers and vector indexes and records `_meta.bulk_write_state = active`
- `finalizeBulkWrites()` recreates FTS triggers, rebuilds FTS, recreates vector indexes, clears the bulk-write flag, and records `last_bulk_ingest_at`
- schema init will repair an interrupted bulk-write phase on startup

That operational recovery logic is important. It is part of the implemented architecture, not just a migration concern.

## 6. Main flows

## 6.1 Durable entry ingestion

The durable ingest flow is spread across `src/app/ingestion/service.ts`, `src/core/ingestion/*`, and `src/core/store/pipeline.ts`.

High-level flow:

1. discover transcript files
2. skip unchanged files using `ingest_log`
3. parse transcripts through a `TranscriptPort`
4. extract candidate durable memories from transcript chunks with an LLM
5. deduplicate candidates within the ingest batch using embeddings, plus optional LLM arbitration
6. optionally extract or preserve claim keys
7. validate, hash, embed, and store surviving entries
8. record ingest log rows

Important details:

- file extraction runs in parallel in the app layer
- extraction chunks are built on message boundaries with context-window awareness
- extraction output is normalized and filtered before storage
- explicit claim keys are preserved across dedup
- CLI ingest can run batch claim extraction before store
- one-off store calls, such as `agenr_store`, can also invoke claim extraction inside the store pipeline
- store-time logic can auto-link supersession in some claim-key-driven cases
- multi-entry writes prefer transactions and bulk-write mode

This means the ingest pipeline is not a single pass. It is a staged extraction, cleanup, and persistence system.

## 6.2 Durable entry recall

The entry recall engine is in `src/core/recall/search.ts`, with the query-time adapter in `src/adapters/db/recall-adapter.ts`.

It is a **hybrid** system:

- semantic vector search over active entries
- lexical FTS search over active entries
- rank fusion and score composition in core

Lexical search is tiered in `src/core/recall/lexical.ts`:

- exact phrase
- all tokens
- any tokens

Ranking combines:

- relevance
- recency
- importance

It also supports temporal biasing via:

- `since`
- `until`
- `around`
- `aroundRadius`

For historical-state queries, the adapter can expand results with inactive lineage-linked predecessors by following:

- direct `superseded_by` links
- same `claim_key`
- retired same-subject fallback rows

That historical predecessor expansion is one of the more important repo-specific behaviors. Recall is not only "search active facts". It can deliberately surface prior state.

Recall telemetry is written to `recall_events` through the adapter. Those writes are best-effort and are not allowed to break recall responses.

## 6.3 Unified recall

The agent-facing recall entry point is `src/app/recall/unified.ts`.

`runUnifiedRecall()` routes a query into:

- entry recall
- episode recall
- or both

Supported modes:

- `auto`
- `entries`
- `episodes`

Routing uses real heuristics from the code, including:

- factual phrasing
- narrative phrasing
- detected time windows
- topic anchors
- historical-state patterns like "what changed" or "what was the previous approach"

Important behavior:

- entry filters like `types` and `tags` only apply to entries
- episode recall may add notices when semantic search is unavailable
- the response tells the caller which route was used and why

So the unified recall layer is the policy router sitting above two different retrieval systems.

## 6.4 Episode ingest

Episode ingest is more explicitly staged than entry ingest.

Files:

- `src/app/episode-ingest/service/preflight.ts`
- `src/app/episode-ingest/service/plan.ts`
- `src/app/episode-ingest/service/execute.ts`

### Stage 1: preflight

`prepareEpisodeIngest()`:

- discovers transcript files
- parses and cleans them
- resolves session metadata from the OpenClaw session registry when available
- falls back to path-based or transcript-reconstructed metadata when not
- skips:
  - transcripts that already have episodes, unless regenerating
  - transcripts with fewer than `MIN_EPISODE_MESSAGES` (currently 4)
  - recently ended sessions treated as active
  - invalid or empty transcripts
- renders a capped transcript for summarization, currently limited to `14_000` chars

### Stage 2: planning

`createEpisodeIngestPlan()`:

- optionally filters candidates by a `recent` cutoff
- estimates input and output tokens
- estimates total LLM cost from model pricing metadata

### Stage 3: execution

`executeEpisodeIngestPlan()` and `ingestEpisodeTranscript()`:

- generate structured episode summaries with an LLM
- optionally embed the summary
- serialize DB writes while allowing concurrent summary generation
- upsert episodes based on source identity and summary change detection

Episode storage is therefore a planned batch workflow, not just "summarize every transcript".

## 6.5 Episode recall

Episode search lives in `src/core/episode/search.ts`.

It supports:

- temporal-only retrieval
- semantic-only retrieval
- hybrid temporal plus semantic retrieval

Compared with entry recall, the temporal parsing is richer. `src/core/episode/temporal-window.ts` handles a broader set of date and calendar expressions. Episode scoring emphasizes temporal overlap or proximity first, then activity level and weak recency tie-breakers.

Architecturally, episodes are not FTS-backed. They are searched by time window and vector similarity over summaries.

## 6.6 Surgeon

The surgeon subsystem is the maintenance plane for the corpus.

### Passes

Current implemented passes are:

- `claim_key_quality`
- `supersession`
- `retirement`

Current presets in `src/core/surgeon/domain/run-presets.ts` are:

- `claim-key-only`
- `structural` = claim-key-quality, then supersession
- `full` = claim-key-quality, then supersession, then retirement

### Execution model

This is a mixed architecture:

- `claim_key_quality` is deterministic app logic
- `supersession` and `retirement` run through `pi-agent-core` agent loops with tool sets

The surgeon runtime in `src/app/surgeon/runtime.ts` resolves:

- DB access
- recall access when embeddings are configured
- main surgeon model credentials
- optional separate claim extraction model
- protection thresholds and budgets
- optional pre-apply DB backups

The agentic passes use tool sets built in `src/app/surgeon/tools/*`, including tools for:

- querying retirement candidates
- querying supersession candidate clusters
- inspecting entries
- retiring entries
- linking supersession
- assigning claim keys
- setting validity
- simulating recall
- explicitly completing the pass

### Persistence and safety

Surgeon persists:

- run lifecycle in `surgeon_runs`
- action audit in `surgeon_run_actions`
- unresolved proposals in `surgeon_run_proposals`

The runtime enforces:

- dry-run by default
- cost caps and daily cost caps
- protection for highly important or recently recalled entries
- completion guards so the model cannot claim completion too early
- explicit backup before apply mode when possible

Architecturally, surgeon is one of the densest parts of the system because it mixes deterministic health logic, agentic loops, persistence, and operational safety.

## 7. OpenClaw integration and continuity

The OpenClaw plugin is where agenr stops being a library and starts behaving like live memory infrastructure.

## 7.1 Plugin registration

`src/adapters/openclaw/index.ts` registers:

- the memory prompt section
- a memory flush plan, currently effectively no-op for transcript compaction
- the memory runtime status surface
- five tools:
  - `agenr_store`
  - `agenr_recall`
  - `agenr_retire`
  - `agenr_update`
  - `agenr_trace`
- hooks:
  - `before_prompt_build`
  - `after_tool_call`
  - `session_start`
  - `session_end`
  - `gateway_stop`

Shared services are created once per plugin process by `createAgenrOpenClawServices()` in `src/app/openclaw/runtime.ts`.

## 7.2 What the plugin actually does

The important point is that agenr's OpenClaw integration is **not just tool exposure**.

### Session-start recall

`handleAgenrBeforePromptBuild()`:

- runs once per tracked session using `SessionStartTracker`
- loads up to 4 active `core` entries
- formats them into an "Agenr Session Recall" block
- prepends them to the prompt

### Predecessor continuity

In the same hook, agenr tries to recover continuity from the previous session:

- resolve predecessor via `session_start.resumedFrom` when possible
- otherwise fall back to scanning `sessions.json` for eligible `main` and `tui` lanes
- parse session keys conservatively, with explicit lane handling
- read an existing sidecar continuity summary if present
- otherwise generate one on demand, with a timeout, using the OpenClaw-authenticated LLM client
- render a short recent-session tail from the predecessor transcript

This is a real continuity system, not just memory recall.

### Background predecessor episode writing

After predecessor resolution, agenr kicks off a best-effort background write that tries to turn the predecessor transcript into an episode. This uses the shared episode-ingest workflow with OpenClaw-hosted auth and additional timeout budgeting.

### Mid-session nudge tracking

The plugin also tracks memory activity during a live session:

- `after_tool_call` updates state after `agenr_store`, `agenr_update`, and `agenr_retire`
- repeated turns without recent memory activity can trigger a store nudge in `before_prompt_build`
- non-user triggers such as heartbeat, cron, and memory are excluded

That means the plugin has both long-term memory behavior and conversational steering behavior.

## 7.3 OpenClaw transcript normalization

The transcript parser in `src/adapters/openclaw/transcript/parser.ts` is shared infrastructure for multiple subsystems.

It does more than JSONL parsing. It also:

- strips metadata blocks from user content
- drops or summarizes noisy tool results
- explicitly drops raw `agenr_recall` and `image` tool results from normalized transcripts
- removes base64-like blobs and other transcript noise
- reconstructs surface metadata when possible
- produces cleaned message streams used by both durable extraction and episode generation

This parser is a major architectural seam because both ingest pipelines depend on it.

## 8. Runtime seams and extension points

The most important formal seams are the core ports in `src/core/ports.ts`:

- `DatabasePort`
- `EpisodeDatabasePort`
- `EmbeddingPort`
- `RecallPorts`
- `LlmPort`
- `TranscriptPort`

These make several substitutions possible without rewriting core logic:

- swap transcript sources
- swap embedding providers
- swap LLM providers
- swap storage implementations, at least in principle

There are also feature-scoped adapter seams:

- `OpenClawRepository` in `src/app/openclaw/ports.ts`
  - read model for session-start recall, trace, and memory status
- `SurgeonPort` in `src/app/surgeon/ports.ts`
  - maintenance-specific persistence and query boundary
- episode ingest support ports and session registry ports

Configuration is another important extension seam:

- `src/config.ts` allows per-pipeline model selection
  - extraction
  - dedup
  - episode summaries
  - claim extraction
  - surgeon
- OpenClaw-hosted tasks use separate plugin-side model resolution and OpenClaw auth rather than agenr's standalone CLI credentials

Finally, there is a narrow internal HTTP seam for recall evals:

- `POST /internal/evals/recall/run`
- implemented by `src/adapters/api/routes/internal-recall-eval.ts`

That route is useful for eval infrastructure, but it is not a general product API surface today.

## 9. Complexity hotspots

The densest parts of the current architecture are these.

### 9.1 OpenClaw continuity

The OpenClaw `before_prompt_build` path combines:

- session tracking
- predecessor detection
- session-key parsing
- sessions-store fallback logic
- continuity summary read or generation
- recent-session rendering
- background predecessor episode ingestion
- session-start core recall
- optional store nudges

This is the most integration-heavy path in the repo.

### 9.2 Durable ingest pipeline

Entry ingest combines:

- transcript parsing
- chunked LLM extraction
- semantic dedup
- explicit claim-key preservation
- optional batch claim extraction
- validation
- exact and normalized hash dedup
- optional auto-supersession
- transactional persistence
- bulk-write recovery

Most of agenr's structural complexity around "how memories become trusted rows" lives here.

### 9.3 Dual recall systems plus router

There are really three retrieval layers:

- entry recall
- episode recall
- unified routing

Historical-state expansion adds another dimension because inactive lineage-linked entries can re-enter the result set.

### 9.4 Surgeon

Surgeon mixes:

- deterministic structural cleanup
- agentic tool-based passes
- budget and completion control
- audit persistence
- operational safeguards

It is closer to a maintenance platform than a single feature.

### 9.5 Schema and operational resilience

`src/adapters/db/schema.ts` is also a hotspot because it contains:

- schema creation
- migrations from v5 to v8
- vector-index tolerance
- FTS rebuilds
- interrupted bulk-write recovery
- feature-specific side tables for surgeon and recall telemetry

A lot of agenr's real architecture is encoded in that file.

## 10. Bottom line

The implemented system is best understood as a **local memory database with four major behaviors**:

1. extract durable knowledge from transcripts
2. summarize prior sessions into episodic memory
3. retrieve both kinds of memory through separate recall engines and a router
4. continuously maintain structural quality through surgeon

The nominal layer story, core, app, adapters, cli/plugin, is mostly true. But the real architecture is shaped just as much by a few cross-cutting centers of gravity:

- libSQL schema and query design
- OpenClaw session continuity behavior
- claim-key lifecycle and supersession
- agentic maintenance in surgeon

If you need to understand agenr quickly, start with these files:

- `src/core/types.ts`
- `src/core/ports.ts`
- `src/adapters/db/schema.ts`
- `src/core/store/pipeline.ts`
- `src/app/recall/unified.ts`
- `src/app/episode-ingest/service/*`
- `src/adapters/openclaw/index.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- `src/app/surgeon/service.ts`
- `src/app/surgeon/runtime.ts`

Those files reflect the current architecture more faithfully than any older high-level description.
