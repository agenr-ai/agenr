# Corpus-Backed Evals

This directory holds the implementation plan for adding corpus-backed replay evals, richer replay artifacts, and an `agenr`-only OpenClaw debug log that does not get buried in host runtime noise.

The plan is split into one shared spec and a set of implementation phases that can each be handed to Codex independently.

## Documents

- `implementation-spec.md` - full system design, constraints, contracts, ownership, and milestone map
- `phase-1-snapshot-backed-recall-evals.md` - add snapshot-backed recall replay against a copied corpus DB
- `phase-2-snapshot-backed-before-turn-evals.md` - extend the same model to before-turn evals
- `phase-3-rich-replay-artifacts.md` - add stable debug-artifact payloads for replay analysis
- `phase-4-openclaw-agenr-debug-sink.md` - add an `agenr`-only JSONL debug sink for live OpenClaw runs
- `phase-5-replay-corpora-and-analysis.md` - build replay corpora and run-comparison tooling in `agenr-evals`
- `phase-6-agent-iteration-runbook.md` - document the repeatable agent workflow for iterative tuning

## Core Position

The system should have two loops:

1. Offline replay against a copied production-like corpus snapshot.
2. Live OpenClaw debugging with a separate `agenr` debug log file.

The loops should share one observability model:

- `src/core/` emits typed trace summaries and decision outputs only
- `src/app/` assembles diagnostics
- `src/adapters/` decide whether to write JSONL logs, eval artifacts, or concise host logs

## Guardrails

- Do not add filesystem or process-global logging dependencies to `src/core/`.
- Do not run evals directly against the source corpus database.
- Do not dump raw unbounded candidate lists into normal runtime logs.
- Keep detailed debugging behind explicit flags and adapter-owned sinks.

## Recommended Execution Order

1. Phase 1
2. Phase 3
3. Phase 2
4. Phase 4
5. Phase 5
6. Phase 6

That order yields the smallest useful loop early: real-corpus replay plus inspectable artifacts.
