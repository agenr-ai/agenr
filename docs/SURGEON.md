# Surgeon

The surgeon is agenr's autonomous corpus-maintenance agent.

It runs a bounded retirement pass over the knowledge base, evaluates semantically stale entries, and either retires them, downgrades them, or leaves them alone. The goal is corpus health, not aggressive deletion: remove obsolete memory without creating recall gaps.

This document describes the code as it exists now, not just the intended design.

## Code map

- `src/cli/commands/surgeon.ts` - CLI command group and output formatting.
- `src/app/surgeon/runtime.ts` - runtime wiring: config, model selection, credentials, recall adapter, DB backup.
- `src/app/surgeon/service.ts` - one full surgeon run: budget checks, prompts, agent loop, continuation, and persistence through `SurgeonPort`.
- `src/app/surgeon/budget.ts` - per-run token, cost, and context tracking.
- `src/app/surgeon/completion-guard.ts` - pagination/completion state used to reject shallow passes.
- `src/app/surgeon/prompts.ts` - system prompt and retirement-pass prompt.
- `src/app/surgeon/trace-logger.ts` - verbose trace logging and optional trace-file output.
- `src/app/surgeon/tools/*.ts` - the 7 surgeon tools.
- `src/app/surgeon/ports.ts` - the explicit `SurgeonPort` boundary used by the workflow and status surfaces.
- `src/adapters/db/surgeon-port.ts` - DB-backed implementation of `SurgeonPort`.
- `src/adapters/db/surgeon-queries.ts` and `src/adapters/db/surgeon-run-log.ts` - lower-level SQL modules used only behind the DB-backed surgeon port.
- `src/core/surgeon/domain/protection-rules.ts` - hard retirement guards.
- `src/config.ts` - surgeon config types and defaults.

## What the surgeon is for

agenr stores durable memory, but not every stored entry should live forever.

Some entries are short-lived by nature:

- old session handoffs
- progress snapshots
- resolved status updates
- obsolete workarounds
- temporary context that was never recalled
- older entries clearly covered by newer survivors

Mechanical rules can filter obvious cases, but they cannot reliably decide semantic staleness. The surgeon exists for that last step.

It is an autonomous agent loop that:

1. inspects corpus health
2. pages through retirement candidates
3. reads candidate content and related context
4. simulates recall impact when needed
5. retires or downgrades entries conservatively
6. persists a full audit trail of what it did

The current MVP is retirement-only. Deduplication and contradiction handling are explicitly out of scope.

## How it works

The surgeon uses `@mariozechner/pi-agent-core`'s `runAgentLoop()` as a bounded job, not as an interactive chat agent.

At runtime, agenr does the following:

1. Loads config and resolves the database path.
2. Resolves the surgeon model.
   - CLI `--provider` / `--model`
   - then `config.surgeon.model`
   - then top-level `provider` / `model`
   - then fallback `openai` + `gpt-5.4-mini`
3. Resolves LLM credentials for that provider.
4. Tries to create recall ports so `simulate_recall` can reuse the live recall pipeline.
5. Checks the trailing 24-hour surgeon spend against the daily cap.
6. In apply mode, creates a timestamped backup of the SQLite database before any mutation tools can run.
7. Creates a `surgeon_runs` row with status `running`.
8. Builds the system prompt from:
   - `getSurgeonSystemPrompt()`
   - `getSurgeonRetirementPassPrompt()`
   - `config.surgeon.customInstructions` if present
9. Starts the agent loop with the 7 surgeon tools.
10. Tracks usage, context pressure, actions, and completion state while the model works.
11. Persists the final run summary, token counts, cost, errors, and completion payload.

### Agent-loop shape

The surgeon is deliberately bounded:

- tool execution is sequential
- continuation prompts are injected when the model stops early without calling `complete_pass`
- non-completion tool calls are blocked once the run is aborted, cost-capped, or context-exhausted
- continuation prompts stop after 50 attempts as a hard safety valve

The initial user prompt tells the model:

- project scope
- total entry count
- retirement candidate count
- last surgeon run summary
- cost budget
- context limit when known

### Candidate selection

`query_candidates` pages over entries that are active and not already protected.

Hard prefilters applied before the model sees candidates:

- active entries only
- `expiry <> 'core'`
- `importance < protectMinImportance`
- `last_recalled_at` older than the protection window
- optionally skip entries recently evaluated by previous surgeon actions

The default `scope = "actionable"` narrows to the highest-yield cleanup pool:

