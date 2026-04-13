---
name: architecture-review
description: Review agenr architecture for layering, ownership, dead code, duplicate paths, and hexagonal-boundary drift. Use when the user asks for an architecture review of the whole system or a specific slice such as core, app, adapters, cli, or a subsystem like surgeon, recall, ingest, episodes, or openclaw.
---

# Architecture Review

Use this skill for architecture reviews in the `agenr` repository at `/Users/jmartin/Code/agenr`.

This is a code-grounded review workflow, not a generic design essay. Start from the owning docs, but let the code win when docs and implementation disagree.

## Review Targets

This skill can be applied to:

- the whole repo
- one horizontal layer such as `core`, `app`, `adapters`, or `cli`
- one vertical slice such as `surgeon`, `recall`, `ingest`, `episodes`, `store`, `openclaw`, or `evals`
- one boundary or seam such as `app <-> adapters`, `adapters <-> cli`, or a DB-backed port

If the user names a target, use it. If the request is broad, infer the most relevant slice and state the assumed scope.

## Start Here

Read only the docs that own the requested slice. Common anchors:

- `/Users/jmartin/Code/agenr/AGENTS.md`
- `/Users/jmartin/Code/agenr/docs/ARCHITECTURE.md`
- subsystem docs under `/Users/jmartin/Code/agenr/docs/`

Then map the actual code in:

- `/Users/jmartin/Code/agenr/src/core/`
- `/Users/jmartin/Code/agenr/src/app/`
- `/Users/jmartin/Code/agenr/src/adapters/`
- `/Users/jmartin/Code/agenr/src/cli/`
- relevant tests under `/Users/jmartin/Code/agenr/tests/`

## What To Audit

Check the selected scope for:

- dead code, stale compatibility shims, unused exports, and paths no longer exercised
- duplicate or near-duplicate implementations
- fake seams that add indirection without architectural value
- hexagonal-boundary violations
- business logic drifting into adapters, DB query helpers, or CLI handlers
- orchestration logic that should live in `app/` but leaked elsewhere
- infrastructure concerns leaking into `core/`
- docs drift between subsystem docs and implementation

Always evaluate the intended layering:

- `src/core/` is pure domain logic
- `src/app/` owns orchestration
- `src/adapters/` translates external systems into app/core calls
- `src/cli/` stays thin

## Audit Method

Follow this sequence:

1. Define the scope precisely.
2. Read the owning docs for that scope.
3. Map the execution flow and import graph for the relevant slice.
4. Identify entry points, orchestration, domain logic, adapters, persistence touchpoints, and tests.
5. Trace what is actually used versus merely exported.
6. Separate confirmed findings from weaker suspicions.

Use concrete evidence:

- file paths
- symbols
- import relationships
- call chains
- command paths
- tests that do or do not cover the path

Prefer `rg` for code discovery and import tracing.

## Layer-Specific Questions

### Core

- Is `core/` pure and infrastructure-agnostic?
- Does `core/` import from adapters, CLI, global logging, filesystem helpers, or process controls?
- Are domain rules fragmented across other layers instead of being centralized here?

### App

- Does `app/` own multi-step workflows and orchestration?
- Has orchestration leaked into CLI handlers or adapters?
- Are ports and workflow boundaries coherent, or is `app/` just relaying calls?

### Adapters

- Are adapters translating external systems, or owning business logic?
- Are DB query modules encoding domain policy that belongs in `core/` or `app/`?
- Are adapter namespaces real integration boundaries, or mostly pass-through wrappers and re-exports?

### CLI

- Is the CLI limited to parsing, wiring, invoking services, and formatting output?
- Does the CLI contain policy or workflow decisions that belong in `app/`?

## Review Heuristics

- Be suspicious of parallel surfaces with the same names across `app/` and `adapters/`.
- Be suspicious of modules that mostly re-export another layer.
- Be suspicious of query helpers that decide policy rather than retrieve data.
- Be suspicious of subsystem-specific logic implemented independently in more than one layer.
- If a suspicious seam is justified, say so explicitly and explain why it exists.

## Output Format

Put findings first, ordered by severity.

For each finding include:

- severity
- concise title
- why it is a problem
- exact file references
- the architectural principle being violated, if any
- a concrete recommended fix

After findings, include these sections when applicable:

- `Architecture Map As Implemented Today`
- `Dead Code / Redundant Surface Candidates`
- `Duplicate Code Paths / Ownership Drift`
- `Refactor Plan`
- `Open Questions / Assumptions`

## Writing Rules

- Do not give generic architecture advice.
- Ground every claim in this codebase.
- Be explicit about what is actually wrong versus merely inelegant.
- If evidence is incomplete, mark the point as a suspicion rather than a confirmed finding.
- Keep summaries brief. The primary value is concrete findings and defensible reasoning.
