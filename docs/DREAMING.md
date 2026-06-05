# Dreaming

Dreaming is agenr's background corpus maintenance pipeline. It replaces the retired surgeon subsystem with a tiered, pipeline-first workflow that scans durable memory, mines durable candidates from episode evidence, reconciles claim-key and structural issues deterministically, revises stale beliefs through supersession, and applies safe mutations behind an explicit `--apply` gate.

This document tracks the pipeline through Milestone 4: extract, reconcile, temporalize, profile projection, directives, and operator memory surfaces. Later milestones add prune and background host triggers. See [`docs/internal/plans/agenr-dreaming-prd.md`](./internal/plans/agenr-dreaming-prd.md) for the full roadmap.

## Code map

- `src/core/dreaming/types.ts` - run tiers, statuses, candidate types, stage summaries, and proposal types
- `src/core/dreaming/domain/**` - pure scan, reconcile, and action-type helpers
- `src/app/dreaming/scan.ts` - corpus scan orchestration
- `src/app/dreaming/extract.ts` - episode-evidence mining, context-lookup dedup, and `new`-candidate inserts
- `src/app/dreaming/reconcile/**` - deterministic reconcile pass (claim-key quality)
- `src/app/dreaming/temporalize.ts` - supersession-based revision of `refines` candidates
- `src/app/dreaming/project.ts` - deterministic profile snapshot projection
- `src/app/dreaming/proposal-review.ts` - apply or reject one open proposal
- `src/app/dreaming/service.ts` - `runDream` workflow: scan, extract, reconcile, temporalize, project, apply
- `src/app/dreaming/runtime.ts` - CLI/runtime wiring
- `src/adapters/db/dreaming-port.ts` - persistence port adapter
- `src/adapters/db/dreaming-queries.ts` - episode-evidence and dreaming read/write queries
- `src/adapters/db/dreaming-run-log.ts` - run history and status queries
- `src/adapters/db/schema/dreaming.ts` - dreaming table definitions
- `src/cli/commands/dreaming.ts` - `agenr dream` command group
- `src/adapters/openclaw/hooks/session-end.ts` - OpenClaw session-end episode write
- `src/adapters/openclaw/episode/episode-writer.ts` - shared predecessor and current-session episode writer

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

Supported tiers today: `light`, `standard`, `deep`. The skeleton runs across all tiers; later milestones flesh out per-tier stage coverage and background triggers.

## Configuration

The `dreaming` section in `config.json` replaces the retired `surgeon` section. Legacy configs that still contain `surgeon` are rejected at parse time.

Typical fields:

- `model` - optional LLM override for dreaming stages that call models in later milestones
- `dailyCostCap` - optional spend guard
- `customInstructions` - optional operator guidance appended to later LLM stages

Use `agenr setup` or edit `config.json` directly after `agenr init`.

## Persistence

Dreaming state is stored in:

- `dream_runs` - run metadata, tier, dry-run flag, status, and summary JSON
- `dream_run_actions` - per-action audit trail
- `dream_proposals` - unresolved structural proposals
- `dream_state` - lightweight cross-run bookkeeping
- `profile_snapshots` - ordered profile durable ids, directive ids, as-of time, content hash, run id, and creation time

These tables ship in the greenfield schema version `2` alongside `durables`. There is no migration path from pre-dreaming databases.

## Pipeline

1. **Scan** - load active durables and claim-key lifecycle counters for the requested scope.
2. **Extract** - mine durable candidates from episode evidence since the last successful run, then classify each candidate against the active corpus:
   - content-hash equality marks a candidate `known` (dropped, no write or embedding);
   - an active claim-key family match (when context-lookup is enabled) marks it `refines` and records the predecessor for the temporalize stage;
   - everything else is `new` and is inserted on apply with a `dreaming_extract` claim-key source and `tentative` status.
3. **Reconcile** - run deterministic claim-key quality maintenance (missing-key backfill, malformed-key normalization, and related structural fixes covered by scenario fixtures).
4. **Temporalize** - apply supersession-based revision to each `refines` candidate. The stage never rewrites content in place: it inserts a successor durable that inherits the predecessor's canonical claim key, closes the predecessor's valid-time window at the revision instant, and links the predecessor to the successor through `superseded_by`. Point-in-time recall before the revision still surfaces the predecessor; current-state recall surfaces the successor.
5. **Project** - rank current active durables into a bounded profile snapshot candidate and keep directive ids separate. Dry runs and project-scoped runs report the projected bundle without writing or globally activating it. Successful unscoped apply runs insert a `profile_snapshots` row and mark it active in `dream_state` in the final workflow transaction.
6. **Apply** - when `--apply` is set, persist accepted extract inserts, reconcile mutations, temporalize revisions, and successful unscoped profile projection; otherwise emit a dry-run summary only.

The extract and temporalize stages call models only through injected factories, so deterministic-only runs (no mining LLM) skip extract and temporalize without error. Both stages respect the daily cost cap shared across the run.

Later milestones add `prune` and background host triggers.

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

## Related docs

- Durable write pipeline: [`docs/DURABLES.md`](./DURABLES.md)
- Claim-key lifecycle: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) section 5.1
- Debugging launch configs: [`docs/DEBUGGING.md`](./DEBUGGING.md)