- all `temporary` entries
- `milestone` entries with low importance
- low-importance unrecalled `fact` entries

Candidates are then prioritized roughly like this:

1. temporary entries
2. low-importance milestones
3. subjects that look like status artifacts
4. never-recalled entries
5. older entries
6. lower-importance entries

### Inspection and recall simulation

The surgeon does not retire from summaries alone.

For entries that look actionable, it can:

- inspect full entry content
- inspect tags and provenance
- inspect related entries with the same subject or cluster
- inspect reverse-supersession context
- simulate recall without writing recall telemetry

`simulate_recall` can also exclude the target entry from results, which lets the surgeon ask: if this entry disappeared, would recall still return good answers?

## The 7 surgeon tools

| Tool               | What it does                                            | Important details                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_health_stats` | Returns corpus health stats and the latest surgeon run. | Includes total entries, counts by type, recency buckets, recall buckets, quality buckets, actionable retirement-candidate count, and recently evaluated count.                      |
| `query_candidates` | Pages retirement candidates.                            | Default scope is `actionable`. Supports `scope`, `type`, `importance_max`, `min_age_days`, `project`, `limit`, and `offset`. Default page size is `20`, max `100`.                  |
| `inspect_entry`    | Loads one entry in detail.                              | Returns the full entry, tags, same-subject entries, same-cluster entries, reverse-supersession count, and a sample of superseded entries.                                           |
| `simulate_recall`  | Runs recall without telemetry.                          | Accepts `query`, optional `exclude_entry_id`, and optional `limit` (default `10`, max `20`). Throws if recall ports are unavailable, usually because embeddings are not configured. |
| `retire_entry`     | Retires one entry.                                      | Enforces hard protections even if the model tries to bypass them. In dry-run mode it reports `wouldRetire: true` without mutating the DB.                                           |
| `update_entry`     | Updates `importance` and/or `expiry`.                   | Used when demotion is better than retirement. In dry-run mode it reports `wouldUpdate: true`. Promoting to `core` requires reasoning that explicitly mentions `core`.               |
| `complete_pass`    | Finalizes the pass with a structured summary.           | Can reject premature completion if the surgeon has not paged deeply enough or has barely used its budget. Also records `entries_skipped` as audit actions.                          |

### `get_health_stats`

This tool is the orientation step. It gives the model a snapshot of:

- corpus size
- type distribution
- age distribution
- recall distribution
- quality distribution
- actionable retirement candidate count
- how many candidates were recently evaluated and will be skipped next run
- the latest persisted surgeon run

### `query_candidates`

This is the surgeon's work queue.

Parameters:

| Field            | Meaning                                       |
| ---------------- | --------------------------------------------- |
| `scope`          | `actionable` or `all`. Default: `actionable`. |
| `type`           | Optional exact entry type filter.             |
| `importance_max` | Optional upper bound on importance.           |
| `min_age_days`   | Optional minimum age in days.                 |
| `project`        | Optional exact project-scope filter.          |
| `limit`          | Page size. Default: `20`.                     |
| `offset`         | Page offset. Default: `0`.                    |

The completion guard tracks pagination progress from this tool and uses it to reject shallow passes.

### `inspect_entry`

This is the main context-expansion tool. It returns:

- the full entry
- the entry's tags
- active entries with the same normalized subject
- active entries in the same cluster
- how many entries point at this entry via `superseded_by`
- a sample of those reverse-superseded entries

That is enough for the surgeon to answer the important question: is this entry disposable, or is it the surviving canonical source for a topic?

### `simulate_recall`

This tool wraps the normal v1 recall pipeline and swaps in a no-op telemetry sink.

That matters because the surgeon needs to test retrieval impact without poisoning live recall metrics. It can also exclude the candidate entry from vector search, FTS search, and hydration to simulate the post-retirement world.

### `retire_entry`

`retire_entry` requires:

- `entry_id`
- `reason`

Behavior:

- returns a failure if the entry does not exist
- rejects retirement if the entry is protected
- respects dry-run mode
- in apply mode calls the normal DB `retireEntry()` mutation

### `update_entry`

`update_entry` requires:

- `entry_id`
- `reasoning`
- at least one of `importance` or `expiry`

Behavior:

- clamps importance into `1-10`
- only accepts `core`, `permanent`, or `temporary` for expiry
- rejects empty/no-op requests
- rejects `expiry: "core"` unless the reasoning explicitly mentions `core`
- respects dry-run mode

### `complete_pass`

`complete_pass` requires a structured payload:

```ts
{
  actions_taken: number;
  entries_skipped: Array<{ entry_id?: string; reason: string }>;
  observations: string[];
  recommendations: string[];
}
```

This is not a ceremonial stop signal. It is the main completion-governance checkpoint.

Before completion is accepted, agenr can reject the call if all of the following are true:

- completion guards are active
- the run has used less than 75% of the configured cost cap
- the surgeon has not clearly exhausted candidate pagination

There is also a harder early-stop check below 20% budget use: if the surgeon has barely spent anything, it is expected to widen from `scope = "actionable"` to `scope = "all"` and keep working.

A safety valve disables repeated rejection after 50 rejected completion attempts.

## CLI surface

The surgeon CLI is a command group under `agenr surgeon`.

## `agenr surgeon run`

Runs one retirement pass.

```bash
agenr surgeon run [options]
```

### Flags

| Flag                        | Meaning                                                         | Default                                                                               |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--budget <usd>`            | Per-run cost cap in USD.                                        | `config.surgeon.costCap`, else `15.00`                                                |
| `--context-limit <tokens>`  | Override the per-turn context limit used by the budget tracker. | `config.surgeon.contextLimit`, else ~85% of model context window when known, else `0` |
| `--skip-evaluated-days <n>` | Skip entries evaluated within the last `n` days.                | `config.surgeon.passes.retirement.skipRecentlyEvaluatedDays`, else `7`                |
| `--apply`                   | Apply mutations instead of running in dry-run mode.             | off                                                                                   |
| `--model <id>`              | Override the surgeon model ID.                                  | config/top-level/default resolution                                                   |
| `--provider <name>`         | Override the surgeon model provider.                            | config/top-level/default resolution                                                   |
| `--verbose`                 | Emit verbose trace logging.                                     | off                                                                                   |
| `--trace <path>`            | Write structured trace events to a file.                        | none                                                                                  |
| `--json`                    | Emit machine-readable JSON instead of human-readable text.      | off                                                                                   |

