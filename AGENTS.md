# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Memory infrastructure for AI agents. The current system stores durable entries, generates episodic session summaries, runs hybrid entry recall plus time-aware episode recall, exposes a live OpenClaw memory plugin, maintains corpus health through surgeon, and keeps a narrow internal recall-eval HTTP seam for `agenr-evals`.

Claim-key lifecycle management is now a first-class part of the product. Durable memory, surgeon maintenance, and the repo-local claim-key scenario harness all depend on it.

## Stack

- TypeScript, ESM, Node.js 24+
- libsql/SQLite for storage (`@libsql/client`)
- libsql vector indexes for entry and episode embeddings when supported
- OpenAI-compatible embeddings via `text-embedding-3-small` (1024 dims)
- `commander` for CLI argument parsing
- `@clack/prompts` for interactive CLI flows
- `chalk` for CLI output
- `openclaw` for the production host integration
- `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` for surgeon runtime loops
- pnpm (not npm/yarn)
- vitest for tests, tsup for builds, eslint + prettier for validation

## Architecture: Hexagonal (Ports & Adapters)

**The boundary rule still holds: `src/core/` never imports from `src/adapters/`, `src/cli/`, or process-global logging/file-system helpers.** ESLint is expected to keep enforcing that.

Current repository shape:

```text
src/
├── core/
│   ├── types.ts
│   ├── ports.ts
│   ├── claim-key*.ts
│   ├── supersession.ts
│   ├── temporal-validity.ts
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
│   ├── api/
│   ├── config/
│   ├── db/
│   ├── files/
│   ├── openclaw/
│   ├── surgeon/
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

tests/
└── mirrors the major feature areas above
```

The implemented dependency direction is still materially:

`core -> app -> adapters -> cli/plugin`

### Layering rules

- **`core/`** is pure domain logic. No file system, database, HTTP, process-global logging, or `process.exit()`. Configuration must arrive through parameters or ports.
- **`core/types.ts`** remains the canonical home for domain types. **`core/ports.ts`** remains the canonical home for formal core ports.
- **`app/`** coordinates multi-step workflows: durable ingest, episode ingest, unified recall, OpenClaw runtime composition, surgeon execution, the recall-eval seam, and scenario harnesses.
- **`adapters/`** translate external systems into core and app calls. Adapters may depend on `core/` and targeted `app/` services, but should not turn into cross-cutting grab bags.
- **`src/adapters/config/`** owns adapter-boundary config parsing, validation, canonicalization, and resolved defaults.
- **`cli/`** is still thin. Parse args, wire dependencies, invoke app/core services, format output. Do not move workflow logic into command handlers.
- **`src/config.ts`, `src/logger.ts`, `src/ui.ts`, and `src/version.ts`** are shared runtime infrastructure, not domain logic.
- **`src/adapters/openclaw/`** must keep filesystem work async. Use `node:fs/promises`, never sync filesystem helpers.
- **`src/core/`** and **`src/adapters/openclaw/`** must not terminate the host process.
- Env flags must use explicit string comparisons such as `"true"` or `"1"`. Never rely on truthiness of `process.env.*`.

### Recall eval adapter scope guardrails

The internal recall-eval seam under `src/adapters/api/` is intentionally narrow.

