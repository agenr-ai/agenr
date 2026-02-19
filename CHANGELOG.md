# Changelog

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