### Default mode

`agenr surgeon run` is dry-run by default.

That means the surgeon still:

- creates a run row
- reasons normally
- pages candidates
- inspects entries
- simulates recall
- logs actions

But mutation tools only report what would happen.

### Human-readable output

The normal output shape is:

```text
Surgeon run <run-id>
Pass: retirement
Mode: dry-run | apply
Status: completed | failed | aborted | budget_exhausted | cost_capped
Actions: <total> total | retired <n>
Usage: input <n> | output <n> | cost $<amount>
Summary: <summary or n/a>
```

### JSON output

With `--json`, the command emits:

```json
{
  "runId": "...",
  "status": "completed",
  "passType": "retirement",
  "actionsTaken": 0,
  "entriesRetired": 0,
  "inputTokens": 0,
  "outputTokens": 0,
  "estimatedCostUsd": 0,
  "summary": null
}
```

### Abort behavior

`Ctrl+C` requests a graceful abort first. A second `Ctrl+C` forces exit.

When the run aborts gracefully, the final run row is persisted with status `aborted`.

## `agenr surgeon status`

Shows current corpus health plus the latest run summary.

```bash
agenr surgeon status
```

Current output includes:

- total active entries
- total retirement candidates
- new vs recently evaluated candidate counts when recent-evaluation filtering is active
- the latest surgeon run summary
- the latest surgeon run cost

## `agenr surgeon history`

Shows recent persisted surgeon runs.

```bash
agenr surgeon history [--limit <n>]
```

### Flags

| Flag          | Meaning                         | Default |
| ------------- | ------------------------------- | ------- |
| `--limit <n>` | Maximum number of runs to show. | `10`    |

Each line includes:

- `started_at`
- `pass_type`
- `status`
- `dry-run` vs `apply`
- `actions=<n>`
- `cost=$<amount>`

## `agenr surgeon actions <run-id>`

Shows the action audit trail for one run.

```bash
agenr surgeon actions <run-id>
```

Each action shows:

- timestamp
- action type
- entry IDs
- stored reasoning

This includes `retire`, `update_entry`, and `skip` actions.

## Dry-run vs apply

| Mode    | What changes in the DB                                                              | What still happens                                                                              |
| ------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Dry-run | No entry mutations. `retire_entry` and `update_entry` only report would-be changes. | Run row is created, actions are logged, usage is tracked, completion summary is persisted.      |
| Apply   | Real retire/update mutations are allowed.                                           | Everything from dry-run still happens, plus the DB is backed up before the run mutates entries. |

