# Phase 5 - Replay Corpora And Analysis

## Goal

Teach `agenr-evals` how to use the new replay substrate effectively:

- author replay corpora against real snapshots
- compare runs
- cluster failures
- produce reports that an agent can use directly

## Scope

In scope:

- snapshot-aware manifest shared context
- replay corpus families
- artifact inspection updates for debug artifacts
- run-comparison and failure-clustering tooling
- machine-readable and Markdown reports

Out of scope:

- changing `agenr` runtime behavior
- OpenClaw adapter logging

## Replay Corpus Families

### Gold replay

Hand-checked real-corpus cases with explicit expected winners or expected abstention.

### Hard negatives

Queries that should return no durable answer or should clearly abstain.

### Before-turn replay

Realistic turn windows with expected selection or abstention behavior.

## `agenr-evals` Tasks

1. Add snapshot-aware shared context fields:
   - `snapshotDbPath`
   - `snapshotId`
   - `snapshotLabel`
2. Update the HTTP adapters so cases can forward replay seed information to `agenr`.
3. Add replay manifests for the three corpus families.
4. Update artifact inspect output to display debug-artifact payloads clearly.
5. Add a run-comparison command or script.
6. Add failure clustering by signature:
   - wrong top hit
   - false positive no-result
   - wrong route
   - wrong historical/current state
   - wrong before-turn selection
   - abstain when should inject
   - inject when should abstain
7. Emit both structured JSON and Markdown summary outputs.

## Comparison Report Requirements

The comparison output should answer:

- what improved
- what regressed
- which cluster is currently dominant
- which cases changed outcome
- which thresholds or routing facts appear repeatedly in failures

## Acceptance Criteria

- `agenr-evals` can run snapshot-backed replay manifests
- inspect output exposes replay debug artifacts cleanly
- two runs can be compared automatically
- failure clusters are summarized in a way Codex can act on

## Codex Handoff

Implement Phase 5 of the corpus-backed eval plan in `agenr-evals`.

Requirements:
- Add snapshot-aware manifest/shared-context support.
- Add replay corpora for gold replay, hard negatives, and before-turn replay.
- Update inspect/report tooling to surface debug artifacts.
- Add run-comparison and failure-clustering tooling.
- Produce both structured JSON and Markdown outputs suitable for agent consumption.

Guardrails:
- Keep `agenr-evals` as the owner of manifests, artifacts, comparisons, and reports.
- Do not move suite orchestration into `agenr`.

Verification:
- Add tests for manifest loading, adapter request shaping, inspect output, and run comparison behavior.
