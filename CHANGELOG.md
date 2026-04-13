# Changelog

## [Unreleased]

## [1.9.3] - 2026-04-12

Supersession sweep-exhaustion and plugin-manifest alignment patch release.

### Fixed

- **Supersession claim-key sweeps no longer strand the pass in a false remaining-work state.** Exhausted claim-key pages now record the actual unpaged remainder, which lets same-run subject review unblock correctly instead of tripping the autonomous semantic-stall guard.
- **OpenClaw plugin manifests stay version-aligned across release artifacts.** The shared adapter manifest now tracks the published package/plugin version again, avoiding package-metadata skew during validation and release packaging.

### Validation

Changes since last push to `origin/master`:

- Fix supersession claim-key sweep exhaustion

## [1.9.2] - 2026-04-12

Surgeon proposal-resolution hardening and claim-key progress-output patch release.

### Changed

- **Claim-key preview progress output is less misleading.** Preview-only `claim_key_quality` lines no longer print applied or proposal counts before entry adjudication has actually started.

### Fixed

- **Malformed eligible proposals no longer fail the whole autonomous run.** Proposal resolution now rejects invalid auto-apply candidates per proposal and continues through the rest of the backlog.
- **Ambiguous entity-family convergence proposals stay on the manual-review path.** Multi-target family-convergence proposals are no longer marked eligible for autonomous apply.

### Validation

Changes since last push to `origin/master`:

- Fix surgeon proposal resolution and progress output

## [1.9.1] - 2026-04-12

Supersession stall-recovery and review-order guard patch release.

### Changed

- **Supersession review order is now enforced at the tool boundary.** The supersession query tool now blocks widening into lower-confidence subject sweeps until the same run has actually exhausted claim-key work, keeping the pass aligned with its intended review order.

### Fixed

- **Supersession passes no longer self-poison completion state by widening too early.** The surgeon now avoids the stuck `widenedBeforeClaimKeyExhausted` path that could leave a run unable to complete cleanly after later claim-key review caught up.
- **Supersession completion feedback is more actionable.** Rejected `complete_pass` calls now tell the model how to count reviewed-but-intentionally-unlinked clusters via `entries_skipped`, reducing repeated no-progress bounded slices.

### Validation

Changes since last push to `origin/master`:

- Fix surgeon supersession stall handling

## [1.9.0] - 2026-04-12

Surgeon autonomy, review-flow hardening, and CLI/runtime polish release.

### Added

- **Surgeon autonomy control plane v1.** Agenr now ships the first full surgeon autonomy control plane with stronger proposal-review flow, improved review ownership, and better runtime state handling across autonomous passes.
- **Architecture review skill.** Added a dedicated architecture review skill to support repository-level structural review work alongside the surgeon and planning toolchain updates in this release window.

### Changed

- **Surgeon architecture and runtime boundaries are cleaner.** Surgeon logic was refactored across app, adapter, and domain seams, with generalized prompts across corpus domains, tighter runtime safeguards, simplified run flow, and more coherent completion/progress accounting.
- **CLI and trace output are more structured.** Surgeon console output, startup summaries, progress rendering, and trace logging were tightened so autonomous runs are easier to monitor and debug.
- **Local development scaffolding stays out of git status.** `.gitignore` now excludes the repo-local skills directory to keep local agent tooling from polluting release and day-to-day workflow status.

### Fixed

- **Autonomous surgeon passes recover more reliably.** Fixed proposal-loop stalling, autonomous backup handling, trace directory handling, exhausted-review completion, and repeat supersession-review suppression so long-running surgeon activity can finish cleanly.

### Validation

Changes since last push to `origin/master`:

- Clean up surgeon CLI output with structured progress and chalk formatting
- Simplify surgeon run flow
- Fix surgeon trace directory handling
- Compact surgeon trace logging
- Implement surgeon autonomy control plane v1
- Fix surgeon autonomous proposal loop
- Fix surgeon autonomous backup and progress stalling
- Stabilize surgeon retirement and proposal passes
- Generalize surgeon prompts across corpus domains
- Add first-principles planning skill
- Tighten surgeon runtime safeguards
- Update `.gitignore` to include skills directory
- Remove first-principles planning skill and associated OpenAI agent configuration files
- Finish supersession completion on exhausted reviews
- Improve surgeon progress accounting and console output
- Suppress repeat supersession review and polish surgeon CLI output
- Add architecture review skill
- Refactor surgeon architecture boundaries
- Clarify surgeon pass startup summaries

## [1.8.2] - 2026-04-12

