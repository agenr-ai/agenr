# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Memory infrastructure for AI agents. The current system stores durable entries, generates episodic session summaries, runs hybrid entry recall plus time-aware episode recall, exposes a live OpenClaw memory plugin, maintains corpus health through surgeon, and keeps a narrow internal recall-eval HTTP seam for `agenr-evals`.

Claim-key lifecycle management is a first-class part of the product. Durable memory, surgeon maintenance, and the repo-local claim-key scenario harness all depend on it.

## Read This First

`AGENTS.md` should stay short and operational. It is the quick-start and guardrail document for coding agents, not the full architecture spec.

When you need subsystem detail, use the docs that already own it:

- Architecture and repository shape: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Durable ingest and episode ingest: [`docs/INGEST.md`](./docs/INGEST.md)
- Recall and unified recall: [`docs/RECALL.md`](./docs/RECALL.md)
- Episodic memory model: [`docs/EPISODES.md`](./docs/EPISODES.md)
- Store pipeline and direct write paths: [`docs/STORE.md`](./docs/STORE.md)
- Surgeon runtime, passes, and safety model: [`docs/SURGEON.md`](./docs/SURGEON.md)
- OpenClaw integration and plugin behavior: [`docs/OPENCLAW-PLUGIN.md`](./docs/OPENCLAW-PLUGIN.md)
- Internal recall-eval seam: [`docs/EVALS.md`](./docs/EVALS.md)

If this file and the code disagree, the code wins. If this file and one of the docs above disagree, check the code and update the doc that owns the topic.

## Stack

- TypeScript, ESM, Node.js 24+
- libsql/SQLite for storage (`@libsql/client`)
- libsql vector indexes for entry and episode embeddings when supported
- OpenAI-compatible embeddings via `text-embedding-3-small` (1024 dims)
- `commander` for CLI argument parsing
- `@clack/prompts` for interactive CLI flows
- `chalk` for CLI output
- `openclaw` for the production host integration
- `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` for surgeon runtime loops
- pnpm (not npm/yarn)
- vitest for tests, tsup for builds, eslint + prettier for validation

## Core Guardrails

The architecture details live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The rules below are repeated here because they are the ones agents are most likely to violate during edits.

- `src/core/` never imports from `src/adapters/`, `src/cli/`, or process-global logging and filesystem helpers.
- `src/core/` is pure domain logic. No file system, database, HTTP, process-global logging, or `process.exit()`.
- `src/core/types.ts` is the canonical home for domain types.
- `src/core/ports.ts` is the canonical home for formal core ports.
- `src/app/` owns orchestration. Do not move multi-step workflows into CLI handlers or adapters unless they are truly adapter-specific.
- `src/adapters/` translates external systems into core and app calls. Do not let adapters turn into cross-cutting business logic sinks.
- `src/cli/` stays thin: parse args, wire dependencies, invoke app/core services, format output.
- `src/adapters/openclaw/` must keep filesystem work async. Use `node:fs/promises`, never sync filesystem helpers.
- `src/core/` and `src/adapters/openclaw/` must not terminate the host process.
- Env flags must use explicit string comparisons such as `"true"` or `"1"`. Never rely on truthiness of `process.env.*`.

## Subsystem Ownership

Do not re-derive subsystem behavior from memory. Start from the owning doc:

- Durable ingest and transcript extraction behavior: [`docs/INGEST.md`](./docs/INGEST.md)
- Claim-key-aware store pipeline details: [`docs/STORE.md`](./docs/STORE.md)
- Entry recall, episode recall, unified routing, and telemetry: [`docs/RECALL.md`](./docs/RECALL.md)
- Episode lifecycle and historical-memory semantics: [`docs/EPISODES.md`](./docs/EPISODES.md)
- Surgeon passes, presets, safety guards, and runtime flow: [`docs/SURGEON.md`](./docs/SURGEON.md)
- OpenClaw hooks, tools, prompt injection, continuity, and memory runtime behavior: [`docs/OPENCLAW-PLUGIN.md`](./docs/OPENCLAW-PLUGIN.md)
- Eval transport boundaries and non-goals: [`docs/EVALS.md`](./docs/EVALS.md)

## OpenClaw Boundary

The OpenClaw plugin is a translator, not a second memory brain. Use [`docs/OPENCLAW-PLUGIN.md`](./docs/OPENCLAW-PLUGIN.md) for the full map.

