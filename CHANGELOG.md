# Changelog

## Unreleased

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

## 0.5.0 (2026-02-17)

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

## 0.4.1 (2026-02-17)

### Fixed
- npx symlink handling: isDirectRun check now uses realpathSync to resolve npx symlinks correctly

## 0.4.0 (2026-02-15)

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

## 0.3.0 (2026-02-15)

### Added
- `agenr watch` - live file watcher with auto-extraction
- `agenr ingest` - bulk ingestion of markdown, plaintext, and JSONL
- `agenr mcp` - MCP server for cross-tool AI memory (recall, store, extract)

## 0.2.0 (2026-02-14)

### Added
- `agenr store` - smart dedup with cosine similarity bands
- `agenr recall` - recall with scoring and budget-constrained retrieval
- `agenr db` subcommands (stats, export, reset, path)

## 0.1.0 (2026-02-14)

### Added
- `agenr extract` - structured knowledge extraction from conversation transcripts
- `agenr setup` - interactive configuration
- `agenr auth status` - live connection testing
- `agenr config` - configuration management
