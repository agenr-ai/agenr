# Dreaming

Dreaming is agenr's background corpus maintenance pipeline. It replaces the retired surgeon subsystem with a tiered, pipeline-first workflow that scans durable memory, mines durable candidates from episode evidence, reconciles claim-key and structural issues deterministically, revises stale beliefs through supersession, projects profile snapshots, prunes low-signal residue, and applies safe mutations behind an explicit `--apply` gate.

## Code map

- `src/core/dreaming/types.ts` - run tiers, statuses, candidate types, stage summaries, and proposal types
- `src/core/dreaming/domain/**` - pure scan, reconcile, and action-type helpers
- `src/app/dreaming/scan.ts` - corpus scan orchestration
- `src/app/dreaming/extract.ts` - episode-evidence mining, context-lookup dedup, and `new`-candidate inserts
- `src/app/dreaming/reconcile/**` - deterministic reconcile pass (claim-key quality)
- `src/app/dreaming/temporalize.ts` - supersession-based revision of `refines` candidates
- `src/app/dreaming/project.ts` - deterministic profile snapshot projection
- `src/app/dreaming/prune.ts` - deterministic, conservative durable staleness via `valid_to`
- `src/app/dreaming/background-triggers.ts` - post-session and accumulated-importance light-run gates
- `src/app/dreaming/concurrency.ts` - process-wide dreaming run lock and episode-write serialization guards
- `src/app/dreaming/proposal-review.ts` - apply or reject one open proposal
- `src/app/dreaming/service.ts` - `runDream` workflow: scan, extract, reconcile, temporalize, project, prune, apply
- `src/app/dreaming/runtime.ts` - CLI/runtime wiring
- `src/adapters/db/dreaming-port.ts` - persistence port adapter
- `src/adapters/db/dreaming-queries.ts` - episode-evidence and dreaming read/write queries
- `src/adapters/db/dreaming-run-log.ts` - run history and status queries
- `src/adapters/db/schema/dreaming.ts` - dreaming table definitions
- `src/cli/commands/dreaming.ts` - `agenr dream` command group
- `src/adapters/openclaw/hooks/session-end.ts` - OpenClaw session-end episode write
- `src/adapters/openclaw/episode/episode-writer.ts` - shared predecessor and current-session episode writer
- `src/adapters/skeln/episode/shutdown-episode-write.ts` - Skeln shutdown episode write and light-run trigger

## CLI surface

```bash
# Dry-run a standard-tier dreaming pass (default)
agenr dream run --tier standard

# Apply mutations explicitly
agenr dream run --tier standard --apply

# Inspect latest run and corpus counters
agenr dream status

# Inspect current profile surfaces
agenr dream profile
agenr dream summary

# List recent runs
agenr dream history --limit 20

# Inspect the audit trail and proposals for one run
agenr dream actions <runId>
agenr dream proposals <runId>

# Review the cross-run proposal backlog
agenr dream backlog --state open --eligible-only

# Apply or reject one open proposal (reason required)
agenr dream review <proposalId> --decision apply --reason "verified safe"
```

`agenr dream run` is dry-run by default. Pass `--apply` to persist extract, reconcile, temporalize, and successful unscoped profile projection outcomes. `agenr dream profile` shows the active `profile_snapshots` bundle. `agenr dream summary` renders the same bundle as a grouped operator view with proposal counts and directive rows. `agenr dream review` opens a backed-up transaction before applying a proposal and rolls back on failure.

Supported tiers:

- `light` - bounded background tier used by session-end and accumulated-importance triggers. It runs scan, extract, temporalize, and project, but skips reconcile and prune. Extract reads at most two episode sessions per run by default, and skipped stages are recorded in `stages_skipped`.
- `standard` - default operator tier. It runs the incremental pipeline since the last successful run, including prune.
- `deep` - operator full-backlog tier. It rereads all episode and durable evidence and still relies on content hashes, claim-key context lookup, and supersession to avoid duplicate writes. Use it for weekly maintenance or after large corpus imports.

