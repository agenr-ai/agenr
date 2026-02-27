# Changelog

## 0.9.5 - 2026-02-27

### Added
- Feedback-driven recall scoring (#267 Phase 1): recalled entries are tracked per
  session and compared against agent responses at session end. Entries that are
  used get quality score boosts; unused entries drift slightly downward.
- Correction signal: if the agent stores a contradicting entry via agenr_store
  during the session, the recalled entry that was corrected gets a strong
  negative signal (quality score drops toward 0).
- Rolling quality_score (0-1) per entry, integrated into recall ranking formula.
  Consistently useful entries rank higher over time.
- Entry-type quality floor: facts and preferences cannot drop below 0.35 to
  prevent background-context entries from being unfairly penalized.
- Auto-strengthen: entries reaching recall count milestones (3, 10, 25) get
  importance bumped by 1 (capped at 9, never auto-promotes to 10).
- Quality score distribution in `agenr health` output.

## 0.9.4 (2026-02-27)

### Changed
- refactor: removed top-level `model` config field; `models` is now required with all four task keys (extraction, claimExtraction, contradictionJudge, handoffSummary) always explicit (#277)
- `resolveModelForTask` simplified to direct lookup (no fallback chain)
- `isCompleteConfig` now checks for complete `models` instead of top-level `model`
- Old configs with top-level `model` auto-upgrade on read (value populates all task models)
- `config set model <value>` removed; use `config set models.extraction <value>` etc.

## 0.9.3 (2026-02-26)

### Added
- feat: `config set` now supports per-task model overrides via dot-path keys (for example, `models.extraction`, `models.claimExtraction`) (#276)
- Set value to `default` to remove an override and fall back to the global model
- Schema: subject_entity, subject_attribute, subject_key, claim_predicate, claim_object, claim_confidence columns on entries table (#266)
- Schema: conflict_log table for contradiction audit trail (#266)
- Schema: idx_entries_subject_key partial index (#266)
- SubjectIndex: in-memory subject key index with lazy initialization (#266)
- ConflictLogEntry type definition (#266)
- Claim extraction: dedicated LLM call extracts structured claims (subject/predicate/object) from entries at store time (#266)
- Config: per-task model configuration via config.models (#266)
- Setup: optional advanced per-task model selection in setup wizard (#266)
- resolveModelForTask() helper for consistent model resolution (#266)
- Tuned claim extraction prompt for entity normalization and reduced false no_claim results (#266)
- Fixed benchmark fixtures for edge cases (#266)
- Tuned claim extraction prompt: short-claim guidance, no-claim edge cases, entity hint from subject field (#266)
- Fixed benchmark fixtures: fact-breed alt values, decision-release-strategy realistic object (#266)
- Added alternate expected values to claim scorer for entity, attribute, predicate, object (#266)
- Expanded predicate equivalence groups and soft matches (#266)
- Removed personal information from claim extraction prompt and benchmark fixtures (#266)
- Added contradiction detection core: LLM judge classifies entry pairs as supersedes/contradicts/coexists/unrelated (#266)
- Added type-specific resolution: auto-supersede for facts and preferences, flag decisions and lessons for review (#266)
- Added conflict log for tracking detected contradictions and their resolutions (#266)
- Added contradiction judge benchmark: fixtures, scorer, and CLI flag --judge for regression testing the LLM judge (#266)
- Rewrote contradiction judge prompt: singular vs additive attribute heuristic, shorter and more focused for nano (#266)
- Tuned judge benchmark fixtures for clarity (#266)
- Fixed contradiction judge prompt regression: reverted temperature setting, restored original prompt structure with targeted additive-attribute guidance (#266)
- Added alternate accepted relations to ambiguous judge benchmark fixtures: sup-diet, sup-storage, edge-event-immutable, edge-similar-different (#266)
- Integrated contradiction detection into store pipeline: runs after claim extraction on ADD decisions, resolves conflicts with type-specific rules (#266)
- Contradiction detection is enabled by default for all store paths (watcher, plugin, CLI, ingest) (#266)
- Added production logging for claim extraction, contradiction detection, and conflict resolution (#266)
- Added `agenr backfill-claims` command to extract claims for existing entries, enabling subject index and contradiction detection on older knowledge (#266)
- Added `agenr conflicts` command: local web UI for reviewing and resolving detected contradictions (#266, seeds #171)
- Init wizard: per-task model selection for extraction, claim extraction, contradiction judge, and handoff summary (#266)

### Fixed
- fix: CLI banner now displays the current agenr version (#278)
- fix: setup and init wizards now write explicitly selected task models even when they match defaults (#275)
- fix: resolveConflict now reads autoSupersedeConfidence from config instead of hardcoding 0.85 (#275)
- fix: claim fields explicitly propagated through mutation pipeline (#275)
- fix: supersede + insert wrapped in transaction for online-dedup path (#275)
- fix: entity names with slashes sanitized during claim extraction (#275)
- fix: LLM judge errors now logged via console.warn instead of silent fallback (#275)
- fix: entity alias resolution no longer depends on single-entity heuristic (#275)
- Critical: conflicts UI "keep-new"/"keep-old" resolution was retiring the wrong entry (swarm review)
- Contradiction detection: cap subject-index candidates to maxCandidates, sort by recency
- Contradiction detection: always run both subject-index and embedding search (removed hardcoded < 3 gate)
- Contradiction detection: parallelize classifyConflict LLM calls via Promise.all
- Contradiction detection: high-confidence supersession with lower importance now flags for review instead of silent coexist
- Contradiction detection: lowered default similarity threshold from 0.72 to 0.55 (matches real contradiction scores)
- Contradiction detection: entity hint injection from DB for consistent claim extraction across sessions
- Contradiction detection: fuzzy attribute matching fallback in subject index
- Contradiction detection: cross-entity lookup for same-attribute conflicts across entity aliases
- Subject index rebuild is now atomic (swap instead of clear-then-populate)
- Conflicts UI: request body size limit (64KB), auth token on POST endpoints, safe browser open
- Extracted shared LLM helpers (clampConfidence, resolveModelForLlmClient, extractToolCallArgs) to src/db/llm-helpers.ts
- Removed unnecessary Float32Array conversions in contradiction detection pipeline
- Replaced __pendingConflicts side-channel with scoped Map
- Init wizard: change model without re-running auth setup (#275)

## 0.9.2 (2026-02-26)

### Fixed
- fix(consolidate): fragmented clustering produced duplicate canonical entries instead of a single winner (#249)
  - Phase 1 now over-fetches neighbors (3x) when type-filtered to preserve same-type neighborhood coverage
  - Added a new Phase 3 post-merge dedup pass to merge near-duplicate canonical entries created in the same run
  - Phase 3 disables idempotency and only processes clusters that include entries created during the current run

## 0.9.1 (2026-02-26)

### Changed
- Renamed `agenr daemon` CLI command to `agenr watcher` - "watcher" better describes what it does
- `agenr daemon` still works as a hidden compatibility command
- Updated user-facing command output to say "watcher" instead of "daemon"

### Internal
- Renamed `src/commands/daemon.ts` to `src/commands/watcher.ts`
- Renamed daemon command interfaces and exports from `Daemon*`/`runDaemon*` to `Watcher*`/`runWatcher*`

## 0.9.0 (2026-02-25)

### Features
- Interactive onboarding wizard for `agenr init` (#170)
  - Auth setup with API key links and connection testing
  - Embeddings API key connectivity check during setup
  - Platform auto-detection for OpenClaw and Codex (macOS, Linux, Windows)
  - OpenClaw directory confirmation with custom path support
  - DB isolation prompt for non-default OpenClaw paths (shared vs isolated)
  - Project slug derivation with interactive edit
  - Reconfigure mode with "keep current" defaults
  - Change tracking for auth, model, embeddings, directory, and DB path
- Global projects map in `~/.agenr/config.json` for OpenClaw and Codex
  - Keyed by directory path (multiple instances can share the same project slug)
  - Stores platform, project slug, and optional dbPath per instance
  - Per-repo platforms (Cursor, Claude Code, Windsurf) unchanged
- Current config display shows all registered projects with directories and DB isolation status
- `resolveProjectFromGlobalConfig()` helper for O(1) project lookup by directory
- Shared DB warning when same project slug and same database across instances
- Fix: OpenClaw sessionsDir correctly resolves to agents/main/sessions
- OpenClaw plugin auto-install with gateway restart during wizard
- Isolated DB path auto-written to OpenClaw plugin config (no manual editing)
- Session file scanner with recursive discovery, mtime filtering, size totals
- Cost estimation before ingest using model pricing from @mariozechner/pi-ai
- "Recent" ingest passes only last-7-day file paths; "full" uses directory glob
- Bulk ingest integration (--workers 10 --concurrency 1 --whole-file)
- Post-ingest consolidation prompt (merges near-duplicates from bulk ingest)
- Watcher daemon setup on macOS with launchd (120s interval)
- Re-ingest flow on model/auth change: stops watcher, resets DB, re-ingests
- Expanded setup summary with plugin/ingest/consolidate/watcher status
- Next steps section for skipped or failed wizard steps

### Changed
- Refactored setup.ts: extracted `runSetupCore()` for programmatic use
- Subscription auth methods moved to "Advanced options" submenu
- Default recommended model changed to gpt-4.1-mini
- Non-interactive init behavior preserved when CLI flags are provided
- Skip .gitignore writes for OpenClaw and Codex (not git repos)

### Fixed
- Test isolation: init wizard tests use isolated config path via `AGENR_CONFIG_PATH`
- fix(init): `installOpenClawPlugin` no longer forces the `OPENCLAW_HOME`
  environment variable on OpenClaw CLI calls, preventing production config
  overwrites when targeting a non-default directory (e.g. sandbox)
- fix(init): wizard now adds `"agenr"` to `plugins.allow` in the target
  OpenClaw config, ensuring the plugin is explicitly trusted and suppressing
  the auto-load warning

## [0.8.40] - 2026-02-25

### Added
- New `agenr benchmark` CLI command to run extraction against benchmark session
  fixtures, score results against rubric JSON, and report per-session plus overall
  metrics (recall, partial recall, precision proxy, composite, pass rate)
- New benchmark scoring engine in `src/benchmark/scorer.ts` with continuous
  rule scoring, entry claiming, regex-based must-skip checks, count/importance
  gates, and composite score penalties
- New benchmark types in `src/benchmark/types.ts` and JSON output schema with
  reproducibility metadata (`prompt_hash`, `fixture_hash`, model/version/runs)
- Multi-run benchmark aggregation with mean/min/stdev composite reporting and
  pass-rate tracking
- New scorer regression test suite (`src/benchmark/scorer.test.ts`) covering
  perfect pass, partial credit paths, regex fallback, count and ceiling penalties,
  case-insensitive matching, entry-claiming, and rule specificity ordering

### Fixed
- Fix: benchmark chunk text now joins messages with newline separator instead of empty string
- Fix: --user-only on ingest now yields zero chunks when no user messages found (was falling back to full content)
- Fix: added --user-only and --context options to CLI docs

### Changed
- Extraction pipeline now accepts optional `temperature`, `logDir`, and `logAll`
  parameters so benchmark runs can force deterministic temperature (`0`) and
  capture per-chunk LLM request/response debug logs
- Extraction prompt: strengthened skip-by-default opening, added EPHEMERAL vs DURABLE classification gate
- Extraction prompt: shifted default importance from 7 to 6, recalibrated Score 6/7 descriptions across all calibration blocks
- Extraction prompt: added 6 new anti-patterns (items 11-16) for concrete noise rejection (typos, version bumps, publish events, file observations, tautological facts)
- Extraction prompt: added 6 new SKIP examples in few-shot section to rebalance extract:skip example ratio
- Extraction prompt: added anti-consolidation instruction for personal facts with per-fact granularity and subject naming guidance
- Extraction prompt: added project convention decisions to DURABLE classification list
- Extraction prompt: improved anti-pattern #16 with extractable vs skip examples for file observations
- Extraction prompt: added anti-pattern #17 for release-engineering session noise
- Extraction prompt: whole-file calibration now distinguishes technical (consolidate) vs personal (granular) entries
- Benchmark: now runs in whole-file mode to match real ingest behavior
- Benchmark: relaxed rubric content_contains matching for paraphrase resilience
- Extraction prompt: rewrote whole-file calibration with 3-step process (session triage, user message priority, constrained extraction)
- Extraction prompt: added importance ceiling of 8 for coding/technical sessions, tightened inflation threshold from 30% to 20%
- Extraction prompt: added anti-pattern #18 for agent capability/tool setup announcements
- Extraction prompt: file contents read by agent during startup/exploration explicitly distinguished from user speech

## [0.8.39] - 2025-02-25

### Features
- **ingest:** Add LLM debug logging via `--log-dir`, `--log-all`, and `--sample-rate` flags (#238)
  - Captures raw LLM prompt input and response output per chunk
  - Logs dedup before/after entry lists
  - Best-effort writes, never blocks extraction
  - Sampling defaults to 1-in-10 files; use `--log-all` for full capture

### Tests
- Add tests for ingest debug logging: file creation, sampling, dedup logs, graceful failure on bad logDir

## [0.8.38] - 2026-02-24

### Fixed
- Handoff log line now shows model ID string instead of [object Object]
- Upgraded handoff retirement and browse debug logs from logger.debug to
  console.log for production visibility
- Handoff transcript now strips OpenClaw/agenr injected context (memory
  blocks, signals, conversation metadata, timestamp prefixes) before
  sending to the LLM, preventing the summarizer from summarizing its own
  metadata (#235)

### Added
- Opt-in `handoff.includeBackground` config flag for handoff summarizer: when
  enabled, prior session messages are included as background context with strong
  section headers so the LLM can orient without blending stale facts into the
  current session summary (#235)
- New system prompt variant with anti-hallucination instructions for background
  context mode ("BACKGROUND CONTEXT (DO NOT SUMMARIZE)" / "SUMMARIZE THIS
  SESSION ONLY" section headers)
- Optional `handoff.logDir` config: when set, writes the full LLM request
  transcript and response to files for prompt tuning and debugging (#235)

### Changed
- Default handoff behavior unchanged: current session only, no prior messages

### Removed
- All temporary [AGENR-PROBE] debug logging from openclaw-plugin (replaced with
  clean operational logs where needed)

## [0.8.37] - 2026-02-24

### Fixed
- openclaw-plugin: await runHandoffForSession in session_start handler instead of void
  fire-and-forget; webchat /new goes through sessions.reset RPC which does not trigger
  before_reset, so session_start is the only hook that fires on that path - making it
  void meant the LLM summary was always dropped (closes #232)

## [0.8.36] - 2026-02-24

### Fixed
- openclaw-plugin: await LLM upgrade in runHandoffForSession instead of fire-and-forget; the gateway awaits before_reset so the LLM call can and should block until the summary is stored (closes #230)
- openclaw-plugin: raise Phase 1 fallback store success/failure logs from logger.debug to console.log for production visibility (extends #223)

## [0.8.34] - 2026-02-24

### Fixed
- rebuild dist - --force flag missing from 0.8.33 artifact (stale build)

## [0.8.33] - 2026-02-24

### Fixed
- retire --force flag skips confirmation prompts for programmatic retirement (#225)
- runRetireTool now passes --force so high-importance handoff entries (imp >= 8) are properly retired (#225)

## [0.8.32] - 2026-02-24

### Fixed
- summarizeSessionForHandoff: changed logger.debug to console.log for all skip-reason
  and LLM call logging so output is visible in gateway.err.log at production log level
  (closes #223)

## [0.8.31] - 2026-02-24

### Fixed
- plugin: LLM handoff now logs transcript size, model, and summary length before/after the LLM call for observability (#221)
- plugin: fallback handoff retirement now matches by subject+importance+tag only, dropping fragile content equality check that left stale fallback entries alongside LLM summaries (#221)

## [0.8.30] - 2026-02-24

### Fixed
- Rebuild dist to include Phase 1A handoff trigger missing from 0.8.29.
  The dist/ artifact in 0.8.29 was stale - runHandoffForSession() call added
  in the 0.8.29 source (commit e3222c5) was not present in the published
  package. No logic changes. Build-only fix.

## [0.8.29] - 2026-02-24

### Added
- Phase 1A now triggers LLM handoff summarization (fire-and-forget) when a
  previous session file is found at session start. This is a reliable
  fallback for the before_reset/command hook paths that do not fire in
  current OpenClaw versions due to a dispatch gap (openclaw/openclaw#25074).
  The existing before_reset and command hook paths are unchanged.

### Changed
- runHandoffForSession source type now includes "session_start"

### Tests
- 5 new tests in session-handoff.test.ts covering the Phase 1A handoff
  trigger path

## [0.8.28] - 2026-02-24

### Fixed
- command hook fires before_reset handoff logic for RPC-triggered /new (closes #210)
  - before_reset hook only fires in the in-process auto-reply path; sessions.reset RPC
    path only fires the command hook
  - new command hook handler reads and parses the session JSONL directly, then runs
    the same Phase 1 fallback store + Phase 2 LLM upgrade logic
  - dedup guard (Set<sessionId>) prevents double-writes when both hooks fire in
    auto-reply path

### Added
- [AGENR-PROBE] debug logging throughout command hook path for observability
  (to be removed in a future cleanup pass)
- readAndParseSessionJsonl() helper to parse JSONL session files line by line
- runHandoffForSession() shared helper extracted from before_reset for reuse

### Tests
- 5 new tests for command hook handoff behavior in index.test.ts

## [0.8.27] - 2026-02-24

### Changed
- Add stderr debug probes to openclaw plugin to diagnose before_reset hook dispatch issue
- Probes: register() entry, hook registrations, session_start handler, before_reset handler entry and guard points

## [0.8.26] - 2026-02-23

### Added
- feat(openclaw-plugin): LLM-summarized multi-session handoff entry at
  before_reset (#199). Builds a merged transcript from the current session
  (via event.messages) and the most recent prior .reset.* file (if under
  24h old), labeled with timestamps and surface (webchat/telegram/etc.)
  from sessions.json. Summarizes via the configured LLM (from agenr config,
  default gpt-4.1-nano) into a structured four-section handoff. Falls back
  to raw text extraction on any failure. Handler is now properly async with
  awaited store call.

### Changed
- fix(openclaw-plugin): before_reset handoff store now uses a two-phase flow to
  avoid race windows with detached hook execution. Phase 1 stores fallback
  exchange text immediately at importance 9, then Phase 2 asynchronously upgrades
  to an importance 10 LLM summary when available.
- fix(openclaw-plugin): when the LLM upgrade succeeds, fallback handoff entries
  are looked up and retired (subject/content/tag match) before storing the
  upgraded summary, preventing stale fallback carryover.
- fix(openclaw-plugin): prior reset session surface lookup now maps
  `*.jsonl.reset.*` files back to base `*.jsonl` paths via getBaseSessionPath,
  and unknown surface fallback now uses "prior session" to improve prompt context.
- fix(openclaw-plugin): capTranscriptLength now enforces a hard length cap even
  when the current session alone exceeds 8000 chars.
- chore(openclaw-plugin): added before_reset debug logs for missing sessionFile,
  missing apiKey, and pre-LLM invocation traceability.

### Tests
- test(openclaw-plugin): added coverage for getBaseSessionPath, reset-path surface
  resolution, capTranscriptLength edge cases (prior-only overflow, current-only
  overflow, under-cap passthrough), missing-apiKey debug behavior, budget tail
  slicing assertions, and buildMergedTranscript ordering.
- test(openclaw-plugin): updated before_reset integration coverage for two-phase
  fallback-plus-upgrade storage behavior and no-sessionFile debug path.

## [0.8.25] - 2026-02-23

### Changed
- fix(openclaw-plugin): strip OpenClaw conversation metadata JSON blocks from
  extractRecentTurns() output (issue #208)
- fix(openclaw-plugin): extractRecentTurns() now reads JSONL bottom-up, ensuring
  most recent turns are always included when maxTurns budget is exceeded
- fix(openclaw-plugin): increase RECENT_TURN_MAX_CHARS from 150 to 300
- fix(openclaw-plugin): normalize internal whitespace in extracted turns (collapse
  newlines/spaces to single space) to keep " | " separator clean

### Tests
- test(openclaw-plugin): added tests for metadata stripping, bottom-up reading,
  and whitespace normalization in extractRecentTurns()

## [0.8.22] - 2026-02-23

### Changed
- feat(openclaw-plugin): replace thin-prompt/stash session-start recall with three-phase
  cross-session context injection (issue #205)
  - Phase 1A (always): reads last 7 user+assistant turns from most recently modified
    session JSONL file in ~/.openclaw/agents/<agentId>/sessions/
  - Phase 1B (always): runs agenr recall --browse --since 1d --limit 20, picks up
    importance:10 handoff entry written at /new time
  - Phase 2 (conditional): semantic recall seeded from Phase 1A turns + first user
    message if >= 5 words; results deduplicated against Phase 1B by entry id
  - Handoff entries retired after first use (one-time read)
- feat(openclaw-plugin): added findPreviousSessionFile, extractRecentTurns,
  buildSemanticSeed to src/openclaw-plugin/session-query.ts
- feat(openclaw-plugin): findPreviousSessionFile uses parallel stat() calls for
  performance on large sessions dirs
- feat(openclaw-plugin): sessionsDir configurable via AgenrPluginConfig.sessionsDir;
  defaults to ~/.openclaw/agents/<agentId>/sessions using ctx.agentId with "main"
  fallback
- feat(openclaw-plugin): RunRecallOptions extended with limit?: number to support
  --limit flag in browse recall
- refactor(openclaw-plugin): removed isThinPrompt, resolveSessionQuery,
  sessionTopicStash, stashSessionTopic, shouldStashTopic, sweepInterval, clearStash,
  readLatestArchivedUserMessages

### Tests
- test(openclaw-plugin): added unit tests for findPreviousSessionFile, extractRecentTurns,
  buildSemanticSeed in session-query.test.ts
- test(openclaw-plugin): added integration tests for three-phase before_prompt_build flow,
  Phase 2 deduplication, and isFirstInSession guard in index.test.ts
- test(openclaw-plugin): added second-message guard test (isFirstInSession prevents
  re-injection on subsequent messages in same session)

## [0.8.19] - 2026-02-23

### Changed
- feat(openclaw-plugin): `before_reset` handoff store content now uses a structured recent exchange summary (`U:`/`A:` turns) instead of user-only fragments, improving cross-session handoff clarity while keeping stash-based recall seeding unchanged (issue #196)
- feat(openclaw-plugin): added `extractLastExchangeText(messages, maxTurns?)` in `src/openclaw-plugin/session-query.ts` to collect the last 5 user-turn windows with interleaved assistant context, per-turn truncation (200 chars), and chronological `U:`/`A:` formatting
- chore(openclaw-plugin): exported `SESSION_QUERY_LOOKBACK` from `session-query.ts` for direct test assertions

### Tests
- test(openclaw-plugin): added `extractLastExchangeText` coverage for empty input, U/A formatting, per-message truncation, 5-user-turn collection window, and no-extractable-content behavior
- test(openclaw-plugin): updated handoff-store integration assertion to verify stored content includes exchange context prefixes (`U:`/`A:`) rather than flattened user-only text

## [0.8.18] - 2026-02-23

### Changed
- feat(openclaw-plugin): `before_prompt_build` now uses browse-mode recall (`--browse --since 1d`) for cold session starts where no stash/query seed is available, and keeps embed/query recall for substantive or stash-seeded starts (issue #196)
- chore(openclaw-plugin): removed archived-session fallback query synthesis from session-start recall seeding, simplifying thin-prompt startup behavior to browse vs stash/embed paths only (issue #196)
- feat(openclaw-plugin): `before_reset` now stores a fire-and-forget `event` memory entry (`session handoff ...`) with the latest user context to support next-session handoff continuity (issue #196)
- feat(openclaw-plugin): session-start browse results now auto-retire surfaced handoff entries after context injection to avoid repeated carryover (`reason: consumed at session start`) (issue #196)
- feat(openclaw-plugin): `runRecall` in `src/openclaw-plugin/recall.ts` now accepts an optional context options object and maps browse context to CLI browse args while preserving existing default/session-start call behavior for unchanged callers (issue #196)

### Tests
- test(openclaw-plugin): updated query-seeding coverage for new cold-start browse path and removed archive-fallback-specific expectations (issue #196)
- test(openclaw-plugin): added regression coverage for before-reset handoff storage and session-start handoff auto-retire success, non-handoff skip, missing-id skip, and retire-failure resilience (issue #196)
- test(openclaw-plugin): added plugin recall browse-args unit coverage to assert `runRecall` browse flag construction and query omission behavior (issue #196)

## [0.8.17] - 2026-02-23

### Changed
- chore: rebuild dist to include browse mode CLI flag inadvertently omitted from 0.8.16 publish

## [0.8.16] - 2026-02-23

### Added
- feat(recall): new temporal browse mode for recall via `agenr recall --browse` and MCP `agenr_recall` with `context="browse"` (issue #190)
- docs(recall): added `docs/usage/recall.md` with browse-mode CLI and MCP usage examples

### Changed
- recall browse mode now uses a SQL-only path that requires no query and performs zero embedding/OpenAI API calls
- browse mode does not increment recall metadata (`recall_count`, `last_recalled_at`, `recall_intervals`)
- OpenClaw plugin tool wiring now maps `context="browse"` to the CLI `--browse` flag (and omits query/context positional args appropriately)

### Tests
- test(recall): added browse-mode coverage in DB recall, CLI command recall, MCP server recall, and OpenClaw plugin recall tool argument wiring

## [0.8.15] - 2026-02-23

### Fixed
- fix(consolidate): switch GROUP_CONCAT separator from comma to pipe in buildClusters to prevent silent tag corruption when tag values contain commas (issue #155)
- fix(consolidate): Tier 1 near-exact duplicate merge now preserves the highest importance across merged entries by raising the keeper's `importance` floor to the group max (issue #156)
- fix(consolidate): Tier 1 near-exact duplicate merge now preserves oldest provenance by inheriting the oldest `created_at` across the merge group into the keeper (issue #156)
- test(consolidate): new cluster.test.ts with pipe-separator roundtrip and comma-in-tag regression coverage (issue #155)
- test(consolidate): added merge coverage for tag union transfer, keeper importance floor, and keeper `created_at` inheritance in rules consolidation tests (issue #156)

## [0.8.13] - 2026-02-23

### Fixed
- fix(openclaw-plugin): session-start recall now falls back to reading the most recent archived OpenClaw session file (`*.reset.*`) when webchat `/new` bypasses `before_reset`. If stash-based seeding is unavailable and the opening prompt is short (< 40 characters), recall query text is built from the last 3 user messages in the archived session.

## [0.8.12]

### Fixed
- fix(openclaw-plugin): strip OpenClaw metadata envelope from `before_prompt_build` prompts before session-start recall query resolution; query seeding now uses the user message after the final timestamp marker instead of prepended metadata, with last-match handling for repeated timestamp patterns

## [0.8.11]

### Changed
- feat(plugin): resolveSessionQuery now blends the before_reset stash with the live prompt for session-start recall; when a stash exists and the live prompt is high-signal (>=40 chars / >=5 words), the query is stash + live prompt; when the live prompt is low-signal (common short opener like "did the plugin fire?"), the stash wins outright; no-stash behavior is unchanged (issue #181)

## [0.8.10]

### Added
- feat(plugin): session-start recall now uses the inbound user message as the recall query seed, enabling vector similarity scoring instead of pure recency ranking; entries relevant to the actual conversation topic now surface at session start (issues #177, #178)
- feat(plugin): before_reset hook captures the last 3 substantive user messages before a /new reset and stashes them in memory; the next session-start recall uses the stash as its query seed when the opening prompt is low-signal (issues #177, #178)
- feat(plugin): session topic stash eviction sweep runs every 5 minutes; TTL is 1 hour

### Changed
- chore(plugin): session-start recall timeout increased from 5s to 10s to accommodate the embedding API call now required when a query is present
- chore(plugin): session topic stash requires a minimum of 40 characters and 5 words to filter out low-signal conversational closers
- refactor(plugin): session query helpers extracted from index.ts into session-query.ts

### Fixed
- fix(plugin): session-start recall no longer skips vector similarity scoring when a query is available; previously RecallQuery.text was always undefined at session start (issue #177)

## [0.8.9]

### Added
- feat(extractor): broadened extraction prompt to capture personal user context (health, diet, family, occupation, location, values) even from casual or passing mentions; added 6-month durability test heuristic to distinguish durable personal facts from transient states (issue #173)
- feat(extractor): new few-shot examples for RELATIONSHIP, PREFERENCE, FACT, and EVENT types covering personal context scenarios with scoring rationale

### Fixed
- fix(ingest): suppress redundant whole-file ignored-params warning; now fires once per ingest run via shared ExtractRunOnceFlags object instead of once per file (issue #168)
- fix(ingest): silence SQLITE_ERROR vector-index-not-found pre-fetch error during bulk ingest when vector index is intentionally absent; all other pre-fetch errors still log (issue #168)
- fix(ingest): detect .jsonl.reset.TIMESTAMP session files as JSONL adapter by extending suffix-stripping regex to handle both .deleted and .reset suffixes (issue #169)
- fix(consolidate): added merge system prompt constraint that expiry must be exactly permanent or temporary, never a date or timestamp; complements existing runtime fallback (issue #172)
- fix(daemon): daemon install plist now uses the runtime CLI path resolved from argv[1] via the injected argvFn, preventing hardcoded npm global paths from breaking pnpm installs (issue #174)

## [0.8.8]

### Fixed
- fix(ingest): whole-file mode now uses model-aware output token budgets for context-fit checks and whole-file extraction calls, including support for gpt-5-nano, gpt-5.2-codex, and gpt-5.3-codex (issue #166)
- fix(ingest): removed whole-file 100-entry truncation; extracted entries are no longer discarded and now only emit a verbose warning when entry count exceeds 500 before downstream dedup (issue #166)

## [0.8.7]

### Fixed
- fix(ingest): detect `.jsonl.deleted.<timestamp>` session files as JSONL by stripping the `.deleted.*` suffix before extension lookup, restoring OpenClaw/Codex adapter routing instead of silent text fallback (issues #160, #163)
- fix(ingest): pass the resolved ingest `verbose` flag into extraction calls so whole-file diagnostics are emitted with `--verbose`, including unknown-model context-window warnings and whole-file retry/fallback logs (issues #161, #162)
- fix(ingest): emit an explicit `[whole-file]` verbose warning when auto mode receives zero parsed messages and falls back to chunked extraction (issue #163)

## [0.8.5]

### Added
- feat(ingest): `--bulk` mode for large-scale ingests; drops FTS triggers and the vector index before writing, uses `batchSize=500` with `BEGIN IMMEDIATE` transactions per batch, and rebuilds FTS content + vector index in a single pass after all entries are written (issue #135)
- feat(ingest): MinHash dedup (`src/db/minhash.ts`) - 128-hash signatures using 5-gram shingles and FNV32 with pre-seeded arrays; two-layer dedup combines an in-memory norm-content-hash Set (cross-batch per run) with per-candidate exact-hash + MinHash scan; new `norm_content_hash` and `minhash_sig` columns added via schema migration with automatic backfill
- feat(ingest): crash recovery for interrupted bulk ingests; `_meta` flag (`bulk_ingest_state`) is set before teardown and cleared only after REINDEX succeeds; `checkAndRecoverBulkIngest()` detects an interrupted run on next startup, rebuilds missing FTS triggers and/or vector index, runs `PRAGMA integrity_check`, and clears the flag (issue #135)

### Fixed
- fix(bulk): `seenNormHashes` was updated inside the transaction before `COMMIT`, causing a rollback to poison the in-memory Set and silently skip affected entries on retry; fixed by moving the update to after `COMMIT` using a local `committedHashes` Set
- fix(bulk): `bufferToMinhashSig` threw an unhandled `RangeError` on any `minhash_sig` blob that was not exactly 512 bytes (corrupt row, partial write, or schema version mismatch); fixed with a byte-length guard before conversion
- fix(bulk): `rebuildVectorIndex` DROP+CREATE fallback was not atomic; if `CREATE INDEX` failed after `DROP` succeeded the vector index was permanently absent until recovery ran; fixed by wrapping the fallback in `BEGIN IMMEDIATE`
- fix(bulk): backfill of `norm_content_hash` and `minhash_sig` ran unconditionally on every `agenr ingest` invocation; gated on `bulkMode` to avoid unnecessary write transactions on non-bulk runs
- fix(bulk): backfill cap (5000 rows) was hit silently; warns to stderr when more rows remain so the user knows to run ingest again
- fix(minhash): short-text MinHash fallback used raw `text` instead of normalized `chars`, causing near-duplicate short strings differing only in whitespace to score Jaccard ~0
- fix(bulk): `getBulkIngestMeta` silently swallowed JSON parse errors, disabling crash recovery without any signal; now warns to stderr

## [0.8.4]

### Added
- feat(openclaw-plugin): project scoping via config.project in openclaw.json; all session-start recall and store calls are scoped to the configured project when set (issue #71)
- feat(openclaw-plugin): optional subject field in agenr_store schema; agents can now pass an explicit subject per entry rather than always relying on inference (issue #86)
- feat(openclaw-plugin): platform normalization and source_file format warnings in runStoreTool; platform is inferred from source when missing, invalid values are warned and dropped, freeform source strings trigger a format hint (issue #145)

### Fixed
- fix(recall): cap final recall scores at 1.0 after FTS bonus; Math.min(1.0) applied in scoreEntryWithBreakdown (issue #64)
- fix(mcp): correct misleading retire tool message; retired entries are hidden from all recall paths (issue #143)
- fix(mcp): inferSubject now splits on punctuation followed by whitespace only, preventing truncation on file path periods (e.g. .ts, .js)
- fix(openclaw-plugin): subject inference in runStoreTool processedEntries now uses the same safe regex as inferSubject

### Changed
- chore(openclaw-plugin): remove openclaw.plugin.json version field; package.json is now the single source of truth (issue #91)
- chore(openclaw-plugin): remove formatRecallAsSummary dead code; writeAgenrMd was already removed, this cleans up the last orphaned export (issue #77)

## [0.8.3]

### Fixed
- setup: custom model aliases (gpt-4.1-nano, gpt-4.1-mini) now appear in
  the model picker when using openai-api-key auth (issue #136)
- setup: revert hint null-normalization regression (details?.name ?? undefined)
- setup: warn user when empty credential is entered during key rotation
- setup: note that updated credential is saved but not re-validated
- setup: openai-api-key now prioritizes gpt-4.1-nano, gpt-4.1-mini, and
  gpt-5-nano in preferred model selection, and adds gpt-5-nano alias
  resolution for OpenAI model lookup
- setup: reconfigure now offers to update stored API key even when existing
  credential is valid (issue #13)
- embeddings: EmbeddingCache is now bounded with LRU eviction (default
  max 5000 entries) to prevent unbounded heap growth during large ingests
  (issue #57)
- embeddings: EmbeddingCache constructor throws RangeError for maxSize < 1

## [0.8.2] - 2026-02-22

### Added
- Per-platform extraction prompt addenda for codex/claude-code (code session rules with inline confidence caps) and plaud (meeting transcript rules)
- plaud added to KNOWLEDGE_PLATFORMS and normalizeKnowledgePlatform
- applyConfidenceCap now enforces importance cap for codex and claude-code platforms
- All CLI --platform help text updated to include plaud

## [0.8.1] - 2026-02-22

### Fixed
- fix(openclaw-plugin): sync plugin version in openclaw.plugin.json to match npm package (was stale at 0.7.21, now 0.8.1)

## [0.8.0] - 2026-02-22

### Added
- feat(ingest): whole-file extraction mode for transcript ingest. `extractKnowledgeFromChunks` now supports `wholeFile: "auto" | "force" | "never"` with automatic fit detection against known model context windows and single-call extraction when a file fits.
- feat(ingest): new `--whole-file` and `--chunk` ingest flags to force whole-file or chunked extraction mode.
- feat(ingest): new whole-file utilities in `src/ingest/whole-file.ts` for context-window detection, mode resolution, overlap-free message reconstruction, and hard-cap truncation.

### Changed
- ingest: whole-file mode now reconstructs extraction text from parsed `messages` via `renderTranscriptLine` instead of joining chunk text, avoiding overlap duplication at chunk boundaries.
- extractor: whole-file mode now skips embedding pre-fetch and skips post-extraction LLM dedup, applies a 100-entry hard cap by importance, and retries failed whole-file extraction attempts before falling back to chunked mode.
- watch: watcher calls now set `watchMode: true`, which enforces chunked extraction even if whole-file mode is requested.
- mcp: ingest-style extraction now forwards parsed `messages` into extraction so whole-file mode can be resolved consistently.

## [0.7.21] - 2026-02-21

### Fixed
- fix(openclaw-plugin): sync plugin version in openclaw.plugin.json to match npm package (was stale at 0.7.7, now 0.7.21)

## [0.7.20] - 2026-02-21

### Added
- feat(models): add gpt-4.1-nano, gpt-4.1-mini, and gpt-4.1 aliases for OpenAI
  provider; gpt-4.1-nano is now the recommended fast/cheap extraction model
  (--model gpt-4.1-nano or agenr config set model gpt-4.1-nano) (#127)

### Changed
- perf(ingest): pre-batch embedding calls in storeEntries; all entries in a
  write-queue batch are now embedded in a single API call instead of one call
  per entry, cutting embedding API round-trips from O(n) to O(1) per batch
  and reducing ingest wall-clock time proportionally to batch size (#127)

## [0.7.19] - 2026-02-21

### Fixed
- fix(ingest): WriteQueue backpressure deadlock when processing large session files; raised default highWatermark from 500 to 2000 and added configurable backpressure timeout (default 120s) that surfaces a clear error instead of hanging forever (#125)

### Added
- feat(ingest): --queue-high-watermark and --queue-backpressure-timeout-ms CLI flags for tuning write queue behavior on large ingest jobs
- feat(ingest): verbose mode now logs "[X/N] file -- starting" before extraction begins, eliminating the silent gap during large-file processing (#124)

## [0.7.18] - 2026-02-21

### Fixed
- fix(lockfile): suppress false-positive "Another agenr process is writing" warning during multi-worker ingest; `isDbLocked` now returns false when the lock is held by the current process (#121)

## [0.7.17] - 2026-02-21

### Performance
- perf(ingest): two-phase extract+write pipeline eliminates SQLite write-lock contention; extraction workers run in parallel while a single background writer drains entries in batched transactions (#107)
- feat(ingest): add `--workers` flag (default 10) for file-level parallelism; previously hardcoded to 1
- The write queue retries each write sub-batch once on transient failure (2s delay) before surfacing the error to the outer file-level retry loop. Use `--no-retry` to disable all retries including the inner write retry.

### Changed
- ingest: `entriesStored` now counts `added + superseded` (previously only `added`); superseded entries are written before the previous entry is marked superseded

## [0.7.16] - 2026-02-21

### Fixed
- docs(skill): comprehensive SKILL.md refresh covering all four tools, full importance scale, confidence-aware extraction, store optional params (subject, scope, tags, project), retire and extract tool docs

## [0.7.15] - 2026-02-21

### Fixed
- fix(openclaw-plugin): agenr_recall tool now correctly passes --until flag to CLI (was silently dropped)
- docs(skill): document all agenr_recall parameters in SKILL.md (since, until, types, platform, project, limit, context)

## [0.7.14] - 2026-02-21

### Added
- feat(recall): added `until` upper date bound to recall query filtering in CLI, MCP, and DB recall paths (`since` + `until` now define an inclusive window)

### Changed
- fix(recall): recency decay now anchors to the `until` ceiling for historical windows while freshness boost remains anchored to real query time
- fix(recall): centralized `parseSinceToIso` in `src/utils/time.ts` and removed duplicate implementations from recall CLI and MCP server
- fix(recall): added inverted date-range validation - recall now returns a descriptive error when `since > until` instead of returning an empty list
- fix(recall): interim 3x candidate over-fetch under date bounds to improve in-window recall coverage until SQL-level date filtering is added
- fix(recall): corrupt `created_at` values are now safely excluded under date-bound filters instead of leaking invalid rows into filtered recall

## [0.7.13] - 2026-02-21

### Fixed
- fix(extractor): added platform-aware extraction system prompt builder (`buildExtractionSystemPrompt`) and OpenClaw confidence addendum for role-labeled transcript handling
- fix(extractor): added `applyConfidenceCap` hard-cap enforcement for OpenClaw `unverified` entries so tagged claims cannot exceed importance 5
- fix(extractor): threaded `platform` through `extractKnowledgeFromChunks` and call sites in ingest/watch flows so OpenClaw-specific confidence behavior applies during transcript ingestion
- fix(extractor): added OpenClaw confidence few-shot examples to `SYSTEM_PROMPT` to distinguish hedged unverified claims from tool-verified claims

## [0.7.12] - 2026-02-21

### Fixed
- fix(recall): retired entries now correctly excluded from all recall queries -- missing `AND retired = 0` filter added to recall.ts and session-start.ts
- fix(consolidate): retired entries excluded from Tier-1 and clustering queries in rules.ts and cluster.ts
- fix(recall): consolidated duplicate parseSince implementations into shared utility supporting h/d/m/y units

## [0.7.11] - 2026-02-20

### Fixed
- fix(init): agenr MCP command now resolved via process.execPath (node binary) and process.argv[1] (CLI entry script) instead of which lookup -- eliminates PATH failures in GUI clients like Codex that launch with restricted environments

## [0.7.10] - 2026-02-20

### Fixed
- fix(init): codex platform now writes MCP entry directly to ~/.codex/config.toml instead of .mcp.json (which Codex does not read)
- fix(init): openclaw platform no longer writes a .mcp.json file (OpenClaw native plugin handles MCP registration via openclaw plugins install agenr)
- fix(init): agenr binary path is now resolved at init time via which or PNPM_HOME fallback -- GUI clients that launch with a restricted PATH will now find the correct binary
- fix(init): codex config.toml write is idempotent -- re-running init replaces the agenr line without duplicating it
- docs: remove redundant Memory (agenr) AGENTS.md block from OPENCLAW.md -- OpenClaw plugin handles agent instruction injection automatically via the built-in skill

## [0.7.9] - 2026-02-20

### Fixed
- fix(openclaw-plugin): moved session-start recall injection from before_agent_start to before_prompt_build -- recall now fires exactly once per session instead of twice due to OpenClaw calling before_agent_start twice (once for model-resolve where prependContext is discarded, once for prompt-build where it is used)

## [0.7.8] - 2026-02-20

### Fixed
- fix(openclaw-plugin): session-start recall dedup now keys on sessionId instead of a shared seen-Set -- each new session (including after /new) correctly receives injected context instead of being silently skipped on the second run
- fix(extractor): normalizeImportance now defaults to 7 instead of 5 -- aligns runtime default with schema declaration and coaching guidance


## [0.7.7] - 2026-02-20

### Fixed
- fix(extractor): rewrote importance score calibration in SYSTEM_PROMPT -- per-score definitions (5-10) replace undifferentiated 8-10 band
- fix(extractor): added signal-cost framing -- 8+ fires real-time cross-session alerts; prompt now uses this as conservative filter
- fix(extractor): made score 7 the explicit default workhorse; 8+ now requires cross-session justification
- fix(extractor): added dev-session-observations rule -- verified/tested/confirmed patterns cap at 6 unless result is surprising or breaking
- fix(extractor): resolved conflict between dev-session cap and explicit memory request rule ("remember this" overrides cap)
- fix(extractor): removed "verified again today" from score-8 pnpm example to avoid contradicting dev-session rule
- fix(extractor): added NOT-8 negative examples alongside existing NOT-9 callouts
- fix(extractor): added 3 non-developer few-shot examples (health at 8, personal at 7, preference at 6) to prevent domain bias
- fix(extractor): lowered 8+ calibration cap from 30% to 20%

## [0.7.6] - 2026-02-20

### Fixed
- fix(plugin): `agenr_recall` now passes query as a positional argument instead of unsupported `--query`
- fix(plugin): `agenr_recall` now uses `--type` (singular) instead of invalid `--types`
- fix(plugin): removed unsupported `--threshold` forwarding from `agenr_recall`; threshold has no direct CLI equivalent
- fix(plugin): `agenr_store` now sends entries array directly on stdin and passes `platform`/`project` as CLI flags
- fix(plugin): `agenr_store` now infers missing `subject` from `content` before CLI spawn, matching MCP server behavior
- fix(plugin): `agenr_retire` now calls `agenr retire --id <entry_id>` instead of subject matching with UUIDs
- fix(cli): `agenr retire` now supports `--id <id>` and enforces exactly one of subject or `--id`
- fix(plugin): `agenr_extract` now uses a two-step flow for `store=true` (`extract --json` then `store`) and injects source metadata before storing
- fix(cli): `agenr store` now accepts the `--aggressive` flag used by plugin dedup config forwarding

## [0.7.5] - 2026-02-20

### Changed
- fix(plugin): raise default signalMinImportance from 7 to 8 - default-importance stores (importance 7) no longer trigger mid-session signal interrupts
- fix(plugin): lower default maxPerSignal from 5 to 3 - smaller batches
- fix(dedup): lower DEFAULT_DEDUP_THRESHOLD from 0.80 to 0.72 - entries with cosine similarity 0.72-0.80 now reach LLM review instead of being stored as duplicates
- fix(extractor): increase MAX_PREFETCH_RESULTS from 3 to 5 and lower PREFETCH_SIMILARITY_THRESHOLD from 0.78 to 0.72
- fix(extractor): increase PREFETCH_CANDIDATE_LIMIT from 10 to 15 for broader elaborative encoding candidates
- fix(extractor): tighten extractor prompt to suppress near-variant entries already captured in DB
- fix(extractor): recalibrate importance scoring anchors so routine verifications and test-pass observations default to 6-7; reserve 8+ for cross-session alert-worthy updates

### Added
- feat(plugin): signalCooldownMs config - minimum ms between signal batches per session (default: 30000)
- feat(plugin): signalMaxPerSession config - max total signal batches per session lifetime (default: 10)
- feat(plugin): signalMaxAgeSec config - only surface entries created within last N seconds (default: 300)
- feat(dedup): dedup.aggressive config in ~/.agenr/config.json - lower thresholds and more candidate lookups for high-noise environments
- feat(dedup): dedup.threshold config - manual override for LLM dedup similarity threshold

## [0.7.4] - 2026-02-20

### Added
- feat(plugin): native agenr_recall, agenr_store, agenr_extract, agenr_retire tools registered via api.registerTool() in the OpenClaw plugin - tools now appear in the agent toolset alongside exec, browser, etc.

## [0.7.3] - 2026-02-20

### Added
- feat(plugin): bundled OpenClaw skill (skills/SKILL.md) - teaches agents when to call agenr_store and agenr_recall as MCP tools; automatically available when plugin is installed
- feat(plugin): complete configSchema in openclaw.plugin.json (signalMinImportance, signalMaxPerSignal, signalsEnabled, dbPath)

### Changed
- fix(init): removed AGENTS.md auto-detection heuristic for openclaw platform - openclaw must be specified explicitly via --platform openclaw (AGENTS.md is also used by Codex; the heuristic was unreliable)
- fix(init): agenr init --platform openclaw no longer writes to AGENTS.md - the OpenClaw plugin handles memory injection via prependContext; AGENTS.md write was redundant

### Internal
- chore(plugin): bump openclaw.plugin.json version to 0.7.3

## [0.7.2] - 2026-02-20

### Fixed
- fix(store): within-batch deduplication - entries with the same subject+type+source file in a single storeEntries() call are now deduplicated before processing, preventing same-batch signal duplicates (entries from different source files with the same subject are kept as distinct)
- fix(store): re-extraction guard - entries with the same subject+type+source_file extracted within 24 hours now increment confirmations instead of adding a new entry
- fix(mcp): append-only MCP access log at ~/.agenr/mcp-access.log for observability of agenr_recall and agenr_store tool calls

## [0.7.1] - 2026-02-20

### Added
- feat(init): new `agenr init` command to auto-wire project instructions, MCP config, and `.agenr/config.json` with project slug/platform/projectDir
- feat(init): `--depends-on` support for dependency-aware project recall scope in `.agenr/config.json`

### Changed
- feat(mcp): default `agenr_recall` scope now reads `AGENR_PROJECT_DIR` + `.agenr/config.json` per call and auto-includes direct dependencies when `project` is omitted
- feat(mcp): `project="*"` now bypasses configured project scope, while explicit `project` values stay strict (no dependency expansion)
- feat(mcp): default `agenr_store` project now comes from configured project scope when caller omits `project`
- docs: corrected setup guidance in `docs/guides/scenarios.md` and aligned MCP examples in `docs/MCP.md` with current init output

### Removed
- perf(mcp): removed public `since_seq` parameter/handler from `agenr_recall`
- perf(plugin): removed redundant OpenClaw `writeAgenrMd` write path (session-start context is still injected via `prependContext`)
- perf(signals): removed extra `agenr_recall` footer from signal notifications for lower token overhead

## [0.7.0] - 2026-02-19

### Added
- feat(signals): mid-session signal delivery via `before_prompt_build` hook - notifies agents of new high-importance entries (imp >= 7) with compact 50-100 token notifications
- feat(signals): `signal_watermarks` table for per-consumer rowid-based watermark tracking
- feat(mcp): `since_seq` parameter on `agenr_recall` for watermark-based incremental recall without embedding cost
- feat(plugin): `signalsEnabled`, `signalMinImportance`, `signalMaxPerSignal`, and `dbPath` plugin config options

### Changed
- refactor(plugin): plugin now opens a direct DB connection for sub-ms signal queries (vs CLI spawn)
- refactor(plugin/types): expanded `PluginApi` and `AgenrPluginConfig` types for signal support

## [0.6.15] - 2026-02-19

### Changed
- perf(db): file-backed DB clients now set `PRAGMA busy_timeout=3000` during WAL initialization, reducing immediate `SQLITE_BUSY` failures under write contention
- perf(db): `initDb()` now explicitly sets `PRAGMA wal_autocheckpoint=1000` for WAL-enabled clients to make checkpoint behavior explicit and testable
- perf(watch): watcher now supports `walCheckpointIntervalMs` (default `30000`) to rate-limit per-cycle WAL checkpoints while keeping shutdown checkpoint behavior unchanged

### Fixed
- test(watch): updated per-cycle checkpoint tests to pass `walCheckpointIntervalMs: 0` when asserting legacy always-checkpoint behavior
- test(db): added coverage for file-backed `busy_timeout`, explicit `wal_autocheckpoint`, and `:memory:` busy-timeout exclusion
- test(watch): added interval-gating, shutdown-checkpoint, and sentinel-bypass coverage for WAL checkpoint scheduling

## [0.6.14] - 2026-02-19

### Fixed
- fix(daemon): launchd plist now uses `KeepAlive` with `Crashed`-only semantics and `ThrottleInterval` of 10 seconds so intentional daemon stops do not auto-restart while crash recovery remains enabled

## [0.6.13] - 2026-02-19

### Added
- feat(daemon): `agenr daemon status` now includes watcher health details from `watcher.health.json` (heartbeat age, stalled warning, sessions watched, entries stored)

### Changed
- test(daemon): added daemon status health coverage for fresh/missing/stale/error health scenarios and deterministic heartbeat age output

### Fixed
- fix(consolidate): corrected `@libsql/client` arg typing in scoped filter paths by using `InValue[]` for SQL args
- fix(daemon): status command now handles health read failures gracefully and still exits successfully

## [0.6.12] - 2026-02-19

### Added
- feat(watch): new `src/watch/health.ts` heartbeat support with `WatcherHealth` schema, atomic `watcher.health.json` writes, resilient reads, and `isHealthy()` stale-heartbeat checks (5 minute threshold)
- feat(watch): `runWatcher` now writes heartbeat health snapshots on startup and after every cycle, including PID, start time, last heartbeat timestamp, sessions watched, and total entries stored
- feat(watch): directory-mode session switch events now increment `sessionsWatched` (including initial `null -> first` activation)

### Changed
- chore(watch): injected `writeHealthFileFn` dependency in watcher and watch command paths to keep heartbeat writes testable and mockable
- test(watch): added `tests/watch/health.test.ts` (10 tests) and new watcher heartbeat assertion coverage in `tests/watch/watcher.test.ts`

## [0.6.11] - 2026-02-19

### Fixed
- fix(shutdown): SIGINT/SIGTERM now wake the watcher immediately via a shared wake callback, so long polling sleeps are interrupted without waiting for the next interval
- fix(watch): watcher now registers and always deregisters the shutdown wake callback in `runWatcher`, preventing stale wake handlers across normal exits (`--once`) and repeated runs
- fix(watch): `runWatchCommand` now executes registered shutdown handlers on signal-triggered exits, keeps direct PID cleanup for clean `--once` exits, and adds a 5s force-exit timeout guard (`.unref()`) to avoid indefinite hangs

## [0.6.10] - 2026-02-19

### Fixed
- OpenClaw plugin: AGENR.md now writes a compact summary (subjects only + entry count + recall instructions) instead of full content, preventing double-injection of full context if loaded into Project Context
- Note: version 0.6.9 was published with a stale build and unpublished; 0.6.10 is the correct release of these changes

## [0.6.9] - 2026-02-19

### Fixed
- OpenClaw plugin: session-seen guard prevents recall firing on every turn (fires once per session)
- OpenClaw plugin: sessionKey now read from ctx (second handler arg) instead of event
- OpenClaw plugin: DEFAULT_AGENR_PATH uses correct 2-level relative path to dist/cli.js
- OpenClaw plugin: spawn strategy detects .js vs executable binary

### Added
- OpenClaw plugin: writes AGENR.md to ctx.workspaceDir after successful recall (fire-and-forget)

## [0.6.8] - 2026-02-19

### Fixed
- fix(openclaw-plugin): OpenClaw plugin now uses api.on("before_agent_start") instead of api.registerHook("agent:bootstrap"). The previous approach registered the handler in the gateway bundle's internal handlers map, which is a different module instance from the embedded agent runner. The typed hook system (api.on) uses the shared global plugin registry and works correctly across both bundles.

## [0.6.7] - 2026-02-19

### Fixed
- fix(openclaw-plugin): add name and description to registerHook opts to resolve OpenClaw hook registration warning

## [0.6.6] - 2026-02-19

### Added
- feat(openclaw-plugin): OpenClaw plugin that injects agenr memory into agent sessions
  - New src/openclaw-plugin/index.ts: plugin entry point, registers agent:bootstrap hook
  - New src/openclaw-plugin/recall.ts: runs agenr CLI recall, formats JSON as markdown
  - New src/openclaw-plugin/types.ts: local type aliases for OpenClaw SDK compatibility
  - Memory injected as synthetic AGENR.md file into # Project Context in system prompt
  - Grouped markdown output: Active Todos / Preferences and Decisions / Facts and Events
  - Skips subagent and cron sessions automatically (sessionKey pattern check)
  - Configurable: agenrPath, budget, enabled via openclaw.json plugins.entries.agenr.config
  - 5 second timeout on recall; all errors swallowed silently to never block session start
  - package.json "openclaw" key declares dist/openclaw-plugin/index.js as plugin extension

## [0.6.5] - 2026-02-19

### Added
- feat(watch): watcher writes watcher.pid on start and deletes on exit
- feat(ingest): ingest exits 1 with clear error if watcher is running
- feat(watch): isWatcherRunning() helper with stale-PID detection in src/watch/pid.ts
- feat(watch): deleteWatcherPid registered via onShutdown() as v0.6.6 graceful shutdown hook point

### Fixed
- fix(ingest): write conflicts between ingest and watcher are now blocked at the ingest entry point
- fix(watch): watcher PID write failures now use error-level formatting for consistent clack error output
- fix(ingest): watcher-running guard now reports via clack error output instead of raw stderr text

## [0.6.4] - 2026-02-19

### Added
- feat(recall): spaced repetition recall strength via recall_intervals tracking
- feat(recall): computeSpacingFactor() rewards entries with proven long inter-recall gaps
- feat(schema): recall_intervals column (TEXT/JSON) added via COLUMN_MIGRATIONS
- feat(types): recall_intervals field on StoredEntry, spacing field on RecallResult.scores

### Fixed
- fix(recall): legacy spacing imputation now anchors at created_at and lands exactly on last_recalled_at (including recall_count=1), restoring expected spacing bonuses
- fix(recall): spacingFactor now applies to the recall-base component before importance comparison, preventing early saturation while keeping memoryStrength clamped to <= 1.0
- fix(recall): updateRecallMetadata uses json_insert SQLite built-in for atomic array append, avoiding read-modify-write concurrency race
- fix(recall): recall_intervals timestamps stored as Unix integer seconds (not ISO string) to prevent x1000 unit error in gap calculations
- fix(recall): removed unused getScoreComponents() refactor artifact to avoid divergence from the active scoring path
- fix(db): VACUUM database after db reset to reclaim freed pages immediately

## [0.6.3] - 2026-02-19

### Added
- agenr db reset --full --confirm-reset: full clean-slate reset
  - Deletes watch-state.json and review-queue.json after DB schema reset
  - Creates a pre-reset DB backup before any destructive operation
  - Prints backup path to stdout
  - Dry-run mode when --confirm-reset is omitted
- Extracted resetDb() into src/db/schema.ts (shared by db reset and db reset --full)
- Added backupDb() helper in src/db/client.ts

## [0.6.2] - 2026-02-19

### Added
- feat(extractor): elaborative encoding pre-fetch now runs before each chunk extraction, retrieves top-related memories from the vector index, and injects up to 3 references into the extractor prompt
- feat(cli): `--no-pre-fetch` flag added to `agenr extract`, `agenr ingest`, and `agenr watch` to opt out of prompt memory pre-fetch
- feat(cli): `--db` flag added to `agenr extract`, `agenr ingest`, and `agenr watch` for database path overrides
- feat(recall): exported `fetchRelatedEntries()` thin wrapper for direct ANN vector candidate queries

### Changed
- tuning(extractor): pre-fetch similarity threshold set to `0.78` for `text-embedding-3-small` (1024 dimensions)
- tuning(extractor): fresh-install pre-fetch skip threshold set to 20 non-superseded entries
- tuning(extractor): pre-fetch timeout set to 5000ms to avoid chunk extraction stalls on hanging embedding calls

### Security
- prompt: injected related memories are explicitly reference-only and do not lower the SKIP threshold
- runtime: pre-fetch is always best-effort and silently degrades to empty related-memory context on any error

## [0.6.1] - 2026-02-19

### Fixed
- fix(watch): context file generation failed with CLIENT_CLOSED when context path is configured
- fix(mcp): remove agenr_done tool (was not removed in v0.6.0 as intended)

## [0.6.0] - 2026-02-18

### Added
- feat(consolidate): forgettingScore, protected subject patterns, and active forgetting pass with `--forget` deletion gate
- feat(config): `forgetting.protect` never-forget registry plus `scoreThreshold`/`maxAgeDays`/`enabled` config defaults
- feat(health): new `agenr health` command with read-only DB health and forgetting candidate summaries
- feat(consolidate): `--report` pre-run consolidation stats mode (and report-only behavior with `--dry-run`)
- feat(watch): `context-mini.md` and `context-hot.md` context variants on watch context refresh
- feat(schema): retired, retired_at, retired_reason, suppressed_contexts columns
- feat(recall): session-start context filtering respects suppressed_contexts
- feat(db): retirements.json ledger for durable retirement across re-ingest
- feat(mcp): entry IDs in agenr_recall output
- feat(mcp): agenr_retire tool - retire any entry type by ID
- feat(cli): agenr retire command with dry-run, persist, contains flags

### Fixed
- fix(health): initialize schema before health queries and support `--db` path override
- fix(health): reduce scan memory usage by omitting `content` from health stats query
- fix(consolidate): batch forgetting deletes, reuse assessed candidates, and avoid synchronous full `VACUUM`
- fix(watch): use real recall score breakdown in generated context variants

### Removed
- `agenr_done` MCP tool removed; use `agenr_retire` instead (supports all entry types, not just todos)

## [0.5.4] - 2026-02-18

### Added
- feat(todos): `agenr todo done` command to mark todos complete via CLI
- feat(mcp): `agenr_done` MCP tool for completing todos from AI tools
- feat(store): cross-type superseding - new entries can supersede entries of any type, not just same-type

## [0.5.3] - 2026-02-18

### Added
- Explicit memory requests: "remember this/that" triggers importance >= 7, deterministic capture
- Session label → project mapping via `labelProjectMap` config field
- `normalizeLabel` utility for deterministic label normalization
- `SYSTEM_PROMPT` exported from `src/extractor.ts` for testability

### Fixed
- `agenr eval recall` now returns correct results for all 5 query categories (was returning zero for 4 of 5 due to FTS literal match; replaced with SQL type filters and hybrid vector+FTS recall)

## [0.5.2] - 2026-02-18

### Added
- `entries.project` column (with index) to tag knowledge by source project/repo (NULL for legacy entries)
- Project auto-detection from transcript CWD in watch mode (tags entries at write time)
- `--project` and `--exclude-project` filters/tags across commands:
  - `agenr recall --project/--exclude-project [--strict]`
  - `agenr context --project/--exclude-project [--strict]`
  - `agenr store --project`
  - `agenr ingest --project`
  - `agenr consolidate --project/--exclude-project` (never merges across projects)
  - `agenr db stats --project/--exclude-project`
  - `agenr db export --project/--exclude-project`
- MCP tool support for project:
  - `agenr_recall` accepts optional `project` filter (comma-separated for multiple)
  - `agenr_store` accepts optional `project` tag
- `agenr eval recall` command for scoring regression checks (baseline save and compare)

### Fixed
- Recall scoring and session-start recall:
  - Freshness boost for importance >= 6 (clamped to avoid amplifying noisy entries)
  - Smooth exponential todo staleness decay (half-life 7 days; floors at 0.10 or 0.40 for importance >= 8)
  - Session-start permanent window widened to 30 days (temporary remains shorter)
  - Dynamic budget allocation based on available categories
  - Recency tiebreaking within a 0.05 score dead-band applied to the recent category only
- Watch ingestion now advances `byteOffset` by bytes actually read in each cycle, preventing duplicate processing when files grow during read.
- Watch state saves are now atomic (temp file + rename), preventing partial-write corruption on process crashes.

## [0.5.0] - 2026-02-17

### Added
- `_meta` table with schema version stamp for future migrations
- `agenr db version` command to print schema version metadata
- `agenr daemon start|stop|restart` commands
- `agenr daemon install --dir/--platform/--node-path` options for explicit daemon configuration
- `entries.platform` column (with index) to tag knowledge by platform (`openclaw|claude-code|codex`, NULL for legacy entries)
- `--platform` filters/tags across commands:
  - `agenr recall --platform`
  - `agenr context --platform`
  - `agenr store --platform`
  - `agenr ingest --platform`
  - `agenr consolidate --platform`
  - `agenr db export --platform`
- MCP tool support for platform:
  - `agenr_recall` accepts optional `platform` filter
  - `agenr_store` accepts optional `platform` tag

### Changed
- `agenr db stats` output now includes schema version
- `agenr db stats` now includes per-platform breakdown
- `agenr daemon install` now uses smart platform defaults and writes `watch --dir <path> --platform <name>` instead of `watch --auto`
- `agenr daemon install` now prefers stable node symlinks (Homebrew) when `process.execPath` is version-specific; use `--node-path` to override
- `agenr watch --auto` is deprecated; `agenr watch --platform <name>` is now the standard invocation and auto-resolves the default platform directory when `--dir` is omitted

## [0.4.1] - 2026-02-17

### Fixed
- npx symlink handling: isDirectRun check now uses realpathSync to resolve npx symlinks correctly

## [0.4.0] - 2026-02-15

### Added
- `agenr context` command - generate context files for AI tool integration
- `agenr watch --context` - auto-refresh context file after each extraction cycle
- `agenr daemon` - launchd daemon management for background watching
- `agenr consolidate` - knowledge base cleanup with rule-based and LLM-assisted merging
- Online dedup at write time (mem0-style dedup with 3 cosine bands)
- Post-extraction LLM dedup pass
- Concurrent chunk extraction
- Smart filtering before chunking
- Rate limit protection for chunk extraction
- Graceful shutdown for long-running commands (SIGINT/SIGTERM)
- Ingest auto-retry for failed files
- Source adapter refactor with timestamp preservation
- Watch WAL checkpointing

### Changed
- Embedding dimensions upgraded from 512 to 1024 (text-embedding-3-small)
- `confidence` field renamed to `importance` for clarity

### Fixed
- Session-start recall no longer dominated by stale todos (todo staleness penalty)
- Consolidate releases DB lock after WAL checkpoint, not before

## [0.3.0] - 2026-02-15

### Added
- `agenr watch` - live file watcher with auto-extraction
- `agenr ingest` - bulk ingestion of markdown, plaintext, and JSONL
- `agenr mcp` - MCP server for cross-tool AI memory (recall, store, extract)

## [0.2.0] - 2026-02-14

### Added
- `agenr store` - smart dedup with cosine similarity bands
- `agenr recall` - recall with scoring and budget-constrained retrieval
- `agenr db` subcommands (stats, export, reset, path)

## [0.1.0] - 2026-02-14

### Added
- `agenr extract` - structured knowledge extraction from conversation transcripts
- `agenr setup` - interactive configuration
- `agenr auth status` - live connection testing
- `agenr config` - configuration management
