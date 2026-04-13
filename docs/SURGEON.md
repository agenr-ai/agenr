# Surgeon

The surgeon is agenr's bounded corpus-maintenance subsystem.

As of the current codebase, four surgeon passes are implemented:

- `claim_key_quality` - deterministic claim-key cleanup, backfill, proposal emission, and health reporting
- `proposal_resolution` - deterministic application of already-eligible claim-key proposals
- `supersession` - bounded agent-loop review that links older active entries to their surviving replacements
- `retirement` - bounded agent-loop review that retires or downgrades semantically stale entries conservatively

The goal is corpus health, not aggressive deletion. The surgeon is designed to preserve recall coverage, leave an audit trail, and stop when budgets or completion guards say it should stop.

## Code map

- `src/cli/commands/surgeon.ts` - CLI registration, option validation, final output formatting, and stderr progress rendering
- `src/app/surgeon/runtime.ts` - top-level runtime wiring: config loading, model selection, recall-port creation, DB backup, and status/history/actions loaders
- `src/app/surgeon/service.ts` - run lifecycle for single passes and autonomous runs, budget checks, prompt construction, agent-loop orchestration, and final persistence
- `src/app/surgeon/claim-key-quality.ts` - deterministic `claim_key_quality` workflow
- `src/app/surgeon/budget.ts` - cost and context tracking
- `src/app/surgeon/completion-guard.ts` - pagination and adjudication state for `complete_pass`
- `src/app/surgeon/progress.ts` - structured progress events
- `src/app/surgeon/prompts.ts` - system prompt plus pass-specific prompts
- `src/app/surgeon/trace-logger.ts` - verbose event logging and optional trace-file output
- `src/app/surgeon/tools/*.ts` - tool implementations for `retirement` and `supersession`
- `src/app/surgeon/ports.ts` - `SurgeonPort` interface
- `src/adapters/db/surgeon-port.ts` - DB-backed `SurgeonPort`
- `src/adapters/db/surgeon-queries.ts` - health, candidate, inspection, supersession-cluster, and claim-key-quality working-set queries
- `src/adapters/db/surgeon-run-log.ts` - persisted run, action, and proposal logging
- `src/core/surgeon/domain/protection-rules.ts` - hard retirement protection rules
- `src/core/surgeon/domain/run-presets.ts` - implemented pass types and the autonomous run sequence
- `src/core/surgeon/types.ts` - persisted completion and claim-key-quality summary types
- `src/config.ts` - surgeon defaults and config types

## Runtime shape

`claim_key_quality` and `proposal_resolution` are deterministic. `retirement` and `supersession` still use `@mariozechner/pi-agent-core`'s `runAgentLoop()` with sequential tool execution, but they now run as bounded fresh-context slices instead of one long continuation-heavy conversation.

For every `agenr surgeon run`, agenr currently:

1. Loads config and resolves the database path.
2. Resolves either one explicit `--pass` or the default autonomous sequence.
3. Resolves the surgeon model with this precedence:
   - CLI `--provider` / `--model`
   - `config.surgeon.model`
   - top-level `provider` / `model`
   - fallback `openai` + `gpt-5.4-mini`
4. Resolves LLM credentials.
5. Tries to create embedding-enabled recall ports for `simulate_recall`.
6. Checks the trailing 24-hour surgeon spend against the daily cap.
7. In apply mode, creates one timestamped backup of the SQLite DB plus `-wal` / `-shm` sidecars when present before the first actionable pass mutates the corpus.
8. Loads prior-run context before creating the current `surgeon_runs` row so prompt history points at the previous run, not the in-flight row.
9. Creates a `surgeon_runs` row with status `running` for each executed pass.
10. Executes either:

- one explicit pass, or
- the autonomous sequence `claim_key_quality -> proposal_resolution -> supersession -> retirement`

11. In autonomous mode, repeats later-cycle `proposal_resolution`, `supersession`, and `retirement` work until no direct work remains, a pass stalls, the cycle stops making direct progress, or budget stops the run.
12. Persists final status, usage, cost, action counts, summary JSON, and error text.

Persisted `actions_taken` reflects actual stored non-skip actions, not model-reported `complete_pass` counts. If a pass stalls after already mutating the corpus, the stalled summary says so explicitly.

## Passes

### `claim_key_quality`

`claim_key_quality` does not use the agent loop and does not expose tools. It loads a deterministic working set from `listClaimKeyQualityEntries()` and walks it in bounded stages.