Temporal parsing and ingest workflow polish patch release.

### Changed

- **Relative time parsing now accepts small spelled-out amounts.** Episode temporal-window parsing now recognizes natural language queries such as "two days ago" for small relative ranges, improving recall routing for conversational phrasing.
- **Local Cursor scaffolding stays out of repo status.** `.gitignore` now excludes local Cursor rules and skills directories so release work and day-to-day development stay focused on product changes.

### Fixed

- **Ingest progress propagation now reaches the CLI consistently.** The ingestion app and CLI layers now forward progress events end-to-end so long-running ingest runs surface stage updates reliably.

### Validation

Changes since last push to `origin/master`:

- Update `.gitignore` to exclude cursor rules and skills directories
- Enhance temporal parsing with small spelled-out relative amounts
- Enhance ingestion process with progress event propagation

## [1.8.1] - 2026-04-11

Ingest concurrency and progress reporting patch release.

### Fixed

- **Dedup now honors bounded concurrency.** Multi-entry similarity clusters are now arbitrated in parallel with deterministic result ordering, and ingest paths explicitly thread configured/default concurrency into dedup instead of leaving arbitration serial.
- **Claim extraction now uses real batch concurrency without violating ordered semantics.** Batch claim-key extraction now honors configured concurrency, preserves past-only hint visibility via per-entry frozen hint snapshots, and propagates sensible defaults through the relevant ingest/store paths instead of falling back to historical hardcoded single-worker behavior.
- **Ingest spinner now reports real post-extraction stages.** Non-verbose `agenr ingest entries` runs now surface dedup, claim-key extraction, store pipeline, and bulk-write index preparation/finalization stages instead of looking stuck after `(N/N extracted)`.

### Validation

Changes since last push to `origin/master`:

- Enhance ingestion process with stage progress events
- Refactor deduplication process to support configurable concurrency
- Refactor concurrency handling in ingestion process

## [1.8.0] - 2026-04-11

Claim-centric trust loop close-out release.

### Changed

- **Roadmap close-out hardening.** Added a narrow OpenClaw `memoryPolicy.slotPolicies.attributeHeads` seam for claim-aware read overrides, expanded operator trace surfaces with structured CLI JSON output and broader claim-transition explanations, hardened lexical recall for non-ASCII queries, and aligned docs plus a dedicated `pnpm typecheck:tests` guardrail with the delivered roadmap state.
- **Still intentionally deferred.** Agenr still does not ship a standalone `agenr store` CLI, a full provenance graph, or the broader external eval/reporting work owned by `agenr-evals`.

## [1.7.4] - 2026-04-04

OpenClaw plugin complete-chunk fix release.

### Fixed

- **Plugin package chunk completeness.** The OpenClaw plugin package now ships the full set of root-build chunk files alongside `dist/index.js`, eliminating broken runtime imports caused by missing chunk files in the published tarball.

## [1.7.3] - 2026-04-04

OpenClaw plugin packaging consistency fix release.

### Fixed

- **Plugin package artifact consistency.** Rebuilt the OpenClaw plugin package directly from the current root adapter build so the published `dist/index.js` and shipped chunk files stay in sync. This fixes the broken 1.7.2 tarball that referenced chunk files not actually included in the published package.

## [1.7.2] - 2026-04-04

OpenClaw plugin package runtime fix release.

### Fixed

- **Plugin dist chunk layout.** The OpenClaw plugin package now rewrites and ships the required local chunk imports alongside `dist/index.js` so the installed plugin can resolve its runtime dependencies correctly inside OpenClaw. This fixes the broken `../../chunk-*.js` import paths introduced in 1.7.1.

## [1.7.1] - 2026-04-04

OpenClaw plugin packaging fix release.

### Fixed

- **Plugin package build layout.** The OpenClaw plugin package now imports the built root OpenClaw adapter entry instead of rebundling the entire agenr source graph into the plugin artifact. This is intended to keep the published plugin package thin and avoid install-time OpenClaw security scan blocks caused by bundled provider/runtime code patterns.

## [1.7.0] - 2026-04-04

Claim-key quality foundations, recall integration, auto-supersession, surgeon quality passes, and OpenClaw plugin publishing polish.

### Added

