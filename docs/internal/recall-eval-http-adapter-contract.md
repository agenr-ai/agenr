# Recall eval HTTP adapter contract

Date: 2026-03-27

This note captures the Phase 1 contract slice for the internal recall eval adapter in `agenr`.

## Route

- `POST /internal/evals/recall/run`
- Purpose: accept one recall eval case request, validate it at the HTTP boundary, and delegate to the app-layer `runRecallEvalCase()` service
- Scope: internal and dev-facing only

## Request contract

`RecallEvalCaseRequest` lives in [src/app/evals/recall/contracts.ts](/Users/jmartin/Code/agenr/src/app/evals/recall/contracts.ts).

Top-level fields:

- `caseId` - required string
- `description` - optional string
- `sandbox` - optional `{ root?: string; preserve?: boolean }`
- `memoryPool` - required array of explicit fixture entries
- `recallRequest` - required recall query aligned to current `RecallInput` fields
- `options` - optional diagnostic and timing flags

Fixture entries stay explicit and narrow. They align to current `EntryType` and `Expiry` values and do not add project-scoped concepts that `agenr` does not support.

## Response contract

`RecallEvalCaseResponse` also lives in [src/app/evals/recall/contracts.ts](/Users/jmartin/Code/agenr/src/app/evals/recall/contracts.ts).

Top-level fields:

- `status`
- `caseId`
- `result`
- `diagnostics`
- `timings`
- `sandbox`
- `error`

Phase 1 returns a placeholder success envelope from `runRecallEvalCase()` with:

- empty `result.entries`
- empty `result.entryIds`
- optional typed placeholder diagnostics under `diagnostics.execution`
- optional timings and sandbox echo data

Invalid request payloads are rejected at the HTTP boundary with a structured `invalid_request` error response. That response is route-specific and is not the app-service contract.

## What Phase 1 does not implement

- isolated sandbox provisioning
- fixture seeding into a real eval database
- real recall execution
- live recall diagnostics collection
- artifact writing
- additional eval routes or eval domains

## Ownership split

- `agenr` owns the execution seam, request validation, route mapping, and the typed app-level contract
- `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and artifact policy

Phase 2 should keep the same route and app-service shape and replace the placeholder internals behind `runRecallEvalCase()`.