### Deep tier scheduling

`deep` runs are operator-driven. Schedule weekly maintenance outside host session hooks, for example:

```bash
# cron example (Sunday 03:15 local time)
15 3 * * 0 cd /path/to/workspace && agenr dream run --tier deep --apply
```

```xml
<!-- launchd example: ~/Library/LaunchAgents/com.example.agenr-dream-deep.plist -->
<key>StartCalendarInterval</key>
<dict>
  <key>Weekday</key><integer>0</integer>
  <key>Hour</key><integer>3</integer>
  <key>Minute</key><integer>15</integer>
</dict>
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/agenr</string>
  <string>dream</string>
  <string>run</string>
  <string>--tier</string>
  <string>deep</string>
  <string>--apply</string>
</array>
```

Use `procedures/agenr-dream-deep-maintenance.yaml` for the operator checklist.

`tiers.deep.intervalHours` is a cadence hint for external schedulers (cron, launchd, or your orchestrator). Agenr does not ship a built-in cron daemon; operators wire the interval into their own scheduler.

## Conflict resolution

When a durable written through `agenr_store` (or ingest) conflicts with an older active row on the same claim-key family, the explicit store wins until the next successful dreaming run applies supersession. Dreaming's `temporalize` stage is the reconciliation path: it inserts a successor durable, closes the predecessor's valid-time window, and links `superseded_by` without rewriting content in place. Until that run completes with `--apply`, recall and injection treat the store-written row as authoritative current state.

## Configuration

The `dreaming` section in `config.json` replaces the retired `surgeon` section. Legacy configs that still contain `surgeon` are rejected at parse time.

Typical fields:

- `model` - optional LLM override for dreaming stages that call models in later milestones
- `dailyCostCap` - optional spend guard
- `tiers.light.enabled`, `tiers.standard.enabled`, `tiers.deep.enabled`, `tiers.deep.intervalHours` - tier availability and operator cadence hints
- `stages.extract.maxSessionsPerRun` - maximum episode summaries mined per run
- `stages.extract.lightMaxSessionsPerRun` - optional lower episode-session cap for `light` runs (defaults to 2)
- `stages.extract.contextLookup.enabled` - whether extract shows bounded active claim-key context and checks existing claim-key families before emitting a new durable
- `stages.project.maxProfileDurables` - bounded profile durable count for session-start injection
- `stages.prune.protectRecalledDays` and `stages.prune.protectMinImportance` - prune protection thresholds
- `triggers.postSessionLightDream` - enable session-end `light` runs after host episode writes
- `triggers.importanceThreshold` and `triggers.minIntervalMinutes` - accumulated-importance and rate-limit guards for background `light` runs

Use `agenr setup` or edit `config.json` directly after `agenr init`.

## Persistence

Dreaming state is stored in:

- `dream_runs` - run metadata, tier, dry-run flag, status, and summary JSON
- `dream_run_actions` - per-action audit trail
- `dream_proposals` - unresolved structural proposals
- `dream_state` - lightweight cross-run bookkeeping
- `profile_snapshots` - ordered profile durable ids, directive ids, as-of time, content hash, run id, and creation time

These tables ship alongside `durables` during database initialization. Older persisted databases require `agenr db reset`.

## Pipeline