Apply mode is opt-in:

```bash
agenr surgeon run --apply
```

## Budget and completion governance

The surgeon has multiple layers of runtime governance.

### Cost caps

| Guard            | Source                                    | Default     | Behavior                                                                                                                               |
| ---------------- | ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Per-run cost cap | `--budget`, else `config.surgeon.costCap` | `15.00` USD | The budget tracker accumulates model-reported cost and blocks further non-completion tool calls once the cap is reached.               |
| Daily cost cap   | `config.surgeon.dailyCostCap`             | `75.00` USD | Before the run starts, agenr sums surgeon spend over the trailing 24 hours and refuses to start if the cap is already met or exceeded. |

### Context-limit tracking

| Guard                  | Source                                                                                             | Default          | Behavior                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-turn context limit | `--context-limit`, else `config.surgeon.contextLimit`, else 85% of model context window when known | `0` when unknown | The budget tracker records the latest assistant input-token count. If the most recent turn hits the limit, the run is treated as context-exhausted and further non-completion tool calls are blocked. |

A limit of `0` means agenr could not determine a context budget and therefore cannot enforce one numerically.

### Completion guards

`complete_pass` is guarded by pagination and budget heuristics.

The retirement guard tracks:

- how many times `query_candidates` was called
- the maximum candidate window paged so far
- whether an exhausted page was seen
- the run-start estimate of actionable candidates
- repeated completion rejections

Guard behavior:

- if the surgeon has not called `query_candidates`, completion can be rejected
- if it has only spot-checked a small slice of the candidate pool, completion can be rejected
- if the actionable scope is exhausted and budget remains, the prompt tells it to widen to `scope = "all"`
- if the run has used under 20% of budget, completion is rejected aggressively
- if the run has used under 75% of budget and unpaged work still appears to exist, completion is rejected
- after 50 rejections, the safety valve allows completion

### Continuation prompts

If the model stops without calling `complete_pass`, the workflow injects a follow-up prompt telling it to keep working. Continuation stops when any of these become true:

- pass completed
- user abort
- context exhausted
- cost cap exceeded
- 50 continuation attempts reached

## Database backup before apply

In apply mode, agenr creates a filesystem backup before the run mutates the database.

Behavior:

- skipped for `:memory:` databases
- copies the main SQLite database file
- also copies `-wal` and `-shm` sidecars when present
- backup file naming:

```text
<db-path>.surgeon-backup-<timestamp>
```

Example:

```text
~/.agenr/knowledge.db.surgeon-backup-2026-03-30T22-10-41-123Z
```

This happens before the run is created and before any apply-mode mutation tool can execute.

## Configuration

The surgeon reads a nested `surgeon` section from `config.json`.

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

### Config fields

| Field                                                 | Type   | Meaning                                                   | Default                                              |
| ----------------------------------------------------- | ------ | --------------------------------------------------------- | ---------------------------------------------------- |
| `surgeon.model.provider`                              | string | Provider override for surgeon runs.                       | falls back to top-level `provider`, else `openai`    |
| `surgeon.model.model`                                 | string | Model ID override for surgeon runs.                       | falls back to top-level `model`, else `gpt-5.4-mini` |
| `surgeon.costCap`                                     | number | Maximum cost per surgeon run in USD.                      | `15.00`                                              |
| `surgeon.dailyCostCap`                                | number | Maximum total surgeon spend in the trailing 24 hours.     | `75.00`                                              |
| `surgeon.contextLimit`                                | number | Explicit context-token limit for surgeon tracking.        | auto-detect from model when possible, else `0`       |
| `surgeon.customInstructions`                          | string | Extra instructions appended to the surgeon system prompt. | none                                                 |
| `surgeon.passes.retirement.protectRecalledDays`       | number | Protect entries recalled within this many days.           | `14`                                                 |
| `surgeon.passes.retirement.protectMinImportance`      | number | Protect entries at or above this importance.              | `9`                                                  |
| `surgeon.passes.retirement.skipRecentlyEvaluatedDays` | number | Skip entries the surgeon evaluated in the last N days.    | `7`                                                  |

### Precedence rules

For values that can be overridden at runtime, precedence is:

1. CLI flag
2. `config.surgeon.*`
3. top-level config fallback when relevant
4. hardcoded default

## Protection thresholds

The surgeon uses both hard and soft protections.

### Hard protections enforced in code

These entries are excluded from normal candidate queries and rejected by `retire_entry` if targeted directly.