It runs in one of two modes:

- `autonomous` - the default full-corpus cleanup used by the CLI
- `targeted` - an internal targeted selection path retained for non-CLI callers

The current stages are:

- `health`
- `invalid_noncanonical`
- `missing`
- `suspect_canonical`
- `entity_family_convergence`
- `mixed_key_groups`

What the pass does today:

- normalizes clearly noncanonical claim keys in place when safe
- backfills missing claim keys using trusted reuse, deterministic repair, metadata rewrites, and optional claim-extraction previews
- leaves ambiguous cases as durable proposals in `surgeon_run_proposals`
- detects suspect canonical keys and mixed-key family situations
- emits before/after health snapshots plus a structured repair summary

The persisted `summary_json.claim_key_quality` payload includes:

- `executionStyle`
- `workingSet`
- `before`
- `after`
- `projectedAfter` in dry-run mode
- `counts`
- optional `shadowSiblingSlotResonance`
- optional `circuitBreaker`

`claim_key_quality` never retires entries. Its output is structural cleanup plus proposal backlog.

Open proposal backlog is deduplicated by logical issue (`group_id + issue_kind`). When a later run rediscovers the same unresolved issue, agenr refreshes the existing open row instead of appending another backlog item. Applied and rejected proposal rows remain separate history records.

### `proposal_resolution`

`proposal_resolution` does not use the agent loop and does not expose public surgeon tools. It operates only on proposals that are already `open`, `eligible_for_apply`, and resolvable to exactly one target claim key.

The pass:

- returns `no_work` when there is no eligible proposal backlog
- applies eligible proposals conservatively in apply mode using the same claim-key lifecycle update path as manual proposal review
- records `update_entry` audit actions for the affected entries
- returns `stalled` if eligible backlog exists but none of it can be advanced safely

Non-eligible or ambiguous proposals remain on the manual review path.

### `supersession`

`supersession` is an agent-loop pass that reviews active clusters and links older entries to active replacements.

The pass is claim-key first:

- the initial prompt tells the model to sweep `claim_key` clusters first
- continuation prompts keep pushing it to finish the claim-key sweep before widening to `subject`
- completion can be rejected if it widens too early or has not adjudicated enough claim-key work

The current tool surface lets it:

- inspect health and the latest run
- page supersession clusters
- inspect entries and related context
- simulate recall without telemetry
- link supersession
- assign claim keys
- set validity windows
- update importance or expiry
- complete the pass with a structured summary

### `retirement`

`retirement` is an agent-loop pass that pages protected candidate pools and decides whether an entry should be retired or merely downgraded.

Permanent entries are demotion-first. `retire_entry` rejects `expiry = "permanent"` rows, and surgeon must use `update_entry` when the content is still true but should carry less recall weight. Surgeon-driven permanent demotions are bounded at `importance >= 4` so durable facts can be softened without being silently buried.

The current actionable scope is a high-yield subset:

- all `temporary` entries
- low-importance `milestone` entries
- low-importance unrecalled `fact` entries

Candidate ordering still favors:

1. `temporary` entries
2. very low-importance milestones
3. subjects that look like status artifacts
4. never-recalled entries
5. older entries
6. lower-importance entries

The pass can:

- page retirement candidates
- inspect full entry context
- simulate recall without telemetry
- retire entries
- downgrade or otherwise update entries
- complete the pass with a structured summary

Same-run retirement suppression is explicit. Once an entry has been skipped, retired, or updated in the current retirement run, later `query_candidates` calls suppress it and `retire_entry` refuses a second contradictory action.

Retirement now has an explicit preflight. If both actionable and widened all-scope availability are empty after current filters are applied, the pass finalizes as `no_work` without entering the agent loop.

### Recall effect of demotion

Recall scoring combines:

- relevance at `0.50`
- recency at `0.25`
- importance at `0.25`

`importanceScore()` maps the stored `importance` range `1-10` onto `0.4-1.0`, so each one-step importance change moves the normalized importance signal by about `0.0667`. After the `0.25` recall weight is applied, one surgeon demotion step changes the final recall score by about `0.0167` when the other signals stay constant.

That calibration is why the surgeon floor is `importance = 4`: it is enough to reduce prominence over repeated maintenance runs without making durable permanent facts disappear from ranking unless relevance and recency are already weak too.

## Tool surface

