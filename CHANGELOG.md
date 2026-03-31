# Changelog

## [1.4.0] - 2026-03-30

Configurable summary models, surgeon personal knowledge protection, and documentation overhaul.

### Added

- **Configurable continuity and episode summary models.** New `continuityModel` and `episodeModel` fields in the OpenClaw plugin config (`plugins.entries.agenr.config`) allow overriding the model used for continuity and episode summary generation independently. Falls back to the agent's primary model when unset. Use a fast model like `openai/gpt-5.4-mini` for these structured extraction tasks instead of burning Opus tokens.
- **Personal knowledge protection in surgeon.** The surgeon retirement pass now has explicit guidance that personal facts (family, pets, hardware, contacts, identity, physical environment) are durable by nature. Only retires personal entries when contradicted or clearly duplicated — not for low recall or moderate importance.
- **Corpus age awareness in surgeon.** The `_meta` table now tracks `last_bulk_ingest_at`, surfaced via `get_health_stats`. The surgeon heavily discounts `recall_count = 0` when the corpus was rebuilt within 30 days, preventing mass retirements of freshly ingested entries.
- **New documentation: `docs/EPISODES.md`.** Comprehensive episodic memory docs covering lifecycle, CLI usage, recall modes, temporal window parser, search modes, embeddings, session discovery, and architecture.
- **New documentation: `docs/SURGEON.md`.** Comprehensive surgeon docs covering tools, CLI commands, dry-run vs apply, budget governance, configuration, protection thresholds, and audit history.

### Changed

- **Continuity summary timeout increased.** Inner timeout bumped from 15s to 30s, read-time wrapper from 20s to 35s. Prevents timeout failures when using slower models for continuity summaries.
- **Updated `docs/RECALL.md`.** Added unified recall mode routing (`auto`/`entries`/`episodes`), auto-routing rules, temporal window parser reference, and episode search pipeline documentation.
- **Updated `docs/INGEST.md`.** Added episode ingest section with full flag documentation, behavior differences from entry ingest, session discovery, surface reconstruction, and practical examples.
- **Updated `README.md`.** Added episodic memory and surgeon to features list, CLI commands table, and new "How Episodes Work" and "How the Surgeon Works" sections with doc links.

## [1.3.0] - 2026-03-30

Episodic memory — session-level temporal recall for the brain.

### Added

- **Episodic memory system (Phases 0–6).** A new `episodes` table stores narrative summaries of what happened during each session, queryable by time range and semantic similarity. Gives the brain temporal awareness — "what happened yesterday", "what were we working on last week", "sessions about schema changes" all work.
- **Episode ingest CLI.** `agenr ingest episodes <path>` scans OpenClaw session transcripts (including rotated `.reset.*` and `.deleted.*` files), generates episodic summaries, and writes episodes to the database. Supports `--recent`, `--regenerate`, `--dry-run`, `--concurrency`, `--embed-only`, and `--no-embed` flags.
- **Session discovery via `sessions.json`.** Uses OpenClaw's session registry for authoritative metadata (surface, agentId, chatType) on active sessions. Falls back to transcript-based surface reconstruction for rotated files.
- **Surface reconstruction from transcripts.** Detects session surface (webchat, telegram, signal, tui, subagent, heartbeat, cron) from Sender metadata blocks, Conversation info blocks, inbound_meta, and content heuristics. Integrated into the transcript parser to avoid double file reads.
- **Agent ID derivation from directory path.** Falls back to parsing the OpenClaw directory structure (`agents/{agentId}/sessions/`) when registry metadata is unavailable.
- **Unified recall with mode routing.** `agenr_recall` gains a `mode` parameter (`auto`, `entries`, `episodes`). Auto-routing uses three-band rules: temporal narrative → episodes, factual → entries, mixed → both. Results returned in separate sections with routing metadata.
- **Calendar-aware temporal window parser.** Parses "today", "yesterday", "this/last week", "this/last month", "N days/weeks/months ago", "in March", "March 15th", "last Friday", and ISO dates into precise calendar intervals for episode search.
- **Episode recall pipeline.** Pure temporal search via interval overlap scoring. No embedding dependency for basic temporal queries.
- **Hybrid semantic episode search (Phase 6).** Episode embeddings stored at write time, vector index (`idx_episodes_embedding`) for cosine similarity search. Three modes: pure temporal, pure semantic, and hybrid (hard temporal filter + semantic rerank).
- **Episode embedding backfill.** `agenr ingest episodes --embed-only` backfills embeddings for episodes missing them — no LLM calls, just embedding API.
- **Episode model configuration.** New `episodeModel` config field in `agenr setup` / `agenr init` for episode summary generation model override, following the existing extraction/dedup/surgeon pattern.
- **Episode writing at session start.** Predecessor episodes generated via `before_prompt_build` hook, best-effort with timeout. Backfill CLI is the canonical repair path.
- **Parallel preflight parsing.** Episode ingest Stage 1 parses transcript files concurrently to handle large session directories (600+ files) without hanging.

