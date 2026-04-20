# Phase 4 - OpenClaw Agenr Debug Sink

## Goal

Add a dedicated `agenr`-only JSONL debug sink for live OpenClaw runs so detailed recall and before-turn decisions can be inspected without host debug noise.

## Problem Being Solved

OpenClaw host logs are useful, but they are not a good substrate for iterative tuning of `agenr`.

The missing piece is a separate file containing only `agenr` events such as:

- tool calls and results
- unified recall decisions
- session-start recall summaries
- before-turn decisions
- continuity-resolution summaries
- structured errors

## Scope

In scope:

- add explicit OpenClaw plugin config for debug logging
- create a JSONL sink in `src/adapters/openclaw/`
- wire sink lifecycle through the shared OpenClaw services runtime
- emit structured events from recall and before-turn paths

Out of scope:

- replay artifact comparison in `agenr-evals`
- new core tracing systems
- broad host logging changes

## Primary Files

- `src/adapters/openclaw/config.ts`
- `src/adapters/openclaw/openclaw.plugin.json`
- `src/app/openclaw/runtime.ts`
- `src/adapters/openclaw/debug/*`
- `src/adapters/openclaw/tools/recall.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- `docs/OPENCLAW-PLUGIN.md`

## Proposed Config

```ts
debug?: {
  enabled?: boolean;
  logPath?: string;
  eventLevel?: "basic" | "detailed";
  perSessionFiles?: boolean;
  maxTopCandidates?: number;
}
```

## Event Families

- `tool_call`
- `tool_result`
- `unified_recall`
- `session_start_recall`
- `before_turn_decision`
- `continuity_resolution`
- `error`

## Implementation Tasks

1. Extend plugin config validation to support `debug`.
2. Add a small JSONL sink abstraction under `src/adapters/openclaw/debug/`.
3. Create and own the sink lifecycle in `src/app/openclaw/runtime.ts`.
4. Pass the sink through the OpenClaw service bundle.
5. Emit structured recall events from `agenr_recall`.
6. Emit structured session-start and before-turn events from `before-prompt-build`.
7. Keep normal host logs concise.
8. Document the debug config and event model.

## Guardrails

- No filesystem writes from `src/core/`.
- JSONL only for detailed logs.
- No unbounded payloads.
- Debug logging must be opt-in and disabled by default.

## Tests

- config validation accepts valid `debug` blocks and rejects malformed ones
- sink writes JSONL events when enabled
- no file is written when debug is disabled
- recall and before-turn emit expected event shapes
- per-session file mode works if implemented

## Acceptance Criteria

- OpenClaw debug mode produces an `agenr`-only JSONL log
- the log includes recall and before-turn decisions
- detailed data is available without relying on noisy host logs

## Codex Handoff

Implement Phase 4 of the corpus-backed eval plan in `agenr`.

Requirements:
- Add an opt-in `debug` config block to the OpenClaw plugin config.
- Create an `agenr`-only JSONL debug sink owned by the OpenClaw adapter.
- Wire the sink through the shared OpenClaw runtime.
- Emit structured events for recall, session-start recall, before-turn decisions, and errors.
- Update `docs/OPENCLAW-PLUGIN.md`.

Guardrails:
- Keep filesystem work out of `src/core/`.
- Keep normal host logs concise.
- Keep detailed payloads bounded.

Verification:
- Add tests for config validation, sink output, and event emission.
