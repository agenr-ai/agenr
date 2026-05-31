# Procedures

Procedures are agenr's durable how-to memory layer. Entries capture reusable facts and decisions. Episodes capture what happened in a session. Procedures capture the canonical method for doing something in this repository or runtime.

Implemented behavior today:

- procedures are authored in repo-owned YAML under `procedures/`
- `agenr ingest procedures [path]` validates and syncs them into the database
- the database stores canonical normalized procedure revisions plus recall text and optional embeddings
- `src/app/procedures/recall/` provides a dedicated internal procedure recall pipeline
- `src/app/recall/` can route generic how-to and checklist-style asks into `procedures`
- host-plugin `agenr_recall` can return a structured canonical procedure answer plus supporting entries and episodes
- automatic before-turn prompting in OpenClaw and Skeln can proactively surface one canonical procedure suggestion when the current turn is a strong how-to match
- the app-layer recall-eval runtime can seed procedure fixtures and assert canonical unified procedure answers

That means procedures now have both a dedicated read path and a live unified read path for host plugins and eval-driven callers. The standalone CLI `agenr recall` command still targets entry recall only.

## Procedures vs Other Memory

| Dimension                    | Entries                                     | Episodes                       | Procedures                                        |
| ---------------------------- | ------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Main question                | What is true?                               | What happened?                 | How do I do this?                                 |
| Granularity                  | Atomic durable knowledge                    | One summary per session        | One authored workflow per task                    |
| Source of truth              | Extracted or tool-supplied structured input | Generated session summaries    | Repo-authored YAML                                |
| Runtime form                 | Stored entry rows                           | Stored episode rows            | Stored normalized procedure revisions             |
| Current public write path    | `agenr ingest entries <path>` and tools     | `agenr ingest episodes [path]` | `agenr ingest procedures [path]`                  |
| Current public recall path   | Live                                        | Live                           | Live via unified host-plugin recall and eval seam |
| Current internal recall path | Core + unified recall                       | Unified recall                 | Dedicated app-layer recall plus unified routing   |

## Code Map

- `procedures/` - repo-authored YAML procedure corpus
- `src/core/types.ts` - canonical procedure, step, condition, and source types
- `src/core/procedures/validation.ts` - strict YAML parsing helpers and field validation
- `src/core/procedures/normalization.ts` - canonical normalization and unknown-field rejection
- `src/core/procedures/hashing.ts` - deterministic `source_hash` and `revision_hash`
- `src/core/procedures/recall-text.ts` - deterministic flattened `recall_text`
- `src/core/ports.ts` - `ProcedureDatabasePort`
- `src/adapters/db/schema.ts` - `procedures` table, `procedures_fts`, and active-key constraints
- `src/adapters/db/procedure-queries.ts` - procedure persistence and active lookup queries
- `src/adapters/files/procedure-files.ts` - local YAML discovery and raw file reads
- `src/app/procedures/sync/` - prepare and execute sync workflow
- `src/app/procedures/recall/` - dedicated procedure retrieval and canonical-match selection
- `src/app/recall/` - unified routing that can include procedures alongside entries and episodes
- `src/adapters/openclaw/tools/recall.ts` - `agenr_recall` tool wiring for procedure-aware unified recall
- `src/adapters/openclaw/tools/shared.ts` - structured procedure formatter for OpenClaw recall output
- `src/app/evals/recall/` - unified eval seeding and assertions for procedure-aware recall cases
- `src/cli/commands/ingest-procedures.ts` - `agenr ingest procedures [path]`
- `tests/core/procedures/normalization.test.ts` - core parse and normalization coverage
- `tests/app/procedures/sync/service.test.ts` - sync planning and execution coverage
- `tests/app/procedures/recall/service.test.ts` - dedicated procedure recall coverage
- `tests/app/recall/unified.test.ts` - unified routing coverage for generic procedural asks
- `tests/adapters/openclaw/tools.test.ts` - OpenClaw procedure formatting and routing coverage
- `tests/app/evals/recall/run-recall-eval-case.test.ts` - unified eval coverage for canonical procedure answers

## Current CLI Surface

```bash
agenr ingest procedures [path] [--dry-run] [--verbose]
```

Current behavior:

- default path is repo-root `procedures/`
- `--dry-run` performs discovery, parsing, normalization, and diff planning without embedding calls or database writes
- `--verbose` prints per-file plan and execution details
- real execution requires embeddings to be configured and available
- invalid procedure files block real writes

This command is the canonical sync path for procedural memory.

## Current Live Read Surfaces

Procedures are now live through these read surfaces:

- `src/app/procedures/recall/service.ts` exposes dedicated procedure retrieval for app-layer callers
- host-plugin `agenr_recall` with `mode=auto` can route generic procedural asks into `procedures`
- host-plugin `agenr_recall` with `mode=procedures` forces procedural recall
- unified recall can return one canonical procedure plus supporting entries and episodes for mixed asks
- OpenClaw `before_prompt_build` and Skeln `before_agent_start` can surface one proactive canonical procedure suggestion through `src/app/before-turn/service.ts`
- the app-layer recall-eval runtime can provision `procedurePool` fixtures for unified-path tests

Current routing semantics:

- explicit `mode=procedures` bypasses auto routing
- auto routing uses generic procedural phrasing such as how-to, steps, method, checklist, and walkthrough asks
- routing does not rely on narrow corpus-specific keywords like release, publish, or review
- the dedicated procedure service still decides whether a canonical top procedure is stable enough to return
- before-turn suggestion uses the same canonical stability rules rather than a looser prompt-time shortcut

## Authoring Surface

Procedures are authored as YAML documents whose field names intentionally match the stored normalized JSON shape.