1. `agenr` owns only the execution seam for recall evals.
2. `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and benchmark reporting.
3. Keep transport limited to the single internal recall-case HTTP route and its validation contract.
4. Route handlers must stay thin and delegate to app services.
5. `core/` may expose typed execution facts for observability, but must not gain eval-specific logging, file writing, or artifact policy.
6. Do not add eval-only CLI commands as the main transport.
7. Do not add a second eval family, second provisioning mode, or broad memory-management API without explicit design review.
8. Before adding new adapter fields or behaviors, ask whether they belong in `agenr-evals` instead.

### OpenClaw plugin architecture

The OpenClaw runtime lives in `src/adapters/openclaw/` and is packaged by `packages/openclaw-plugin/`. It is still a **translator, not a brain**.

Every piece of plugin code should be one of:

1. **A core call or app workflow call** - `core/store`, `core/recall`, `app/recall/unified`, `app/episode-ingest`, `app/openclaw/runtime`, and similar.
2. **OpenClaw protocol translation** - wiring hooks, tool calls, prompt sections, memory runtime registration, flush plans, and host runtime state into agenr services.
3. **OpenClaw-specific logic** - session identity parsing, `sessions.json` fallbacks, transcript cleanup, recent-session rendering, prompt formatting, store nudges, and embedded-agent helpers.

The test for where logic belongs remains: **would another adapter need the same behavior?** If yes, it belongs in `core/` or `app/`. If it is specific to how OpenClaw structures hooks, sessions, transcripts, or tool flows, it belongs in the plugin.

Current plugin directory shape:

```text
src/adapters/openclaw/
├── index.ts
├── config.ts
├── logging.ts
├── runtime.ts
├── tools.ts
├── types.ts
├── openclaw.plugin.json
├── tools/
├── hooks/
│   ├── before-prompt-build.ts
│   └── after-tool-call.ts
├── session/
│   ├── continuity/
│   ├── identity.ts
│   ├── session-id.ts
│   ├── session-key-parser.ts
│   ├── session-registry.ts
│   ├── sessions-store-reader.ts
│   ├── transcript-files.ts
│   ├── tui-lane.ts
│   └── state.ts
├── transcript/
├── format/
├── episode/
├── memory/
├── llm/
└── embedded-agent/
```

Implemented plugin registration and lifecycle behavior now includes:

- memory prompt-section injection
- memory flush-plan registration
- memory runtime registration
- hooks for `before_prompt_build`, `session_start`, `after_tool_call`, `session_end`, and `gateway_stop`
- tools `agenr_store`, `agenr_recall`, `agenr_retire`, `agenr_update`, and `agenr_trace`
- process-lifetime shared service composition in `src/app/openclaw/runtime.ts`
- session-start injection of active `core` entries
- predecessor resolution through `resumedFrom` and `sessions.json` fallback paths
- continuity summary reads and on-demand generation
- background predecessor episode writing
- mid-session memory-action tracking and store nudges
- transcript normalization shared with durable ingest and episode ingest

The OpenClaw transcript parser is a major seam. It strips host noise, normalizes metadata, summarizes noisy tool results, and produces the cleaned message stream consumed by ingest and episode workflows.

### Why hexagonal?

The core API is still the real product. Adapters translate protocols:

- OpenClaw plugin -> core and app workflows
- internal recall-eval server -> `app/evals/recall/*`
- CLI -> the same core and app workflows
- future host adapters -> the same core and app workflows

Adding a new host should mean writing an adapter, not rewriting the domain.

## Domain model

### Durable entries

`Entry` in `src/core/types.ts` is the canonical durable-memory record.

Current entry characteristics:

- entry types: `fact`, `decision`, `preference`, `lesson`, `relationship`, `milestone`
- expiry levels: `core`, `permanent`, `temporary`
- retirement and explicit supersession fields
- temporal validity via `valid_from` and `valid_to`
- claim-key lifecycle metadata persisted on the row
- project and user scoping metadata

Claim-key lifecycle is a current architectural center of gravity. The main logic lives across:

- `src/core/claim-key.ts`
- `src/core/claim-key-lifecycle.ts`
- `src/core/claim-key-entity-family.ts`
- `src/core/claim-key-slot-resonance.ts`
- `src/core/claim-key-support.ts`
- `src/core/supersession.ts`
- `src/core/temporal-validity.ts`

Implemented claim-key metadata includes:

- canonical `claim_key`
- preserved `claim_key_raw`
- status: `trusted`, `tentative`, `unresolved`
- source: `manual`, `model`, `json_retry`, `deterministic_repair`, `surgeon_metadata_rewrite`, `surgeon_family_reuse`, `surgeon_compaction`
- support provenance fields for where the claim came from and how it was inferred

### Episodes

`Episode` in `src/core/types.ts` is the canonical episodic-memory record.

Current episode characteristics:

- sources: `openclaw`, `codex`, `cli`, `synthesis`
- activity levels: `substantial`, `minimal`, `none`
- stable identity prefers `(source, sourceId)` and falls back to `(source, transcriptHash)`
- summary text, tags, timing, optional embeddings, and lifecycle state
- episodic retrieval is distinct from durable entry recall

### Surgeon runs and proposals

The maintenance subsystem persists:

- `surgeon_runs`
- `surgeon_run_actions`
- `surgeon_run_proposals`

This is no longer just a retirement helper. It records pass or preset execution, token and cost accounting, dry-run versus apply mode, audit trails, and unresolved structural proposals.

## Importance scale (1-10)

The extraction LLM still uses the same broad scale:

- **9-10:** Foundational constraints, identity, core values, critical infrastructure
- **7-8:** Decisions with rationale, strong preferences, recurring lessons, architectural choices
- **5-6:** Verified facts, routine observations, one-time context
- **3-4:** Tentative or uncertain information, ephemeral context
- **1-2:** Barely worth storing

## Storage

Single SQLite or libSQL database. Agenr supports fresh databases and databases already on the current schema version.

Current logical schema version: `8`

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

Current storage characteristics:

- `entries` carries claim-key lifecycle fields, validity windows, supersession metadata, quality and recall tracking, project and user scoping, and retirement state
- `episodes` carries source identity, transcript and summary hashes, timing, summary metadata, embeddings, and lifecycle state
- active entries participate in FTS5 through `entries_fts`
- retired or superseded entries are excluded from active FTS triggers
- entries and episodes both store embeddings as `F32_BLOB(1024)`
- vector indexes are created when the backend supports them, and the code degrades gracefully when it does not
- `_meta` also tracks interrupted bulk-write state and bulk-ingest completion metadata

## Main workflows

### Durable ingest

The durable ingest path spans `src/app/ingestion/`, `src/core/ingestion/`, `src/core/store/`, `src/adapters/files/transcript-files.ts`, and `src/adapters/openclaw/transcript/parser.ts`.

Current behavior includes:

1. Discover transcript files.
2. Skip unchanged files using `ingest_log`.
3. Parse transcripts through a `TranscriptPort`.
4. Extract candidate entries from message-aware transcript chunks.
5. Deduplicate candidates within the ingest batch.
6. Preserve explicit claim keys or derive lifecycle metadata.
7. Validate, hash, embed, and persist entries.
8. Optionally auto-link supersession for eligible claim-key cases.
9. Record ingest-log rows.

Important implementation details:

- whole-file extraction is configurable
- ingest concurrency is configurable
- transcript discovery accepts rotated `.jsonl.reset.*` and `.jsonl.deleted.*` variants
- chunking stays aware of transcript message boundaries
- dedup uses exact and normalized hashes
- large durable ingests use the database bulk-write fast path

### Entry recall

The entry recall engine is implemented across `src/core/recall/*` and `src/adapters/db/recall-adapter.ts`.

Current behavior includes:

- hybrid semantic plus lexical retrieval
- lexical tiers for exact phrase, all-token, and any-token matches
- relevance combined with recency and importance
- optional temporal biasing through `since`, `until`, `around`, and `aroundRadius`
- best-effort recall telemetry written to `recall_events`
- historical-state expansion for queries that appear to ask about previous states

### Unified recall

`runUnifiedRecall()` in `src/app/recall/unified.ts` routes between entries, episodes, or both using actual heuristics in code:

- factual versus narrative phrasing
- resolved temporal windows
- topic anchors
- historical-state language such as "what changed" or "what did we use before"

### Episode ingest and recall

Episode ingest is staged in `src/app/episode-ingest/service/{preflight,plan,execute,backfill}.ts`.

Current behavior includes:

- transcript discovery and cleanup
- session metadata recovery from the OpenClaw session registry when available
- skip logic for already-ingested, too-short, or still-active sessions
- transcript rendering for summarization
- recency filtering and cost estimation
- structured summary generation
- optional episode embedding
- serialized database writes with concurrent model work
- embedding-only backfill for episodes missing vectors

Episode retrieval lives in `src/core/episode/*` and supports temporal-only, semantic-only, and hybrid retrieval with heavier emphasis on temporal overlap and proximity than durable entry recall.

### Surgeon

The surgeon subsystem spans `src/app/surgeon/*`, `src/core/surgeon/*`, `src/adapters/db/surgeon-port.ts`, `src/adapters/db/surgeon-run-log.ts`, and `src/adapters/db/surgeon-queries.ts`.

Implemented passes:

- `claim_key_quality`
- `supersession`
- `retirement`

Implemented presets:

- `claim-key-only`
- `structural`
- `full`

Current safeguards and runtime traits:

- dry-run by default
- per-run and daily cost caps
- context-limit controls
- entry protection thresholds
- optional recall simulation when embeddings are configured
- completion guards
- pre-apply database backups when possible

### Claim-key scenario harness

The repo-local scenario runtime under `src/app/scenarios/claim-keys/` is part of the implemented architecture, not incidental test scaffolding.

It currently:

- loads fixture-backed scenarios from `tests/scenarios/claim-keys/`
- validates scenario roots, typed inputs, and expectation blocks before execution
- loads transcript, extraction, claim-extraction, and seed fixtures through dedicated loaders
- creates isolated sandboxes
- runs ingest, store, or surgeon paths
- captures resulting rows, proposals, warnings, and summaries
- writes artifacts under `.hermes/scenario-artifacts/<runId>/`

## Projects and platforms

Entries still live in one primary namespace. The schema includes optional `project` columns on entries, episodes, and surgeon runs for scoping metadata, but agenr does not maintain separate per-platform stores or a platform-specific memory model.

## Reference codebase

The v0 codebase at `~/Code/agenr-v0` is still available as reference for proven algorithms. Copy algorithms and logic, not architecture.

## Sandbox

Development still uses an isolated sandbox environment:

```text
~/.openclaw-sandbox/
  agenr-data/knowledge.db
  agenr-data/config.json
  .openclaw/agents/main/sessions/
  .openclaw/agents/main/real_seed_sessions_2_days/
```

Useful wrappers and workflows:

- `sandbox-agenr` - run the agenr CLI against the sandbox DB
- `sandbox-openclaw` - run the OpenClaw gateway loading the local plugin build
- `pnpm build` then `sandbox-agenr <command> --verbose`
- inspect DB state with `sqlite3 ~/.openclaw-sandbox/agenr-data/knowledge.db "SELECT ..."`

## CLI commands

Current CLI surface:

```text
agenr init
agenr setup
agenr ingest <path>
agenr ingest entries <path>
agenr ingest episodes [path]
agenr recall <query>
agenr surgeon run
agenr surgeon status
agenr surgeon history
agenr surgeon actions <runId>
agenr scenarios list
agenr scenarios run
agenr db reset
```

Notable command options:

- durable ingest: `--verbose`, `--dry-run`, `--whole-file auto|force|never`, `--skip-dedup`, `--concurrency <n>`
- episode ingest: `--db`, `--recent`, `--regenerate`, `--embed-only`, `--no-embed`, `--dry-run`, `--verbose`, `--concurrency`, `--model`
- recall: `--limit`, `--threshold`, `--budget`, `--types`, `--tags`, `--since`, `--until`, `--around`, `--around-radius`, `--verbose`
- surgeon run: `--pass`, `--preset`, `--project`, `--type`, `--claim-key-prefix`, `--entry-id`, `--include-inactive`, `--budget`, `--context-limit`, `--skip-evaluated-days`, `--apply`, `--model`, `--provider`, `--verbose`, `--trace`, `--json`
- scenarios list/run: `--kind`, `--tag`, `--json`, plus run-specific `--id`, `--preserve-on-failure`, `--preserve`, `--verbose`, `--fail-fast`

OpenClaw also exposes these runtime tools:

```text
agenr_store
agenr_recall
agenr_retire
agenr_update
agenr_trace
```

## Common commands

```bash
pnpm install
pnpm build
pnpm build:debug
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

## Testing

- Run `pnpm check` before committing when code changes are involved
- Tests live in `tests/` and mirror major feature areas
- Core logic is primarily tested with doubles around ports
- Adapters are exercised with focused integration tests
- Claim-key scenarios have dedicated fixture-backed runtime tests
- When fixing a bug, add a regression test

## Code style

- No `any` types
- Errors should be descriptive and actionable
- Keep functions focused
- No em-dashes - use hyphens
- Prefer composition over inheritance
- Use `type` imports where applicable
- Add Google-style JSDoc on exported functions, interfaces, and types
- Follow SOLID principles

## Repo workflow

1. Issue first for non-trivial feature or bug work.
2. Branch from local `master`.
3. Keep `master` linear.
4. Prefer small, reviewable commits.
5. Delete merged branches when they are no longer needed.

## Completion checklist

Before pushing:

- [ ] `pnpm check` passes when the change affects code or runtime behavior
- [ ] Docs updated for user-facing changes
- [ ] No `any` types introduced
- [ ] No em-dashes in modified files
- [ ] Core still has zero imports from adapters
- [ ] New tests for new behavior
