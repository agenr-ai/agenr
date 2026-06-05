# Dreaming

Dreaming is agenr's background corpus maintenance pipeline. It replaces the retired surgeon subsystem with a tiered, pipeline-first workflow that scans durable memory, reconciles claim-key and structural issues deterministically, and applies safe mutations behind an explicit `--apply` gate.

This document is a Milestone 1 stub. Later milestones add extract, temporalize, projection, directives, prune, and host triggers. See [`docs/internal/plans/agenr-dreaming-prd.md`](./internal/plans/agenr-dreaming-prd.md) for the full roadmap.

## Code map

- `src/core/dreaming/types.ts` - run tiers, statuses, reconcile summaries, and proposal types
- `src/core/dreaming/domain/**` - pure scan and reconcile helpers
- `src/app/dreaming/scan.ts` - corpus scan orchestration
- `src/app/dreaming/reconcile.ts` - deterministic reconcile pass (claim-key quality in M1)
- `src/app/dreaming/service.ts` - `runDream` workflow: scan, reconcile, apply
- `src/app/dreaming/runtime.ts` - CLI/runtime wiring
- `src/adapters/db/dreaming-port.ts` - persistence port adapter
- `src/adapters/db/dreaming-run-log.ts` - run history and status queries
- `src/adapters/db/schema/dreaming.ts` - dreaming table definitions
- `src/cli/commands/dreaming.ts` - `agenr dream` command group

## CLI surface (Milestone 1)

```bash
# Dry-run a standard-tier dreaming pass (default)
agenr dream run --tier standard

# Apply mutations explicitly
agenr dream run --tier standard --apply

# Inspect latest run and corpus counters
agenr dream status

# List recent runs
agenr dream history --limit 20
```

`agenr dream run` is dry-run by default. Pass `--apply` to persist reconcile outcomes.

Supported tiers today: `light`, `standard`, `deep`. Milestone 1 implements the skeleton across all tiers; later milestones flesh out stage coverage per tier.

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
- `profile_snapshots` - reserved for later projection work

These tables ship in the greenfield schema version `1` alongside `durables`. There is no migration path from pre-dreaming databases.

## Milestone 1 pipeline

1. **Scan** - load active durables and claim-key lifecycle counters for the requested scope.
2. **Reconcile** - run deterministic claim-key quality maintenance (missing-key backfill, malformed-key normalization, and related structural fixes covered by scenario fixtures).
3. **Apply** - when `--apply` is set, persist accepted reconcile mutations and record run actions; otherwise emit a dry-run summary only.

Later milestones add `extract`, `temporalize`, `project`, directive surfacing, `prune`, and background host triggers.

## Scenario harness

Claim-key scenarios under `tests/scenarios/claim-keys/dreaming/` exercise the real dreaming service path with fixture-backed LLMs. Run them with:

```bash
agenr scenarios run --kind dreaming --preserve --verbose
```

## Related docs

- Durable write pipeline: [`docs/DURABLES.md`](./DURABLES.md)
- Claim-key lifecycle: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) section 5.1
- Debugging launch configs: [`docs/DEBUGGING.md`](./DEBUGGING.md)
