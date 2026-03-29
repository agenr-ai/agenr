# Changelog

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
