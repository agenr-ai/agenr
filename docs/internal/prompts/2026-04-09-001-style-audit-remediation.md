# Codex Prompt: Style Audit Remediation

You are working in the `agenr` repository.

Start by reading these files:

- `AGENTS.md`
- `docs/internal/plans/2026-04-09-style-audit-report.md`

Your job is to reduce real style debt revealed by the audit without applying mechanical churn where the current code is already correct.

## Goal

Bring the codebase closer to the coding-style rules in `AGENTS.md`, with emphasis on high-signal fixes that improve correctness and maintainability.

Do not try to "fix every grep hit". The audit report is a candidate finder, not a source of truth.

## Priorities

### 1. Remove avoidable suppressions

The audit found 14 TypeScript or ESLint suppressions, mostly `jsdoc/require-jsdoc`.

Target files:

- `src/core/claim-key-entity-family.ts`
- `src/core/claim-key-slot-resonance.ts`
- `src/app/surgeon/claim-key-quality.ts`
- `src/cli/commands/setup/stages.ts`
- `src/core/episode/summary-prompt.ts`
- `src/core/episode/transcript-render.ts`
- `src/adapters/openclaw/session/transcript-files.ts`
- `src/adapters/openclaw/tools/shared.ts`
- `src/adapters/openclaw/episode/episode-summary-prompt.ts`

Fix the root cause where practical by adding concise JSDoc to exported helpers or restructuring code so the suppression is unnecessary.

### 2. Reduce stringly typed machine state

The audit found 16 `reason: string`, `error: string`, and similar fields.

Only change the cases where strings are acting as machine-readable control state or structured error channels.

Good candidates:

- `src/app/recall/types.ts`
- `src/app/surgeon/ports.ts`
- `src/app/surgeon/service.ts`
- `src/app/surgeon/claim-key-quality.ts`
- `src/adapters/db/surgeon-run-log.ts`
- `src/app/scenarios/claim-keys/deterministic-fixtures.ts`

Do not replace genuinely human-readable explanatory text just for style compliance. For example, descriptive rationales or log text can remain strings when they are not used as closed control-flow codes.

### 3. Review `?? 0` in production control flow

The audit found 107 `?? 0` matches. Many are correct numeric defaults, especially in tests and counters.

Focus only on production code where `?? 0` may hide missing state or alter branch semantics.

Highest-value candidates:

- `src/adapters/db/surgeon-queries.ts`
- `src/app/surgeon/service.ts`
- `src/app/surgeon/budget.ts`
- `src/app/surgeon/completion-guard.ts`
- `src/app/surgeon/claim-key-quality.ts`
- `src/app/surgeon/tools/query.ts`
- `src/app/surgeon/tools/supersession-query.ts`
- `src/app/surgeon/tools/recall-sim.ts`
- `src/core/recall/search.ts`
- `src/app/recall/unified.ts`
- `src/cli/commands/surgeon.ts`

Leave clearly correct accumulator, stats, and test-fixture defaults alone unless a better expression is obviously clearer.

### 4. Tighten raw parsing at external boundaries

The boundary-parsing section is intentionally broad and includes many valid uses of parser helpers and TypeBox schemas. Do not churn the files that are already validating inputs explicitly.

Prioritize raw `JSON.parse(...)` or similar parsing sites that appear to lack an immediate typed validation step.

Highest-value review candidates:

- `src/config.ts`
- `src/app/scenarios/claim-keys/fixture-loader.ts`
- `src/app/scenarios/claim-keys/load-scenarios.ts`
- `src/adapters/db/row-mapping.ts`
- `src/adapters/db/surgeon-run-log.ts`
- `src/adapters/llm.ts`
- `src/adapters/openclaw/session/sessions-store-reader.ts`
- `src/cli/commands/init/external-commands.ts`

Use existing repo validation helpers and patterns where possible. Do not introduce a brand-new validation library or rewrite already-good TypeBox/manual validation flows.

## Explicit non-goals

- Do not touch prototype-mutation patterns unless you find a real one outside the audit report. The audit found none.
- Do not refactor dynamic imports. The audit found no production-path dynamic imports.
- Do not convert all `reason: string` fields into enums blindly.
- Do not rewrite large sections of code solely to satisfy grep-based style rules.
- Do not change unrelated architecture or behavior.

## Acceptance criteria

1. The touched code follows the style rules in `AGENTS.md`.
2. Behavior remains unchanged except where a style fix requires a safer representation.
3. Tests are added or updated when behaviorally meaningful.
4. `pnpm check` passes.
5. `pnpm style:audit` is rerun and the report improves in the categories you addressed.

## Output expectations

When you finish:

- summarize what you changed by category
- call out any audit findings you intentionally left unchanged and why
- report the before/after audit counts for the categories you addressed