Only `retirement` and `supersession` use tools.

### Shared tools

| Tool               | What it does                               | Current details                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_health_stats` | Returns health data for orientation.       | Takes no parameters. Returns `now`, `health`, `lastRun`, and `lastBulkIngestAt`. `health` includes type counts, claim-key lifecycle buckets, proposal backlog, recency, recall, quality, retirement raw actionable count, retirement available actionable count, retirement available all-scope count, and recently-evaluated count.                                |
| `inspect_entry`    | Loads one entry with related context.      | Returns `found`, `entry`, `tags`, and `related`. `related` includes `sameSubject`, `sameCluster`, `supersedesCount`, and `supersedesSample`.                                                                                                                                                                                                                        |
| `simulate_recall`  | Runs normal recall without telemetry.      | Params: `query`, optional `exclude_entry_id`, optional `limit` default `10`, max `20`. Throws if embedding-enabled recall ports are unavailable.                                                                                                                                                                                                                    |
| `update_entry`     | Updates mutable fields on an active entry. | Params: `entry_id`, `reasoning`, and any of `importance`, `expiry`, `claim_key`, `valid_from`, `valid_to`. Claim-key updates go through the shared manual lifecycle normalizer, and temporal updates reject invalid, equal, or reversed timestamps. `expiry: "core"` requires reasoning that explicitly mentions `core`. In dry-run it returns `wouldUpdate: true`. |
| `complete_pass`    | Finalizes the current agent-loop pass.     | Params: `actions_taken`, `entries_skipped`, `observations`, `recommendations`. Runs pass-specific completion guards and can reject shallow completion. Also persists `skip` audit actions from `entries_skipped`.                                                                                                                                                   |

### Retirement-only tools

| Tool               | What it does                                | Current details                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_candidates` | Pages retirement candidates.                | Params: `scope`, `type`, `importance_max`, `min_age_days`, `project`, `limit`, `offset`. `scope` is `actionable` or `all`, default `actionable`. Default page size `20`, max `100`. Results now include `totalMatching`, `availableCount`, `scopeExhausted`, `nextOffset`, and `recentlyEvaluatedFilteredCount`. Empty actionable pages tell the model to widen to `all`. |
| `retire_entry`     | Retires one active entry after hard checks. | Params: `entry_id`, `reason`. Rejects protected entries. In dry-run it returns `wouldRetire: true`.                                                                                                                                                                                                                                                                       |

### Supersession-only tools