- **Claim-key Phase 2a foundation.** Shared normalization/validation pipeline for claim keys, stronger post-extraction validation, and explicit claim-key preservation work for re-ingest flows.
- **Claim-key Phase 2b extraction quality.** Improved extraction quality with better prompting/hints and related quality tuning for missing-key backfill.
- **Claim-key Phase 2c recall integration.** Recall lineage expansion now uses claim keys as a structural signal.
- **Claim-key Phase 2d store-time auto-supersession.** New entries can auto-link to prior siblings on the same claim key under safety gates.
- **Claim-key Phase 2e surgeon quality pass.** New surgeon claim-key quality pass with missing-key backfill, supported promotion lanes, compaction, grounded-family promotion, stable-slot promotion refinement, and entity-family convergence scaffolding.
- **Shadow-mode sibling-slot-resonance instrumentation.** Deterministic diagnostic instrumentation for threshold-only supported cohorts, persisted in surgeon run details and summaries without changing live auto-apply behavior.

### Changed

- **Claim-key quality promotion policy.** Rebalanced supported promotion, compact canonicalization, grounded backfill behavior, and grounded-family/stable-slot promotion rules to surface stronger candidates while preserving unresolved boundaries.
- **Surgeon progress/liveness reporting.** Improved preview concurrency and progress reporting during claim-key-quality runs.
- **Planning and review docs.** Added and updated internal plan/review docs covering claim-key quality sequencing, grounded-family promotion analysis, threshold-only cohort audit, and shadow-mode follow-up.

### Validation

Changes since last push to `origin/master`:

- feat: add historical-state recall routing
- Add unified recall path to recall eval seam
- feat: make historical recall lineage-aware
- fix: phase 2a claim key foundation
- feat: improve claim-key extraction quality
- fix: tighten agenr_store durable memory guidance
- feat: use claim keys in recall lineage expansion
- feat: add store-time claim-key auto-supersession
- feat: add surgeon claim-key quality pass
- Improve surgeon liveness progress reporting
- Improve claim-key-quality preview concurrency
- fix: tune claim-key-quality missing-key backfill
- fix: improve grounded claim-key backfill quality
- fix: promote supported claim-key proposals
- fix: compact canonical claim-key candidates
- fix: rebalance post-compaction claim-key promotion
- feat: add claim-key entity family convergence
- fix: promote grounded family missing-key candidates
- docs: add threshold-only supported cohort audit
- feat: add shadow sibling-slot resonance instrumentation
- Align surgeon presets with claim-key quality plan

## [1.6.0] - 2026-04-02

Store nudge, memory guidance improvements, plugin rename, and dead code cleanup.

### Added

- **Store nudge system.** Mid-session memory prompting via `[MEMORY CHECK]` injection. When the agent goes N turns without storing to agenr, a nudge is injected via `prependContext` reminding it to review recent conversation for durable knowledge. Escalating message tone across nudge ordinals. Three-level store outcome classification (stored/skipped/failed) with separate tracking for explicit memory maintenance actions (`claimKey`, `supersedes`, `agenr_update`, `agenr_retire`). Configurable via `storeNudge.enabled`, `storeNudge.threshold` (default 8), and `storeNudge.maxPerSession` (default 5).
- **`after_tool_call` hook.** New hook handler for real-time memory action detection. Synchronous state mutation (no async before write) to avoid races with OpenClaw's fire-and-forget dispatch. Classifies `agenr_store`, `agenr_update`, and `agenr_retire` tool calls.
- **`MidSessionTracker`.** Separate per-session runtime state tracker for nudge logic, distinct from `SessionStartTracker`. Tracks turn counts, store counts, nudge counts, stored subjects (bounded to last 5), and three-level memory action timestamps. Includes session cleanup via TTL pruning.
- **Session identity helper.** Shared `resolveSessionIdentityKey()` used by both trackers for consistent session key resolution.
- **ESLint safety rules.** New eslint config with safety rules for the codebase.

### Changed

- **Improved memory guidance.** Tightened prompt section and store tool descriptions informed by Claude Code memory research. Includes success recording ("store validated wins, not just corrections"), compact exclusion filters, session-vs-durable distinction, and Rule → Why → How to apply structure hints for lessons and preferences.
- **Plugin package renamed.** `@agenr/openclaw-plugin` → `@agenr/agenr-plugin` across all source, docs, tests, and config. Fixes the `deriveIdHint` compatibility warning — `agenr-plugin` matches the `{manifestId}-plugin` pattern.
- **Non-first-turn `before_prompt_build` path.** Previously returned `undefined` immediately. Now handles mid-session nudge injection with skip guards for non-user triggers (heartbeat, cron, memory).

### Removed