1. **Scan** - load active durables and claim-key lifecycle counters for the requested scope.
2. **Extract** - mine durable candidates from episode evidence since the last successful run using the dreaming-specific extract prompt in `src/core/dreaming/prompts.ts` (not the ingest transcript prompt). When context lookup is enabled, the prompt includes bounded active claim-key context selected from the episode project and likely claim-key entity prefixes so the model can skip covered facts or reuse exact keys. The stage then classifies each candidate against the active corpus:
   - content-hash equality marks a candidate `known` (dropped, no write or embedding);
   - an active exact claim-key family match (when context-lookup is enabled) marks it `refines` and records the predecessor for the temporalize stage;
   - a conservative same-entity claim-key sibling or project-scoped text overlap also marks a near miss as `refines`, which is especially important for `light` runs that skip reconcile;
   - everything else is `new` and is inserted on apply with a `dreaming_extract` claim-key source and `tentative` status when a claim key is emitted;
   - apply persists episode provenance on each insert: `source_file` (`episode:<id>` or `episode-session:<sessionId>:<id>`), `source_context`, `valid_from` (episode end or start), conservative `project` scope via `resolveDurableProjectScope()` (explicit extract output, claim-key entity match, or visible workspace reference - never a blind session-workspace stamp), and episode support metadata even when claim keys are still missing.
   - when the host already wrote `agenr_store` durables in that session window, passes those rows into the mining prompt and classifies re-emitted duplicates as `known` using session claim keys and normalized content hashes. Episode mining still runs so implicit preferences and other facts not captured live can be mined normally.
3. **Reconcile** - run deterministic claim-key quality maintenance (missing-key backfill, malformed-key normalization, and related structural fixes covered by scenario fixtures).
4. **Temporalize** - apply supersession-based revision to each `refines` candidate. The stage never rewrites content in place: it inserts a successor durable that inherits the predecessor's canonical claim key, closes the predecessor's valid-time window at the revision instant, and links the predecessor to the successor through `superseded_by`. Point-in-time recall before the revision still surfaces the predecessor; current-state recall surfaces the successor.
5. **Project** - rank current active durables into a bounded profile snapshot candidate and keep directive ids separate. Dry runs and project-scoped runs report the projected bundle without writing or globally activating it. Successful unscoped apply runs insert a `profile_snapshots` row and mark it active in `dream_state` in the final workflow transaction.
6. **Prune** - on `standard` and `deep`, close validity on only active low-signal candidates after applying protections for current and projected profile ids, directives, `core` expiry, high importance, and recent recall. The stage is deterministic and writes `stale` actions only for actual apply mutations.
7. **Apply** - when `--apply` is set, persist accepted extract inserts, reconcile mutations, temporalize revisions, prune staleness closes, and successful unscoped profile projection; otherwise emit a dry-run summary only.

The extract and temporalize stages call models only through injected factories, so deterministic-only runs (no mining LLM) skip extract and temporalize without error. Both stages respect the daily cost cap shared across the run.

Every completion summary includes a compute-efficiency block used by eval scoreboard runs:

See [Compute efficiency](#compute-efficiency) for field definitions and the initial loose eval thresholds.

`dream_state.unsynthesized_importance_sum` is reset after a completed run and retained after incomplete runs.

## Compute efficiency

Dreaming completion summaries expose a bounded telemetry block so `agenr-evals` can track synthesis cost separately from daily dreaming spend caps. The PRD targets roughly **5× lower serving cost** for profile-first injection versus repeatedly re-reading and re-injecting the same durables at session start; these counters are the first measurable step toward that thesis. They are **not hard CI gates yet** - the thresholds below are loose baselines used by the WS3 compute-efficiency manifest until production baselines exist.

| Field                           | Definition                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidenceItemsRead`             | Count of episode, ingest-log, and durable-create signals scanned during the run (`scan.episodesSinceLastRun + scan.ingestFilesSinceLastRun + scan.durablesCreatedSinceLastRun`).                    |
| `synthesizedDurableMutations`   | Count of durable writes produced by the run: extract inserts, temporalize revisions, and prune staleness closes. Known extract candidates (content-hash match) do **not** increment this counter.   |
| `recomputeRatio`                | `synthesizedDurableMutations / evidenceItemsRead`, rounded to six decimals. `0` when no evidence was read. Lower is better for incremental/light maintenance.                                       |
| `costPerSynthesizedDurableUsd`  | `estimatedCostUsd / synthesizedDurableMutations`, rounded to six decimals. `null` when no mutations occurred.                                                                                       |
| `profileInjectionTokenEstimate` | Rough prompt-token estimate for the active profile bundle (`36` tokens × profile durables + `24` tokens × directives). Used to compare dreaming-on profile projection against store-only injection. |

Initial loose thresholds exercised by `agenr-evals` cases (Option A completion-summary fixtures, not live `runDream()`):

| Signal                                                   | Loose threshold                           | Eval case                                             |
| -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `recomputeRatio` on `light` tier                         | `< 0.5`                                   | `dreaming.efficiency.light-low-recompute`             |
| `synthesizedDurableMutations` for known candidates       | `= 0`                                     | `dreaming.efficiency.known-candidates-zero-mutations` |
| `profileInjectionTokenEstimate` vs store-only equivalent | profile bundle `< memoryPool.length × 36` | `dreaming.efficiency.dreaming-on-profile-tokens`      |

Run the compute-efficiency suite:

```bash
# terminal 1 - agenr eval server
cd /path/to/agenr
pnpm internal:eval-server

# terminal 2 - agenr-evals manifest
cd /path/to/agenr-evals
npm run evals -- run --manifest dreaming/compute-efficiency --adapter agenr-dreaming-efficiency-http
```

See [`docs/EVALS.md` § Dreaming compute-efficiency seam](./EVALS.md#dreaming-compute-efficiency-seam-ws3) for the HTTP contract.

## Background triggers

Host adapters do not expose dreaming tools. They launch bounded `light` runs in the background through existing lifecycle hooks:

- OpenClaw writes the current session episode from `session_end`, then evaluates `triggers.postSessionLightDream`.
- Skeln writes the current session episode from `session_shutdown`, then evaluates `triggers.postSessionLightDream`.
- OpenClaw and Skeln both evaluate the accumulated-importance trigger after a successful `agenr_store` call.

The trigger gate skips when the light tier is disabled, another dreaming run holds the process-wide lock (`run_in_progress`), an episode write is still in progress for store-triggered importance dreams (`episode_write_in_progress`), the interval guard has not elapsed, no unsynthesized evidence exists, or the accumulated durable importance is below `triggers.importanceThreshold`.

### Concurrency and serialization

Only one dreaming run may execute against a database at a time. `runDream()` acquires a process-wide lock lease at start, heartbeats it while the run is active, and releases it in `finally`. Background triggers call `maybeRunLightDream()`, which tries the same lock before launching a run and returns `run_in_progress` when another caller already holds it.

Episode writes serialize ahead of dreaming:

1. Host hooks acquire the same lock lease before writing the current session episode.
2. Post-session light dreaming runs only after that episode write releases the lock.
3. Store-triggered importance dreams skip while an in-process episode write guard is active for the same database.

`dream_state.run_lock_holder` and `dream_state.run_lock_heartbeat_at` back the SQLite lock row; an in-process map keyed by database path prevents overlapping work inside one plugin process.

To recover from a crashed or killed process that never released its lock, a new run may take over a lock row whose heartbeat is older than `DREAMING_RUN_LOCK_STALE_MS` (one hour). Active runs refresh `run_lock_heartbeat_at`, so long-running `deep` runs keep their lease instead of being stolen. Acquire, heartbeat, and release surface unexpected SQLite errors instead of swallowing them, so a missing column or transaction failure is reported rather than silently masquerading as contention.

### Background apply backup policy

Background `light` runs keep `skipBackup: true` for latency. Applied runs record `backupSkipped: true` in `summary_json`. `agenr dream status` warns when any of the five most recent applied `light` runs skipped backup so operators know background maintenance is running without a pre-apply snapshot. Because background `light` applies always skip backup by design, this warning is expected during normal background maintenance; it exists so the absence of pre-apply snapshots is never silent.

CLI `agenr dream run --apply` and proposal review still create timestamped backups before their first mutating write.

### Deferred: assistant-confirmed trust

Assistant-mined extract candidates still follow the current prompt-priority approach; user-turn corroboration before promotion remains deferred (WS6.4).

## Directives and profile projection

`directive` is a first-class durable kind for memory behavior instructions. Directive rows must use claim keys under `user/memory_directive/<name>` and carry:

- `directive_polarity`: `abstain` or `proactive`
- `directive_trigger`: `session_start`, `always`, or `topic:<term>`

When `directive_trigger` is absent, store validation defaults proactive directives to `session_start` and abstain directives to `always`. Directive expiry defaults to `core`.

Session-start selection is profile-first:

1. Fresh active profile snapshot durable ids, default max age 48 hours.
2. Active proactive directives whose trigger is `session_start` or `always`.
3. Always-on core durables not already selected.
4. Bounded artifact-grounded durable recall.
5. Predecessor continuity sections, rendered outside durable memory.

Abstain directives are evaluated last over the assembled bundle. A proactive directive can surface at session start, but it is still removed if an active abstain directive blocks the same topic.

## Episode boundaries

Dreaming consumes episodes as evidence, so episodes must land before the next session starts. Both hosts write the just-finished session's episode at session end:

- OpenClaw writes the current session episode from its `session_end` hook (`src/adapters/openclaw/hooks/session-end.ts`), reusing the shared bounded writer that also handles predecessor continuity. The write is best-effort and never throws into the host lifecycle. Upserting by session id keeps the write idempotent.
- Skeln writes the current session episode from its shutdown chain (`src/adapters/skeln/episode/shutdown-episode-write.ts`) through the same bounded episode contract.

## Scenario harness

Two fixture-backed scenario suites cover dreaming behavior:

- Claim-key scenarios under `tests/scenarios/claim-keys/dreaming/` exercise the real dreaming service path with fixture-backed LLMs. Run them with:

```bash
agenr scenarios run --kind dreaming --preserve --verbose
```

- Pipeline scenarios under `tests/scenarios/dreaming/pipeline/` seed a real corpus plus episode evidence and run the extract -> apply -> temporalize stages against a deterministic mining LLM. They cover implicit-preference capture, trip-lifecycle revision, point-in-time recall, and the no-overconsolidation guard. Focused Vitest coverage pins project snapshots, profile-first session start, proactive directive surfacing, and directive abstention.

### Ablation scoreboard (`agenr-evals`)

WS1 mirrors the in-repo injection and pipeline fixtures into `agenr-evals` cases and runs them across three ablation arms (`memory-off`, `store-only`, `dreaming-on`) through the recall, before-turn, and session-start HTTP eval seams. Dreaming outputs are pre-seeded into fixtures (Option A); evals do not call live `runDream()`.

Operator sequence:

```bash
# terminal 1 - agenr eval server
cd /path/to/agenr
pnpm internal:eval-server

# terminal 2 - run all arms and emit the markdown scoreboard
cd /path/to/agenr-evals
npm run run-ablation dreaming
```

Per-arm artifacts are written under `agenr-evals/artifacts/runs/dreaming-ablation/<arm>/`. The scoreboard markdown is written beside those runs for case × arm comparison.

Arm contract and seam mapping: [`docs/EVALS.md` § Dreaming ablation arms](./EVALS.md#dreaming-ablation-arms-ws1).

Compute-efficiency regression (WS3) uses a separate manifest and pre-seeded completion summaries: [`docs/EVALS.md` § Dreaming compute-efficiency seam](./EVALS.md#dreaming-compute-efficiency-seam-ws3).

## Related docs

- Durable write pipeline: [`docs/DURABLES.md`](./DURABLES.md)
- Claim-key lifecycle: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) section 5.1
- Debugging launch configs: [`docs/DEBUGGING.md`](./DEBUGGING.md)