As a quick rule:

1. Shared durable-memory, recall, episode, and claim-key logic belongs in `core/` or `app/`.
2. OpenClaw hook wiring, tool schemas, session identity helpers, transcript normalization, continuity rendering, and memory-runtime integration belong in `src/adapters/openclaw/`.
3. If another future adapter would need the behavior, it probably does not belong in the plugin.

## Recall-Eval Guardrails

The internal eval seam is intentionally narrow. See [`docs/EVALS.md`](./docs/EVALS.md) for the exact code map and surface.

Keep these rules in mind:

1. `agenr` owns only the execution seam for recall evals.
2. `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and reporting.
3. Keep transport limited to the single internal recall-case HTTP route and its validation contract.
4. Do not add eval-only CLI commands as the main transport.
5. Do not add a broad memory-management API under the eval adapter.

## CLI Surface

The detailed command behavior lives in the subsystem docs above. Current CLI entry points are:

```text
agenr init
agenr setup
agenr ingest <path>
agenr ingest entries <path>
agenr ingest episodes [path]
agenr recall <query>
agenr trace
agenr surgeon run
agenr surgeon status
agenr surgeon history
agenr surgeon backlog
agenr surgeon actions <runId>
agenr surgeon proposals <runId>
agenr surgeon review <proposalId>
agenr scenarios list
agenr scenarios run
agenr db reset
```

OpenClaw also exposes these runtime tools:

```text
agenr_store
agenr_recall
agenr_retire
agenr_update
agenr_trace
```

## Sandbox

Development uses the isolated sandbox under `~/.openclaw-sandbox/`.

Useful commands:

- `sandbox-agenr` - run the agenr CLI against the sandbox DB
- `sandbox-openclaw` - run the OpenClaw gateway loading the local plugin build
- `pnpm build` then `sandbox-agenr <command> --verbose`
- `sqlite3 ~/.openclaw-sandbox/agenr-data/knowledge.db "SELECT ..."` to inspect state

## Common Commands

```bash
pnpm install
pnpm build
pnpm build:debug
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm test
pnpm check
```

## Testing

- Run `pnpm check` before committing when code changes are involved.
- `pnpm typecheck:tests` validates the Vitest suite under `tests/`.
- Tests live in `tests/` and mirror major feature areas.
- Core logic is primarily tested with doubles around ports.
- Adapters are exercised with focused integration tests.
- Claim-key scenarios have dedicated fixture-backed runtime tests.
- When fixing a bug, add a regression test.

## Code Style

- No `any` types.
- Never add `@ts-nocheck` or broad lint suppressions by default. Fix the root cause first.
- Prefer real types, `unknown`, or a narrow helper or adapter over `any`.
- Errors should be descriptive and actionable.
- Keep functions focused.
- At external boundaries such as config, persisted JSON, CLI JSON output, and third-party responses, prefer explicit validation using existing repo helpers.
- Prefer discriminated unions when input shape changes runtime behavior.
- Do not use freeform strings as the source of truth for control flow when a closed union or typed code is reasonable.
- Avoid magic sentinel values such as empty strings, empty objects, or silent `?? 0` fallbacks when they can change behavior implicitly.
- No em-dashes - use hyphens.
- If lazy loading is needed, use a dedicated runtime boundary and do not mix static and dynamic imports for the same module in production paths.
- Prefer composition over inheritance.
- Do not share behavior through prototype mutation. Prefer composition or explicit inheritance.
- In tests, prefer per-instance stubs over prototype patching unless there is a documented reason to patch the prototype.
- Add brief comments for tricky or non-obvious logic.
- Use `type` imports where applicable.
- Add Google-style JSDoc on exported functions, interfaces, and types.
- Use American English spelling in code comments, docs, and user-facing strings.
- Follow SOLID principles.

## Repo Workflow

1. Issue first for non-trivial feature or bug work.
2. Branch from local `master`.
3. Keep `master` linear.
4. Prefer small, reviewable commits.
5. Delete merged branches when they are no longer needed.

## Completion Checklist

Before pushing:

- [ ] `pnpm check` passes when the change affects code or runtime behavior
- [ ] Docs updated for user-facing changes
- [ ] No `any` types introduced
- [ ] No em-dashes in modified files
- [ ] Core still has zero imports from adapters
- [ ] New tests for new behavior