- **Dead internal session filtering.** Removed `isInternalAgenrSession` guard and `INTERNAL_AGENR_SESSION_PREFIX` constant from `before-prompt-build.ts`. The `temp:agenr-*` session prefix is no longer used in v1 — internal worker sessions use different mechanisms.

## [1.5.0] - 2026-04-01

Temporal validity, claim extraction, surgeon supersession pass, and OpenClaw auth improvements.

### Added

- **Temporal validity schema.** New `valid_from`, `valid_to`, `claim_key`, `supersession_kind`, and `supersession_reason` columns on entries. Entries can now express when a fact is true in the world, how facts replace each other, and why. All columns are nullable and backward-compatible.
- **Claim key extraction.** Automatic `claim_key` assignment at store time via LLM classification. Identifies the `entity/attribute` slot an entry occupies (e.g., `jim/home_city`, `agenr/default_model`). Runs as a best-effort pipeline stage — entries store normally if extraction fails or is disabled. Supports entity hint seeding from existing claim keys to prevent namespace drift. Configurable confidence threshold (default 0.8), eligible types (fact, preference, decision), and model override.
- **Claim extraction in bulk ingest.** `agenr ingest` now runs batch claim extraction with configurable concurrency. Entries that already have a `claim_key` are skipped.
- **Claim extraction model in CLI setup.** `agenr setup` and `agenr init` now include a "Claim extraction" stage in the model customization flow, alongside extraction, dedup, episode, and surgeon.
- **Explicit supersession in store pipeline.** `agenr_store` accepts optional `supersedes`, `claim_key`, `valid_from`, and `valid_to` fields. When `supersedes` is provided, the old entry is atomically linked to the new one in a transaction.
- **Surgeon supersession pass.** New `agenr surgeon run --pass supersession` finds entries that should be linked via `superseded_by` and creates those links with kind and reason. Candidate generation groups by shared claim key (highest confidence) or shared subject+type (medium confidence). Four new tools: `query_supersession_candidates`, `link_supersession`, `assign_claim_key`, `set_validity`. Hard rules enforced in code: no cross-type links, no milestone supersession, no core-expiry supersession.
- **`claimExtractionModel` in OpenClaw plugin config.** Model override for claim extraction at store time, using OpenClaw's auth system.
- **Lightweight OpenClaw LLM client.** New `createOpenClawLlmClient` factory resolves credentials from OpenClaw's `modelAuth.resolveApiKeyForProvider` and calls pi-ai's `completeSimple()` directly — no embedded agent runner overhead.

### Changed

- **OpenClaw continuity and episode summaries use lightweight LLM client.** Migrated from the heavy embedded agent runner (`runEmbeddedPiAgent` with temp directories and full agent lifecycle) to the new `createOpenClawLlmClient` for direct `completeSimple()` calls. Same auth, dramatically less overhead.
- **OpenClaw claim extraction uses OpenClaw auth.** Store-time claim extraction now resolves credentials through OpenClaw's `modelAuth` system instead of agenr's CLI credentials. Fixes silent failures when agenr API keys aren't configured in OpenClaw-hosted contexts.
- **Surgeon is now pass-aware.** The agent loop, prompt selection, tool selection, and completion guards are all driven by the pass type. Shared infrastructure (budget, audit, trace) remains pass-agnostic.
- **Multi-surface session continuity.** Improved continuity resolution across different chat surfaces and session types.
- **Architecture cleanup.** Internal refactoring across multiple phases for cleaner module boundaries.

### Documentation

- **Model config auth boundary.** New architecture doc and updated code comments clarifying the split between CLI-context models (agenr auth) and OpenClaw-context models (OpenClaw auth).
- **Updated README.md and SURGEON.md** with supersession pass documentation.

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

- **Standalone OpenClaw plugin package.** Publishes the OpenClaw integration separately as `@agenr/agenr-plugin` while keeping the runtime plugin id as `agenr`.
- **Workspace-based build layout.** Adds `pnpm-workspace.yaml` and package-specific build wiring for the dedicated plugin package.
- **Plugin packaging coverage.** Expands tests to verify the standalone plugin package metadata, manifest/version alignment, and that the plugin entry graph stays free of CLI-only code.
- **Plugin-specific docs.** Adds package-level README content and OpenClaw docs covering the new install and local development paths.

### Changed

- **CLI package is no longer the plugin package.** The root `agenr` package now builds the CLI plus the plugin package, but no longer exposes OpenClaw plugin metadata itself.
- **OpenClaw install instructions updated.** Installation now uses `openclaw plugins install @agenr/agenr-plugin`, with migration guidance for existing users and unchanged plugin id/config keys.
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