| Tool                            | What it does                                        | Current details                                                                                                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_supersession_candidates` | Pages supersession clusters.                        | Params: `scope`, `type`, `limit`, `offset`. `scope` is `claim_key`, `subject`, or `all`, default `claim_key`. Default page size `20`, max `50`. Returns both `claimKeyClusterCount` and `subjectClusterCount`. In the same run, `subject` and `all` stay blocked until the claim-key sweep is exhausted. |
| `link_supersession`             | Links an older active entry to its replacement.     | Params: `old_entry_id`, `new_entry_id`, `kind`, `reason`. Rejects self-links, inactive entries, and hard supersession-rule violations. Allowed kinds are `update`, `correction`, `refinement`, and `duplicate`.                                                                                          |
| `assign_claim_key`              | Assigns or normalizes one active entry's claim key. | Params: `entry_id`, `claim_key`, `reasoning`. Enforces `entity/attribute` format and writes the same trusted manual lifecycle bundle used by other direct update paths. In apply mode it records an `update_entry` action.                                                                               |
| `set_validity`                  | Sets `valid_from` and/or `valid_to`.                | Params: `entry_id`, optional `valid_from`, optional `valid_to`, `reasoning`. Requires at least one timestamp, validates parseability, rejects equal or reversed ranges, and only updates active entries.                                                                                                 |

## Claim-key lifecycle policy

Claim keys are slot identifiers, not truth labels.

The lifecycle buckets currently used by health status and cleanup logic are:

- `trusted`
- `tentative`
- `unresolved`
- `legacy` - canonical `claim_key` exists but lifecycle metadata is still missing
- `noKey`

No-key rows and legacy rows are tracked separately in health output so operators can distinguish "missing a first claim key" from "needs lifecycle backfill."

### Auto-supersession

Store-time auto-supersession remains conservative. It is currently allowed only when all of these are true:

- the accepted claim key is `trusted`
- the claim-key source is `manual`, or a high-confidence `model` / `json_retry` extraction
- exactly one active same-key sibling exists
- normal supersession type-policy checks still pass

Tentative and unresolved claim keys do not trigger auto-supersession.

### Surgeon proposals

`claim_key_quality` records unresolved work in `surgeon_run_proposals` instead of forcing ambiguous rewrites.

These proposals are durable review artifacts with explicit review state. They start as `open`, can later become `applied` or `rejected`, and keep the review note plus applied-action count in the same durable row.

The CLI now exposes:

- backlog counts through `agenr surgeon status`
- a global backlog view through `agenr surgeon backlog`
- run-scoped proposal inspection through `agenr surgeon proposals <runId>`
- explicit operator review through `agenr surgeon review <proposalId> --decision <apply|reject> --reason <text>`

## CLI surface

The surgeon CLI lives under `agenr surgeon`.

Current read-only inspection commands:

- `agenr surgeon status`
- `agenr surgeon history`
- `agenr surgeon backlog`
- `agenr surgeon actions <runId>`
- `agenr surgeon proposals <runId>`

### `agenr surgeon run`

```bash
agenr surgeon run [options]
```

If `--pass` is omitted, `agenr surgeon run` executes the autonomous sequence `claim_key_quality -> proposal_resolution -> supersession -> retirement` and repeats later-cycle `proposal_resolution`, `supersession`, and `retirement` work until no direct work remains, a pass stalls, or budget is exhausted. Autonomous cycling treats an unchanged direct-work surface as no progress even if the model spent tokens, which prevents repeated no-op supersession or proposal-resolution re-entry.

#### Flags

| Flag                        | Meaning                                                                                            | Default                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--pass <type>`             | Run one explicit pass: `retirement`, `supersession`, `proposal_resolution`, or `claim_key_quality` | autonomous multi-pass run                                                            |
| `--budget <usd>`            | Total cost cap for the run                                                                         | `config.surgeon.costCap`, else `15.00`                                               |
| `--context-limit <tokens>`  | Override per-turn context limit tracking                                                           | `config.surgeon.contextLimit`, else 85% of model context window when known, else `0` |
| `--skip-evaluated-days <n>` | Skip entries evaluated within the last `n` days                                                    | `config.surgeon.passes.retirement.skipRecentlyEvaluatedDays`, else `7`               |
| `--apply`                   | Apply mutations instead of dry-run                                                                 | off                                                                                  |
| `--model <id>`              | Override model ID                                                                                  | config/top-level/default resolution                                                  |
| `--provider <name>`         | Override provider                                                                                  | config/top-level/default resolution                                                  |
| `--verbose`                 | Emit richer stderr progress                                                                        | off                                                                                  |
| `--trace <path>`            | Write compact trace JSONL records to a file, or into an existing directory as per-pass files       | none                                                                                 |
| `--json`                    | Emit JSON instead of human-readable final output                                                   | off                                                                                  |

#### Output

Human-readable single-pass `run` output currently looks like:

```text
Surgeon run <run-id>
Pass: retirement
Mode: dry-run | apply
Status: completed | no_work | stalled | failed | aborted | budget_exhausted | cost_capped
Actions: <total> total | retired <n>
Usage: input <n> | output <n> | cost $<amount>
Summary: <summary or n/a>
```

Autonomous output uses:

```text
Surgeon Run (autonomous)
Cycles: <n>
Passes: claim_key_quality -> proposal_resolution -> supersession -> retirement -> ...
...
```

Progress always goes to stderr, including in `--json` mode.

When `--trace` is enabled, the file output is a compact JSONL stream intended for post-run inspection. It keeps user prompts, assistant decisions, tool calls, tool results, surgeon actions, and turn budget summaries while dropping low-signal streaming deltas and large blobs such as embedding vectors.

### `agenr surgeon status`

```bash
agenr surgeon status
```

Current human output includes:

- active entry count
- claim-key lifecycle buckets
- proposal backlog count
- open proposals already eligible to apply
- oldest still-open proposal timestamp when one exists
- retirement candidate availability, including actionable vs all-scope vs raw actionable counts
- latest surgeon run
- latest surgeon cost

### `agenr surgeon backlog`

```bash
agenr surgeon backlog [--state <open|applied|rejected|all>] [--eligible-only] [--issue-kind <kind>] [--entry-id <id>] [--limit <n>] [--offset <n>]
```

This shows proposal rows across runs with:

- proposal ID, issue kind, scope, confidence, review status, and apply eligibility
- originating run pass, status, and dry-run/apply mode
- entry IDs plus proposed claim keys

### `agenr surgeon history`

```bash
agenr surgeon history [--limit <n>]
```

This shows recent persisted runs with:

- `started_at`
- `pass_type`
- `status`
- `dry-run` vs `apply`
- `actions=<n>`
- `cost=$<amount>`

### `agenr surgeon actions <run-id>`

```bash
agenr surgeon actions <run-id>
```

This prints the action audit trail for one run. The CLI currently renders:

- timestamp
- action type
- entry IDs
- reasoning

The DB also persists structured `details_json`, but the CLI does not print it yet.

### `agenr surgeon proposals <runId>`

```bash
agenr surgeon proposals <runId>
```

This prints the proposal trail for one run with:

- `created_at`
- `issue_kind`
- `scope`
- `entry_ids`
- `current_claim_keys` -> `proposed_claim_keys`
- `confidence`
- `eligible_for_apply`
- `review_status`
- `reviewed_at`
- `review_reason`
- `applied_action_count`
- freeform rationale

### `agenr surgeon review <proposalId>`

```bash
agenr surgeon review <proposalId> --decision <apply|reject> --reason <text>
```

Current behavior:

- `--decision apply` uses the existing entry-update path and the canonical surgeon-applied claim-key lifecycle bundle
- apply mode creates a DB backup before mutating a non-memory database
- proposals are only directly applicable when they are still `open`, are flagged `eligible_for_apply`, and resolve to exactly one proposed claim key
- successful application records an `update_entry` surgeon action tied back to the proposal ID
- both apply and reject persist the review decision, review timestamp, review note, and applied-action count on the proposal row

## Progress events

The runtime emits structured progress events through `src/app/surgeon/progress.ts`.

High-level phases:

- `start`
- `backup_start`
- `backup_complete`
- `load_working_set_start`
- `load_working_set_complete`
- `load_pass_context_start`
- `load_pass_context_complete`
- `pass_start`

`claim_key_quality` also emits bounded stage progress snapshots, including preview counters, cumulative repair counts, processed-entry counts, and elapsed time. The CLI turns these into terse stderr lines, with richer detail in `--verbose` mode.

For agent-loop passes, `load_pass_context_complete` now reports the active-entry count plus pass-specific remaining work. That means eligible proposal backlog for `proposal_resolution`, claim-key and subject clusters for `supersession`, and actionable vs widened all-scope retirement counts for `retirement`.

## Budget, completion, and bounded slices

### Cost and context guards

| Guard                  | Source                                                                                 | Default          | Current behavior                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Per-run cost cap       | `--budget`, else `config.surgeon.costCap`                                              | `15.00` USD      | Further non-completion work is blocked once the cap is exceeded.                                                               |
| Daily cost cap         | `config.surgeon.dailyCostCap`                                                          | `75.00` USD      | The run is refused before start if the trailing 24-hour spend already meets or exceeds the cap.                                |
| Per-turn context limit | `--context-limit`, else `config.surgeon.contextLimit`, else detected from model window | `0` when unknown | If the latest turn hits the tracked limit, the run is treated as context-exhausted and further non-completion work is blocked. |

`0` means no numeric context limit could be enforced.

### Completion guards

`complete_pass` is guarded differently for the two agent-loop passes.

Retirement completion currently tracks:

- largest actionable candidate window paged so far
- largest widened all-scope candidate window paged so far
- whether an exhausted page was seen for actionable and all-scope sweeps
- the run-start estimates of actionable and all-scope availability
- rejection counts

It can reject completion when:

- the surgeon has spot-checked only a small slice of still-available work
- the actionable pool is exhausted but it has not widened to `scope = "all"` yet
- widened all-scope work remains unpaged

It can now accept completion with low spend when the widened all-scope sweep is already exhausted.

Supersession completion currently tracks:

- viewed claim-key clusters
- adjudicated claim-key clusters
- viewed subject clusters
- whether the run widened into subject review before claim-key exhaustion

It can reject completion when:

- the claim-key sweep is not actually complete
- too few claim-key clusters were reviewed
- no meaningful adjudication happened
- the pass widened to subject review too early

Both passes use a 50-rejection safety valve.

### Bounded slices

If the model stops without calling `complete_pass`, the workflow now starts a fresh bounded slice instead of extending one unbounded conversation.