### Changed

- **Continuity domain extraction.** Session handoff logic reorganized under `src/adapters/openclaw/session/continuity/` as a proper subdomain with clean public API. Continuity summaries (for session handoff) are now explicitly separate from episodic summaries (for temporal recall).
- **Renamed session summaries to continuity summaries.** Clarifies the distinction between handoff artifacts and episodic memory artifacts throughout the codebase.
- **Removed `before_reset` hook.** Does not fire for OpenClaw plugins — all episode and continuity logic uses `before_prompt_build` only.
- **Semantic memory cleanup (Ref #7).** Removed `reflection` entry type, migrated `todo` to `tasks` table, renamed `event` to `milestone`, broadened type descriptions.
- **Transcript file discovery.** Fixed regex to match rotated files with ISO timestamp dots (`.628Z`). Discovery now finds all 600+ files instead of only active `.jsonl` files.

### Fixed

- **Episode vector search ambiguous column.** Prefixed select columns with table alias in `episodeVectorSearch()` to resolve `id` ambiguity with `vector_top_k` join.
- **Temporal parser ordinal dates.** "March 15th", "January 1st", "February 2nd" now parse correctly.
- **Subagent/cron surface classification.** Session registry detects `:subagent:` and `:cron:` in session keys for correct surface tagging.
- **Internal session skipping.** Agenr prompt pipeline sessions are filtered from episode generation.

## [1.2.0] - 2026-03-29

The surgeon retirement pass — an autonomous agent that evaluates and retires stale knowledge entries.

### Added

- **Surgeon retirement pass.** A standalone agent loop powered by `@mariozechner/pi-agent-core` that evaluates knowledge entries and retires semantically stale ones. Runs as `agenr surgeon run` with full dry-run and apply modes, budget governance, and completion guards.
- **7 surgeon tools.** `get_health_stats`, `query_candidates`, `inspect_entry`, `simulate_recall`, `retire_entry`, `update_entry`, and `complete_pass` — each adapted from the v0 surgeon for v1's simpler schema.
- **Recall simulation without telemetry.** The `simulate_recall` tool wraps the v1 recall pipeline with a no-op telemetry adapter and optional target-entry exclusion, so the surgeon can test retrieval impact without polluting recall metrics.
- **Surgeon CLI commands.** `agenr surgeon run`, `agenr surgeon status`, `agenr surgeon history`, and `agenr surgeon actions <run-id>` for running, inspecting, and auditing surgeon passes.
- **Surgeon status shows evaluation coverage.** `agenr surgeon status` now displays recently evaluated vs new candidates, so you can see how much work remains before running.
- **Surgeon model configuration in setup.** `agenr setup` and `agenr init` now include surgeon model overrides in the advanced task-specific model configuration flow.
- **Budget and completion governance.** Cost-based budget tracking, context-limit detection, completion guards that reject premature pass completion, and continuation prompts that keep the surgeon working when budget remains.
- **Run and action persistence.** Surgeon runs and individual actions (retirements, skips, updates) are logged to the database for auditability and recently-evaluated filtering on future runs.
- **Database backup before apply.** Surgeon creates a timestamped backup of the knowledge database (including WAL/SHM sidecars) before executing mutations in apply mode.
- **Surgeon configuration.** New `surgeon` section in `config.json` supporting model override, cost caps, daily cost limits, context limits, custom instructions, and per-pass protection thresholds.

### Changed

- **Schema version bumped to 2.** The `surgeon_runs` table is expanded with pass type, status, token/cost tracking, model, dry-run flag, and structured summary fields. A new `surgeon_run_actions` table logs individual surgeon actions with indexed `entry_id` for efficient recently-evaluated queries. Existing databases are migrated automatically via `ALTER TABLE ADD COLUMN`.
- **Protection threshold raised to importance ≥ 9.** Entries with importance 8 are now eligible for surgeon evaluation since many entries default to importance 8 during ingestion.
- **Setup prompt updated.** The advanced model override prompt now reads "Customize task-specific models?" to reflect the addition of surgeon alongside extraction and dedup overrides.

### Fixed

- **Tightened npm publish surface.** Root package now uses a strict `"files"` allowlist so only intended artifacts are published.

## [1.1.0] - 2026-03-28

This release splits the OpenClaw plugin into its own publishable npm package and tightens session-start handoff reliability.

### Added

- **Standalone OpenClaw plugin package.** Publishes the OpenClaw integration separately as `@agenr/openclaw-plugin` while keeping the runtime plugin id as `agenr`.
- **Workspace-based build layout.** Adds `pnpm-workspace.yaml` and package-specific build wiring for the dedicated plugin package.
- **Plugin packaging coverage.** Expands tests to verify the standalone plugin package metadata, manifest/version alignment, and that the plugin entry graph stays free of CLI-only code.
- **Plugin-specific docs.** Adds package-level README content and OpenClaw docs covering the new install and local development paths.

### Changed

- **CLI package is no longer the plugin package.** The root `agenr` package now builds the CLI plus the plugin package, but no longer exposes OpenClaw plugin metadata itself.
- **OpenClaw install instructions updated.** Installation now uses `openclaw plugins install @agenr/openclaw-plugin`, with migration guidance for existing users and unchanged plugin id/config keys.
- **Init flow updated for split packaging.** OpenClaw setup and installation flows now point at the standalone plugin package instead of the root package.

### Fixed

- **Plugin manifests now carry release versions.** Both shared and published OpenClaw manifests include explicit version metadata.
- **Longer session-start summary timeout.** Increases the read-time predecessor summary generation timeout from 10 seconds to 20 seconds so session handoff injection is less likely to fail on slower LLM responses.

## [1.0.1] - 2026-03-28

A focused patch release for OpenClaw plugin compatibility and installation reliability.

### Fixed

- **Flattened `agenr_update` tool schema.** Removes the OpenClaw/provider schema shape that caused `Invalid schema for function 'agenr_update'` during tool registration.
- **Repaired OpenClaw plugin installs.** Fixes the plugin installation path/packaging issue so agenr installs cleanly as an OpenClaw plugin.

## [1.0.0] - 2026-03-28

The first stable release of agenr v1 — a complete rewrite from v0 with a clean hexagonal architecture, native OpenClaw plugin, and interactive onboarding.

### Core

- **Hexagonal architecture.** Clean core/adapters separation enforced by ESLint. Core logic has zero infrastructure dependencies. Ports & adapters pattern enables multiple integration surfaces over a shared brain.
- **Hybrid recall pipeline.** Vector similarity (cosine, 1024-dim) + lexical FTS + temporal awareness + importance weighting + recency decay. Supports date range queries, around-date targeting, and browse mode.
- **LLM-powered knowledge extraction.** Transcript parsing → noise filtering → chunking → LLM extraction → validation → semantic dedup → embedding → store. Domain-agnostic extraction prompt with calibrated importance tiers.
- **Semantic deduplication.** Exact content hashing + normalized hashing + embedding similarity. Within-batch LLM dedup pass eliminates near-duplicates before storage.
- **SQLite storage with libsql.** Local-first database with vector index support. Designed for future Turso edge migration.

### OpenClaw Plugin

- **Native memory slot plugin.** Registers as OpenClaw's exclusive memory slot via `plugins.slots.memory`, replacing the built-in `memory-core`. Provides memory prompt section, flush plan, and memory runtime.
- **Session-start recall.** Injects core memory entries at every session start via `before_prompt_build` hook.
- **Session continuity.** File-based session summaries written next to transcript JSONL — no brain pollution. LLM-generated narrative summaries capture what was discussed, decided, and left open. Transcript tail provides raw last-few-exchanges for tone continuity.
- **TUI predecessor fallback.** Handles TUI `/new` sessions (which don't fire server-side reset hooks) by scanning `sessions.json` with stable-lane matching. Generates summaries at read time when no summary file exists.
- **Agent tools.** `agenr_recall`, `agenr_store`, `agenr_retire`, `agenr_update`, `agenr_trace` — the agent interacts with its own brain during sessions.
- **Uses OpenClaw's LLM.** Session summaries use OpenClaw's configured model and auth via `runEmbeddedPiAgent` — no separate LLM credentials needed for the plugin.
- **Metadata stripping.** Transcript parser strips OpenClaw-injected metadata blocks (sender info, untrusted context headers) from user messages. All consumers (summary generation, transcript tail, ingestion) get clean text.

### CLI

- **`agenr init`** — Interactive onboarding wizard: auth setup, model selection, OpenClaw detection, plugin installation, session scanning, and optional bulk ingestion with cost estimation.
- **`agenr setup`** — Configure LLM provider, auth method, model, and embedding API key. Supports OpenAI API key, OpenAI subscription (Codex CLI), Anthropic API key, Anthropic OAuth, and Anthropic long-lived token.
- **`agenr recall`** — Semantic + memory-aware recall with temporal filters (`--since`, `--until`, `--around`).
- **`agenr ingest`** — Bulk transcript ingestion with parallel extraction, progress reporting, and cost tracking.
- **`agenr db`** — Database management (stats, reset, version, path).

### Breaking Changes from v0

- **Complete rewrite.** No backwards compatibility with v0 config, database schema, or plugin format.
- **No projects or platforms.** v1 uses a flat namespace — no project slugs, no platform detection, no project-scoped recall. Tags provide lightweight scoping when needed.
- **No surgeon.** Corpus health maintenance is deferred to a future release.
- **No MCP server.** MCP integration is planned but not included in 1.0.
- **File-based session continuity.** Replaces v0's brain-entry-based handoff (fallback entry + LLM summary + retire fallback). Session summaries are ephemeral files, not durable knowledge entries.
- **Simplified config.** Single `~/.agenr/config.json` with auth method, provider, model, and credentials. No per-project configs, no project map, no scoring tuning.
