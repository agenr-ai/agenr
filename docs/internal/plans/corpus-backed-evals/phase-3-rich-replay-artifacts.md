# Phase 3 - Rich Replay Artifacts

## Goal

Add stable, bounded, structured debug artifacts to the eval seams so failures can be diagnosed from artifacts alone.

This is the key step that makes agent-driven iteration practical.

## Core Position

Detailed debugging should live in eval responses and artifact files, not in scattered runtime logs.

The right model is:

- typed trace summaries from `core`
- app-shaped diagnostics
- optional debug artifacts exposed only when explicitly requested

## Scope

In scope:

- add `includeDebugArtifact` and `topKCandidates` options
- add stable debug artifact schemas for recall and before-turn
- attach these artifacts to eval responses only when requested
- keep payloads bounded and versioned

Out of scope:

- snapshot-backed seeding itself
- OpenClaw JSONL debug sink
- cross-run comparison tooling

## Proposed Shapes

Recall debug artifact:

- schema version
- case id
- snapshot metadata
- request summary
- routing facts
- candidate counts
- ranking facts
- degraded facts
- selected ids
- top-K candidate breakdown

Before-turn debug artifact:

- schema version
- case id
- snapshot metadata
- turn summary
- query policy and variants
- abstention reasons
- selected ids
- selected procedure key
- top durable and procedure candidates

## Primary Files

- `src/app/evals/recall/contracts.ts`
- `src/app/evals/before-turn/contracts.ts`
- `src/app/evals/recall/collect-diagnostics.ts`
- `src/app/evals/recall/normalize-response.ts`
- `src/app/evals/before-turn/normalize-response.ts`
- API validation files
- `docs/EVALS.md`
- `docs/RECALL.md`

## Implementation Tasks

1. Add explicit debug-artifact types to recall and before-turn eval contracts.
2. Add request options:
   - `includeDebugArtifact`
   - `topKCandidates`
3. Cap top-K values and validate them strictly.
4. Build helper mappers from existing diagnostics into stable artifact shapes.
5. Expose debug artifacts only when requested.
6. Update docs to describe schema intent and boundedness.

## Guardrails

- No raw unbounded candidate dumps.
- No artifact generation in `core`.
- No schema drift without explicit version bumps.
- No reliance on host logs for failure explanation.

## Tests

- valid request options are accepted
- invalid `topKCandidates` values are rejected
- recall responses include bounded debug artifacts when requested
- before-turn responses include bounded debug artifacts when requested
- artifacts are omitted when not requested

## Acceptance Criteria

- a failed replay case can be understood from its artifact alone
- artifact payloads are versioned and bounded
- recall and before-turn both support the same debug-artifact pattern

## Codex Handoff

Implement Phase 3 of the corpus-backed eval plan in `agenr`.

Requirements:
- Add bounded, versioned debug-artifact payloads to the recall and before-turn eval seams.
- Add request options for `includeDebugArtifact` and `topKCandidates`.
- Map existing diagnostics into stable artifact shapes rather than dumping raw internal structures.
- Update `docs/EVALS.md` and `docs/RECALL.md`.

Guardrails:
- Keep artifacts opt-in.
- Keep artifacts bounded.
- Do not add logging behavior to `src/core/`.

Verification:
- Add tests for request validation, omission by default, and bounded artifact contents.
