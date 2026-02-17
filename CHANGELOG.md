# Changelog

## Unreleased

### Added
- `_meta` table with schema version stamp for future migrations
- `agenr db version` command to print schema version metadata

### Changed
- `agenr db stats` output now includes schema version

## 0.4.0

### Added
- `agenr context` command - generate context files for AI tool integration
- `agenr watch --context` - auto-refresh context file after each extraction cycle
- `agenr daemon` - launchd daemon management for background watching

### Changed
- Embedding dimensions upgraded from 512 to 1024 (text-embedding-3-small)
- `confidence` field renamed to `importance` for clarity

### Fixed
- Session-start recall no longer dominated by stale todos (todo staleness penalty)
- Consolidate releases DB lock after WAL checkpoint, not before

## 0.3.1

### Added
- `agenr consolidate` - knowledge base cleanup with rule-based and LLM-assisted merging

## 0.3.0

### Added
- `agenr watch` - live file watcher with auto-extraction
- `agenr ingest` - bulk ingestion of markdown, plaintext, and JSONL
- `agenr mcp` - MCP server for cross-tool AI memory (recall, store, extract)

## 0.2.0

### Added
- `agenr store` - smart dedup with cosine similarity bands
- `agenr recall` - recall with scoring and budget-constrained retrieval
- `agenr db` subcommands (stats, export, reset, path)

## 0.1.0

### Added
- `agenr extract` - structured knowledge extraction from conversation transcripts
- `agenr setup` - interactive configuration
- `agenr auth status` - live connection testing
- `agenr config` - configuration management