Current top-level fields:

- `procedure_key`
- `title`
- `goal`
- `when_to_use`
- `when_not_to_use`
- `prerequisites`
- `steps`
- `verification`
- `failure_modes`
- `sources`

Unknown fields are rejected. Duplicate YAML keys are rejected. Duplicate step IDs are rejected.

### Step kinds

Current supported step kinds are:

- `run_command`
- `read_reference`
- `inspect_state`
- `edit_file`
- `ask_user`
- `invoke_tool`
- `verify`

These step kinds are descriptive and structured. They are not a promise that agenr executes procedures automatically at runtime.

### Condition kinds

Current supported condition kinds are:

- `harness_is`
- `tool_available`
- `file_exists`
- `path_exists`
- `env_flag`
- `repo_state`
- `user_confirmed`

Conditions are allowed on per-step `conditions` and `stop_if`.

### Source kinds

Current provenance source kinds are:

- `skill`
- `doc`
- `entry`
- `episode`
- `repo_file`
- `manual`

The repo corpus is explicitly sourced. Agenr does not auto-mine procedure provenance yet.

## Stored Procedure Shape

The normalized stored procedure revision is defined by `Procedure` in `src/core/types.ts`.

Important fields:

- identity: `id`, `procedure_key`, `title`
- authored body: `goal`, `when_to_use`, `when_not_to_use`, `prerequisites`, `steps`, `verification`, `failure_modes`, `sources`
- derived storage fields: `recall_text`, `revision_hash`, `source_hash`
- provenance and lifecycle: `source_file`, `retired`, `retired_at`, `retired_reason`, `superseded_by`, `created_at`, `updated_at`
- retrieval support: optional `embedding`

The database stores procedures in a dedicated `procedures` table, not in `entries`.

Current storage rules:

- only one active row may exist per `procedure_key`
- active means not retired and not superseded
- `procedures_fts` indexes active procedure `title` and `recall_text`
- the procedure vector index supports optional semantic reranking for dedicated procedure recall

## Sync Pipeline

The sync workflow is split into a pure plan step and an execution step.

### 1. Discovery

`src/adapters/files/procedure-files.ts` accepts:

- one `.yaml` or `.yml` file
- a directory tree, discovered recursively

Returned file paths are absolute and lexicographically sorted.

### 2. Parse and normalize

Each file is read as UTF-8 and normalized through `parseAndNormalizeProcedureYaml()`.

Derived artifacts:

- `source_hash` from the exact raw YAML source
- `revision_hash` from the canonical normalized procedure body
- `recall_text` from the deterministic flattened renderer

### 3. Plan classification

`prepareProcedureSync()` classifies each discovered file into one of these buckets:

- `create` - no active stored revision exists for this `procedure_key`
- `update_source_only` - normalized body is unchanged, but the raw authored source changed
- `supersede` - normalized body changed and a new revision is required
- `unchanged` - active stored revision already matches this file
- `invalid` - parse, normalization, or duplicate-key planning failed

Duplicate `procedure_key` values inside the same discovered corpus are treated as invalid planning outcomes before any write step runs.

### 4. Execution

`executeProcedureSync()` only embeds planned `create` and `supersede` items.

Current write behavior:

- `create` writes a new active procedure row
- `update_source_only` updates the existing row in place and preserves row identity
- `supersede` writes a staged replacement row, marks the old active row as superseded, then activates the replacement
- `unchanged` emits a no-op execution result

This staged supersession flow exists because the schema enforces one active row per `procedure_key`.

## Important Current Semantics

### Dedicated procedure recall is the retrieval engine

`runProcedureRecall()` under `src/app/procedures/recall/` is the retrieval backend that unified recall calls when it routes into procedures.

Current read-side behavior:

- retrieval is FTS-first over active procedures
- query embeddings are optional and only enable vector reranking when available
- embedding or vector-search failures degrade to lexical-only ranking instead of failing the full recall path
- callers receive ranked candidates plus one canonical top procedure only when the leader clears conservative thresholding and separation rules

This service is intentionally separate from `src/core/recall/search.ts` and does not treat procedures as another `EntryType`. Unified recall calls into it as a sibling backend, not as a variant of entry recall.

### Source-only updates do not create new revisions

If formatting or other non-semantic authoring changes only affect raw YAML and `source_hash`, agenr updates the existing row in place. It does not create a fresh historical revision just because the YAML formatting changed.

### Semantic changes create new revisions

If the normalized body changes, `revision_hash` changes. That is treated as a real procedure revision and results in a supersession write.

### Missing files are not auto-retired

The sync command intentionally does not prune missing procedures. Because the CLI accepts an optional target path, a partial sync must not retire unrelated procedures accidentally.

If prune or delete semantics are needed later, they should arrive through an explicit command or flag.

### Dry runs are cheap

`--dry-run` stops before embeddings and before database writes. That makes it suitable for authoring and review loops without spending embedding budget.

## Current Seed Corpus

The seed procedures are:

- `agenr/release`
- `agenr/surgeon-review`
- `agenr/sandbox-validation`
- `agenr/claim-key-scenario-run`
- `agenr/openclaw-local-plugin-check`

These seed files intentionally pressure-test:

- command-heavy workflows
- review and checklist workflows
- user-confirmation gates
- repo references and docs references
- verification and failure-mode sections

## What Procedures Do Not Do Yet

Current non-goals:

- no dedicated standalone CLI procedure recall command
- no procedure-aware path in the current `agenr recall` CLI command
- no automatic promotion from entries or episodes into procedures
- no procedure composition such as `use_procedure`
- no deletion or prune semantics for missing files
- no direct procedure execution engine

Those remain out of scope for the implemented subsystem.
