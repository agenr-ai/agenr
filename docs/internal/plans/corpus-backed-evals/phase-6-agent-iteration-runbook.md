# Phase 6 - Agent Iteration Runbook

## Goal

Document a repeatable workflow that lets Codex use the replay substrate and the OpenClaw debug sink to improve `agenr` iteratively.

This is the operational layer that turns the technical substrate into a usable tuning loop.

## Target Workflow

1. Create or select a corpus snapshot.
2. Start the internal eval server.
3. Run a replay manifest or replay suite.
4. Inspect the report and dominant failure cluster.
5. Open one or more representative case artifacts.
6. Patch `agenr`.
7. Rerun the affected slice.
8. Rerun the full replay suite.
9. Compare the new run against the previous run.
10. Promote any newly discovered failure mode into a permanent replay case.

## Required Documentation

The runbook should include:

- how to create a safe snapshot copy from the sandbox or production-like DB
- how to start the internal eval server
- how to run replay manifests
- how to enable the OpenClaw `agenr` debug sink
- where artifacts and JSONL logs live
- how to compare runs
- how to decide whether a failure belongs in `agenr` or `agenr-evals`

## Operational Rules

- Always evaluate against a copied snapshot, never the live DB.
- Use fixture suites for fast regression checks.
- Use replay suites for realistic relevance pressure.
- Use OpenClaw debug logs for runtime path inspection, not as a replacement for replay artifacts.
- Promote confirmed failures into named replay cases.

## Deliverables

- runbook doc in `agenr-evals` or shared docs, depending on where it is most actionable
- example commands
- example artifact and log locations
- troubleshooting notes for common failures

## Acceptance Criteria

- a new Codex session can follow the runbook end to end
- the runbook is sufficient to reproduce the patch-rerun-compare loop
- the workflow clearly distinguishes replay artifacts from live OpenClaw debug logs

## Codex Handoff

Implement Phase 6 of the corpus-backed eval plan as documentation and operational polish across `agenr` and `agenr-evals`.

Requirements:
- Write a concrete runbook for the iterative tuning workflow.
- Include commands, artifact locations, log locations, and troubleshooting.
- Make the workflow usable by Codex without hidden operator knowledge.

Guardrails:
- Keep the runbook aligned with the actual implemented commands and file paths.
- Prefer concise operational guidance over broad architecture explanation.

Verification:
- Dry-run the documented commands and paths against the implemented substrate.
