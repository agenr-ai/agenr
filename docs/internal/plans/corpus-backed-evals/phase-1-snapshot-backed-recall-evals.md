# Phase 1 - Snapshot-Backed Recall Evals

## Goal

Add a replay mode for recall evals that runs against a copied corpus snapshot rather than a tiny fixture-only pool.

This is the first high-leverage slice because it creates realistic retrieval pressure while preserving the existing isolated eval model.

## Why This Phase Comes First

The smallest useful improvement is:

- real-corpus retrieval pressure
- copied-snapshot safety
- no dependency yet on richer artifact payloads or OpenClaw live logging

That gives Codex a better training ground immediately.

## Scope

In scope:

- extend the recall eval sandbox contract to support snapshot-backed seeding
- copy a snapshot DB into each case sandbox
- allow fixture overlays on top of the copied snapshot
- expose snapshot metadata in successful responses
- document the new replay mode

Out of scope:

- before-turn replay
- rich top-K candidate debug artifacts
- OpenClaw JSONL debug logging
- `agenr-evals` comparison tooling

## Required Contract Changes

Extend `RecallEvalSandboxRequest` with:

```ts
corpusSeed?: 
  | { mode: "fixture" }
  | {
      mode: "snapshot_copy";
      snapshotDbPath: string;
      snapshotId?: string;
      snapshotLabel?: string;
      allowTelemetryWrites?: boolean;
    };
```

## Expected Behavior

- `fixture` preserves current behavior.
- `snapshot_copy` copies `snapshotDbPath` into the sandbox before recall runs.
- `memoryPool` can still add or override state in the copied DB.
- The source snapshot must never be mutated.
- Any recall telemetry writes must affect only the copied DB.

## Primary Files

- `src/app/evals/recall/contracts.ts`
- `src/app/evals/recall/sandbox.ts`
- `src/app/evals/recall/run-recall-eval-case.ts`
- `src/app/evals/recall/normalize-response.ts`
- `src/adapters/api/validation/recall-eval-request.ts`
- `docs/EVALS.md`

## Implementation Tasks

1. Extend the recall eval contracts with the new `corpusSeed` union.
2. Add strict validation for `snapshot_copy`.
3. Update sandbox setup so it can initialize from a copied snapshot DB.
4. Ensure cleanup and preserve semantics still work for copied snapshots.
5. Attach snapshot metadata to successful responses.
6. Preserve exact current behavior when `corpusSeed` is omitted.
7. Document the contract and safety rules in `docs/EVALS.md`.

## Safety Rules

- Never open the source snapshot DB as the writable eval DB.
- Always copy first, then open the copy.
- Do not add filesystem copy behavior to `src/core/`.

## Tests

- validation accepts `fixture` and valid `snapshot_copy`
- validation rejects malformed `snapshot_copy`
- copied snapshot runs successfully
- source snapshot is unchanged after the run
- fixture overlays still work on top of copied snapshots
- preserve mode keeps the copied sandbox for inspection

## Acceptance Criteria

- a recall eval case can run against a copied snapshot DB
- the response includes snapshot metadata when replay mode is used
- the source DB remains untouched
- all existing fixture-only recall eval tests still pass

## Codex Handoff

Implement Phase 1 of the corpus-backed eval plan in `agenr`.

Requirements:
- Add snapshot-backed replay support to the recall eval seam.
- Extend the recall sandbox request contract with a `corpusSeed` union supporting `fixture` and `snapshot_copy`.
- For `snapshot_copy`, copy the provided snapshot DB into the isolated sandbox before opening it.
- Preserve current fixture-only behavior when the field is omitted.
- Allow `memoryPool` overlays on top of the copied snapshot.
- Add strict request validation and response metadata for the snapshot.
- Update `docs/EVALS.md`.

Guardrails:
- Do not mutate the source DB.
- Keep filesystem work out of `src/core/`.
- Keep the current eval seam narrow and deterministic.

Verification:
- Add tests for validation, copied snapshot setup, overlay behavior, and source DB immutability.
