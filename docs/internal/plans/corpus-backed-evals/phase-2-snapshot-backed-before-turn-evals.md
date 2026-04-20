# Phase 2 - Snapshot-Backed Before-Turn Evals

## Goal

Extend the same snapshot-backed replay model to the before-turn eval seam so selector-quality testing happens against realistic corpus pressure instead of tiny isolated pools.

## Scope

In scope:

- add snapshot-backed seeding support to before-turn evals
- reuse the same shared sandbox contract used by recall evals
- attach snapshot metadata to before-turn responses
- document the new before-turn replay behavior

Out of scope:

- top-K debug artifacts
- OpenClaw live debug sink
- run comparison tooling in `agenr-evals`

## Why This Is Separate From Phase 1

Before-turn replay should reuse the same seed model, but it exercises a different app-layer seam and needs its own response normalization and tests.

Keeping it separate avoids mixing recall-sandbox work with selector-specific behavior changes.

## Primary Files

- `src/app/evals/before-turn/contracts.ts`
- before-turn sandbox setup or shared sandbox helpers
- `src/app/evals/before-turn/run-before-turn-eval-case.ts`
- `src/app/evals/before-turn/normalize-response.ts`
- `src/adapters/api/validation/before-turn-eval-request.ts`
- `docs/EVALS.md`

## Implementation Tasks

1. Reuse the shared `RecallEvalSandboxRequest` seed contract in before-turn evals.
2. Ensure before-turn sandbox creation supports snapshot-copy initialization.
3. Keep `memoryPool` and `procedurePool` overlays working on top of the copied snapshot.
4. Surface snapshot metadata in successful before-turn responses.
5. Update docs to describe the replay mode for before-turn.

## Behavior Requirements

- before-turn replay runs the real `runBeforeTurn()` service against copied snapshot state
- fixture overlays remain supported
- source snapshots are never mutated
- current fixture-only behavior remains unchanged when snapshot mode is not used

## Tests

- before-turn request validation accepts valid snapshot-backed requests
- copied snapshot plus memory/procedure overlays works
- source snapshot remains untouched
- rendered patch and diagnostics still work under replay mode
- existing fixture-only before-turn tests still pass

## Acceptance Criteria

- a before-turn eval case can run against a copied snapshot DB
- the response includes snapshot metadata
- selector behavior remains stable under fixture-only mode
- snapshot-backed before-turn replay is documented

## Codex Handoff

Implement Phase 2 of the corpus-backed eval plan in `agenr`.

Requirements:
- Extend the before-turn eval seam so it can run against copied corpus snapshots using the same seed contract added for recall evals.
- Preserve support for `memoryPool` and `procedurePool` overlays.
- Surface snapshot metadata in successful responses.
- Update `docs/EVALS.md`.

Guardrails:
- Do not add filesystem behavior to `src/core/`.
- Do not expand the seam into a broad eval platform.
- Preserve current fixture-only compatibility.

Verification:
- Add tests for validation, copied snapshot setup, overlay behavior, diagnostics, and source DB immutability.