| Protection      | Default threshold              | Effect            |
| --------------- | ------------------------------ | ----------------- |
| `expiry = core` | always                         | cannot be retired |
| high importance | `importance >= 9`              | cannot be retired |
| recent recall   | recalled within last `14` days | cannot be retired |

The importance threshold matters because agenr's normal ingestion default is importance `7`, so protecting at `8` would have hidden too much of the corpus from review. The current threshold is `9`.

### Recently evaluated filtering

This is not a permanent protection rule, but it is an important operational guard.

By default, entries touched by surgeon actions in the last `7` days are skipped from the next candidate sweep. That reduces repeat work and gives skipped or recently reviewed entries a cooling-off period.

### Soft protections taught in the prompt

These are model-level judgment rules, not hard code constraints:

- decision entries are durable by nature
- milestones are historical by nature
- active project-tagged entries deserve caution
- entries with high reverse-supersession counts may be canonical survivors
- entries that are the sole strong source for a topic should be kept

## Run and action persistence

The surgeon is designed to be auditable.

### `surgeon_runs`

Every run gets a row when it starts and is finalized when it ends.

Persisted fields include:

- run ID
- pass type
- optional project scope
- `started_at` and `completed_at`
- run status
- input/output token totals
- estimated cost in USD
- model ID
- dry-run flag
- action counts
- retired-entry count
- structured completion summary JSON
- error text when the run fails or aborts
- config snapshot JSON for the run

Run statuses are:

- `running`
- `completed`
- `failed`
- `aborted`
- `budget_exhausted`
- `cost_capped`

### `surgeon_run_actions`

Every meaningful action is persisted separately.

Persisted fields include:

- action ID
- run ID
- action type
- indexed `entry_id` for efficient lookups
- full `entry_ids` JSON array
- reasoning text
- `recall_delta` JSON field (currently stored but not actively populated)
- timestamp

This table powers two things:

1. human auditability via `agenr surgeon actions <run-id>`
2. recently-evaluated filtering in future runs

### What gets logged as an action

- successful `retire_entry` actions
- successful `update_entry` actions
- `skip` actions recorded through `complete_pass.entries_skipped`

That means a skipped entry can be deliberately marked as evaluated without mutating it.

## Running your first surgeon pass

A practical first pass looks like this.

### 1. Check current status

```bash
agenr surgeon status
```

This tells you:

- corpus size
- approximate actionable cleanup pool
- whether many candidates were already evaluated recently
- what happened on the last run

### 2. Start with a dry-run

```bash
agenr surgeon run --budget 1 --verbose --trace ./tmp/surgeon-trace.jsonl
```

Recommended first-run behavior:

- keep it dry-run
- use a small budget
- enable verbose logging
- write a trace file if you want to inspect the agent loop later

This lets you evaluate:

- whether the prompt is too aggressive or too timid
- what kinds of entries the surgeon targets first
- whether `simulate_recall` is available in your environment
- whether completion governance is working as expected

### 3. Review the run history

```bash
agenr surgeon history --limit 5
```

Pick the run ID you care about, then inspect its actions:

```bash
agenr surgeon actions <run-id>
```

Look for:

- retirements that look too aggressive
- skip reasons that should become custom instructions
- entries that should be protected by higher importance or a longer recall window

### 4. Adjust config if needed

Common tuning knobs:

- lower `surgeon.costCap` if you want shorter passes
- increase `surgeon.passes.retirement.protectRecalledDays` if recent-use memory should be stickier
- raise or lower `skipRecentlyEvaluatedDays` depending on review cadence
- add `surgeon.customInstructions` for domain-specific rules

### 5. Run apply mode

Once the dry-run behavior looks sane:

```bash
agenr surgeon run --apply --budget 2
```

In apply mode, agenr will:

1. back up the database
2. run the same surgeon workflow
3. allow `retire_entry` and `update_entry` to mutate the corpus
4. persist the final run and action audit trail

### 6. Re-check status

```bash
agenr surgeon status
```

If the pass was effective, you should see:

- fewer actionable candidates
- a recent last-run summary
- a clear cost footprint for the pass

## Practical guidance

- Start conservative. Dry-run first.
- Use `simulate_recall` as the final check before retiring anything that looks unique.
- Prefer `update_entry` over retirement when the memory is still useful but overpromoted.
- Treat `complete_pass` rejections as a signal that the surgeon did not work deeply enough yet.
- Keep custom instructions short and operational. They are appended directly to the system prompt.