Slice progression stops when any of these are true:

- the pass completed
- the pass hit `no_work` before entering the loop
- the pass is marked `stalled` because repeated slices stopped making semantic progress
- the user aborted
- the context budget is exhausted
- the cost cap is exceeded
- the bounded slice cap has been reached

### Abort behavior

`Ctrl+C` requests a graceful abort first. A second `Ctrl+C` forces exit. Graceful aborts still finalize the run row with status `aborted`.

## Backups before apply

In apply mode, agenr creates a filesystem backup before any mutation tool can change the DB. Autonomous runs create that backup once, before the first actionable pass, and later passes in the same run reuse that protected starting point instead of creating new backups.

Current behavior:

- skipped for `:memory:` DBs
- resolves both plain filesystem paths and `file:` URLs
- copies the main SQLite DB file
- also copies `-wal` and `-shm` sidecars when they exist
- names the backup as:

```text
<db-path>.surgeon-backup-<timestamp>
```

Example:

```text
~/.agenr/knowledge.db.surgeon-backup-2026-04-09T17-20-14-521Z
```

## Configuration

The runtime reads a nested `surgeon` section from `config.json`.

Example:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "surgeon": {
    "model": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    },
    "costCap": 10,
    "dailyCostCap": 30,
    "contextLimit": 120000,
    "customInstructions": "Prefer retaining long-lived personal infrastructure facts unless clearly superseded.",
    "passes": {
      "retirement": {
        "protectRecalledDays": 14,
        "protectMinImportance": 9,
        "skipRecentlyEvaluatedDays": 7
      }
    }
  }
}
```

Current defaults from `src/config.ts`:

- `surgeon.costCap = 15.0`
- `surgeon.dailyCostCap = 75.0`
- `surgeon.contextLimit = 0`
- `surgeon.passes.retirement.protectRecalledDays = 14`
- `surgeon.passes.retirement.protectMinImportance = 9`
- `surgeon.passes.retirement.skipRecentlyEvaluatedDays = 7`

Precedence for overrideable runtime values is:

1. CLI flag
2. `config.surgeon.*`
3. top-level config fallback when relevant
4. hardcoded default

## Protection rules

Hard retirement protections are enforced both in candidate queries and in `retire_entry`.

Current hard protections:

- `expiry = core`
- `importance >= protectMinImportance` default `9`
- `last_recalled_at` within `protectRecalledDays` default `14`

Recently evaluated filtering is separate from hard protection. By default, entries touched by surgeon actions within the last `7` days are skipped from the next retirement candidate sweep.

## Persistence and audit trail

### `surgeon_runs`

Each run gets a row at start and is finalized at completion.

Persisted fields include:

- pass type
- optional project scope
- started and completed timestamps
- status
- input and output tokens
- estimated cost
- model ID
- dry-run flag
- action counts
- retired-entry count
- structured `summary_json`
- error text
- config snapshot JSON

Run statuses are:

- `running`
- `completed`
- `no_work`
- `stalled`
- `failed`
- `aborted`
- `budget_exhausted`
- `cost_capped`

### `surgeon_run_actions`

Action rows are persisted separately and power both auditability and recently-evaluated filtering.

Persisted fields include:

- action ID
- run ID
- action type
- primary `entry_id`
- full `entry_ids` JSON array
- reasoning
- optional `recall_delta`
- optional `details_json`
- timestamp

Current action types in play include:

- `retire`
- `update_entry`
- `resolve_conflict`
- `skip`

Dry-run passes still record action audit rows for would-be retirements and would-be updates.

### `surgeon_run_proposals`

Unresolved claim-key-quality work is persisted separately as proposals with:

- proposal ID
- run ID
- group ID
- issue kind
- proposal scope
- entry IDs
- current claim keys
- proposed claim keys
- rationale
- confidence
- source
- `eligible_for_apply`
- timestamp

## Practical workflow

Start with:

```bash
agenr surgeon status
agenr surgeon run --budget 1 --verbose
agenr surgeon history --limit 5
agenr surgeon actions <run-id>
```

For the default autonomous cleanup run:

```bash
agenr surgeon run --budget 1 --verbose
```

For one explicit claim-key-quality sweep:

```bash
agenr surgeon run --pass claim_key_quality --apply
```

Once dry-run behavior looks sane, move to:

```bash
agenr surgeon run --apply --budget 2
```
