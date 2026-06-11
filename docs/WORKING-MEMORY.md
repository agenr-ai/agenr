# Working Memory

This document owns agenr's working-memory subsystem. It describes scoped, mutable work-in-progress state for live agent tasks. Working memory is separate from durable memory, episodes, and procedures: it is transient task state with explicit lifecycle and promotion seams.

If this document and the code disagree, the code wins.

## Purpose

Working memory keeps active work resumable without turning every in-flight note into durable truth. It is used for:

- session-local progress such as scratchpads, files touched, commands run, blockers, assumptions, decisions, and next actions
- explicit goal state, budgets, continuation policy, and status
- checkpoint refreshes before compaction, shutdown, handoff, fork, or other lifecycle transitions
- candidate memories that can later be promoted into episodic, semantic, or procedural memory

Do not use working memory as a replacement for durable facts. A rendered working-context block is model context for the current turn only and must lose to current user input, live filesystem state, git state, tests, tool output, and explicit durable memory when those conflict.

## Code Map

- `src/app/working-memory/` - app-owned service, handlers, scope resolution, selection, snapshot mutation, projection rendering, lifecycle checkpoint refresh, and validation.
- `src/adapters/db/working-memory-repository.ts` - libSQL repository for `working_sets` and `working_events`.
- `src/adapters/shared/work-*.ts` - shared `agenr_work` schema, parser, policy, presentation, and runner helpers.
- `src/adapters/shared/session-working-set-lifecycle.ts` - shared ensure and close helpers for independent session working sets.
- `src/adapters/shared/injection/working-context-projection.ts` - adapter helper for injecting rendered projections.
- `src/adapters/openclaw/tools/work.ts` and `src/adapters/skeln/tools/work.ts` - host tool bindings.
- `src/adapters/shared/goal-tools.ts` and `src/adapters/shared/goal-tool-presentations.ts` - Skeln goal alias bindings and formatting.

## Data Model

Working memory is persisted in schema v11 tables:

- `working_sets` stores one row per scoped active or closed working set.
- `working_events` stores an ordered append-only event ledger for each set.

`WorkingSetRecord` is the app-layer row shape. Its important fields are:

- `id` - primary key for direct lookup and explicit mutations.
- `scopeKey` and `scopeKind` - canonical scope used for selection and one-open-set cardinality.
- `status` - lifecycle state such as `active`, `paused`, `blocked`, `waiting`, `needs_review`, `budget_limited`, `complete`, `closed`, or `abandoned`.
- `snapshot` - authoritative JSON task-state payload.
- `revision` - monotonic optimistic-concurrency number advanced by semantic writes.
- scope columns such as `sessionId`, `conversationKey`, `cwd`, `gitRoot`, `gitBranch`, `project`, and `taskId` for provenance and indexed lookup.
- audit columns such as `source`, `createdAt`, `updatedAt`, `lastActiveAt`, `closedAt`, `closeReason`, and `episodeId`.

Top-level row columns mirror selected facts for selection, audit, and indexing. Task content lives in `snapshot`.

`WorkingEventRecord` stores:

- `workingSetId`
- monotonic `sequence`
- closed `eventType`
- JSON payload
- optional `actor`, `source`, `hostEventId`, `turnId`
- `createdAt`

The event ledger is the audit trail for how the snapshot reached its current state. Snapshot reads are the live fast path.

## Scopes and Layers

Working memory has two layers:

- Session layer - independent session working sets for ordinary multi-turn work.
- Goal layer - explicit goal working sets for goal-directed work and long-running continuation.

Session working sets require a host `sessionId`. The session scope key includes `cwd` when available so independent sessions in different directories do not collide.

Goal working sets resolve in priority order:

1. `taskId`
2. `conversationKey`
3. `gitRoot` plus `gitBranch`
4. `gitRoot` plus `cwd`

If none of those facts exist, goal scope resolution fails with `missing_scope`.

The model-facing target choices are:

- `target: "session"` - use the independent session working set.
- `target: "goal"` - use the explicit goal working set.
- `target: "auto"` - prefer the goal set when goal sets are enabled and one exists, otherwise use the session set.

An explicit `workingSetId` wins over target selection, but host policy can still reject a selected goal set when goal working sets are disabled.

## Snapshot Shape

The snapshot is the single source of task-state truth. It can contain:

- `objective`, `summary`, `currentPlan`, `nextActions`, and `completedSteps`
- `checkpoint` for handoff, compaction, fork, or shutdown
- `scratchpad` for freeform transient notes
- `files`, `commands`, `decisions`, and `assumptions`
- `blockers`
- `candidates` for later promotion
- `continuation` policy and timing state
- `budgets` for token, wall-clock, turn, and review limits
- `lastMaterialChange`

Growth is bounded in `src/app/working-memory/limits.ts`: the scratchpad is capped at 8 KiB; arrays such as files, commands, decisions, assumptions, and candidates retain the newest 50 unique entries; rendered `<agenr_work_context>` content is capped at 32 KiB and includes a visible truncation marker when trimmed.

When a goal is created from an existing session set, agenr copies only forkable task context such as plan, next actions, checkpoint, scratchpad, files, commands, decisions, and assumptions. Goal identity fields such as `objective`, `goalGeneration`, and `summary` are not copied from the session set.

## Operations and Trust

The shared tool action union is:

- `get`
- `list`
- `create`
- `update`
- `close`

Model-visible update operations are intentionally narrow:

- `set_objective`
- `replace_plan`
- `merge_checkpoint`
- `set_scratchpad`
- `add_file_note`
- `add_command_note`
- `record_decision`
- `record_assumption`
- `set_next_actions`
- `add_candidate`

Host-only operations are not exposed in the normal model schema:

- `set_status`
- `configure_budget`
- `account_usage`
- `set_continuation_policy`

Trusted host surfaces are `goal_command`, `lifecycle_hook`, and `consolidation_job`. They may perform host-only operations and may close working sets through trusted paths. Normal model tool calls use source `tool`.

Actors are tracked as `model`, `user`, `runtime`, or `system`. Sources are tracked as `tool`, `goal_command`, `lifecycle_hook`, or `consolidation_job`.

Existing-set `update` and `close` operations require the caller's observed `expectedRevision` unless the mutation comes from a trusted host path that is allowed to default the current revision. Revision mismatches fail closed instead of overwriting newer state.

Model callers cannot enable autonomous continuation by ordinary `agenr_work` writes. Idle continuation policy, budget accounting, pause, resume, and runtime heartbeat metadata belong to trusted host paths.

## Projection and Injection

Agenr renders working memory as a non-persistent `WorkingContextProjection`:

```ts
interface WorkingContextProjection {
  kind: "working_set";
  renderMode: "stub" | "full";
  content: string;
  workingSetId?: string;
  revision?: number;
  sourceRef: string;
  byteLength: number;
}
```

A full projection is rendered inside `<agenr_work_context>`. It starts by telling the model that this is transient working memory for the current task, not durable truth. It can include the session working set, a goal working set, or both depending on host policy and selection.

Stub projections are used when working memory is disabled, no active set exists, scope is ambiguous, runtime composition is misconfigured, or selection fails. Stubs carry no durable facts.

Hosts may persist a compact audit pointer, but not replay text:

```ts
interface WorkingContextAuditPointer {
  source: "agenr_work";
  workingSetId: string;
  revision: number;
  sourceRef: string;
  bytes: number;
  summary?: string;
}
```

Rendered `<agenr_work_context>` must not be appended to persisted session messages. Compaction, branch summarization, transcript ingestion, and episode mining should exclude the rendered block by default. If a host needs auditability, it should store the pointer above.

## Lifecycle

### Ensure

Host adapters ensure the independent session working set at session start through `ensureSessionWorkingSet`. The shared helper `ensureHostSessionWorkingSet` first checks runtime capability state, then creates or reuses the active session set for the resolved scope.

### Checkpoint

Lifecycle hooks can merge a checkpoint into the active session working set:

- compaction checkpoint refresh merges the compaction summary when a `compaction_checkpoint` artifact is accepted
- shutdown checkpoint refresh records that shutdown occurred and tells a future agent to resume from the latest snapshot

These refreshes are best-effort and non-atomic with session-memory artifact intake. A stored compaction artifact is not rolled back if working-memory refresh fails.

### Close

Closing is explicit. A working set can close normally or be abandoned. Close writes a terminal event and moves the set to `closed` or `abandoned`.

Host session shutdown closes the independent session working set through lifecycle code in current host adapters. Explicit goal close is separate and remains host-controlled.

Closed sets can retain the final snapshot and candidate list for later review. The event ledger supplies provenance for any generated candidates.

## Candidate Promotion

Working sets can accumulate candidate memories:

- `episodic` candidates carry a summary and evidence event sequences.
- `semantic` candidates carry suggested durable subject, content, optional claim key, and evidence event sequences.
- `procedural` candidates carry suggested procedure subject, content, and evidence event sequences.

Candidate status is `pending`, `promoted`, or `dismissed`.

The working-memory subsystem only records candidates and their provenance. Promotion into `episodes`, `durables`, or `procedures` must go through the owning subsystem path so validation, claim-key policy, procedure normalization, embeddings, and audit behavior remain centralized.

One episodic promotion path is wired in production today. When a Skeln goal close emits a pending episodic candidate, the adapter writes a goal-close episode through the episode subsystem, feeding a bounded distillation of the closing snapshot (objective, final checkpoint, plan state, decisions, assumptions, blockers) to summary generation alongside the transcript. On success, `recordWorkingSetEpisodicPromotion` flips the pending episodic candidates on the closed set to `promoted` and records the emitted episode id on the row's `episodeId` column. This bookkeeping write requires a close-managed status, does not advance the revision, and does not append ledger events. See [`docs/EPISODES.md`](./EPISODES.md) for the episode-side behavior.

## Feature Flags and Capabilities

`features.workingMemory` enables the working-set ledger, `agenr_work`, trusted host work commands, and transient projection rendering. Runtime capability checks still fail closed when the feature is enabled but repositories are missing or runtime composition is unavailable.

Related session-memory feature flags are independent:

- `features.sessionTreeLineage`
- `features.sessionTreeCompaction`
- `features.goalContinuation`

Session-tree compaction can refresh working checkpoints when working memory is available, but session-memory artifacts and working-memory snapshots remain separate storage concepts.

## Host Policy Differences

OpenClaw and Skeln share the app service, repository, scope resolver, mutation model, projection renderer, and tool schema helpers. Their differences are adapter policy and host surface differences.

OpenClaw:

- registers `agenr_work` along with durable memory tools
- uses session working sets only
- does not register goal aliases
- blocks model-facing close and trusted host-only mutations
- ensures the session set at `session_start`
- injects the rendered projection through `before_prompt_build` by merging it into `prependContext`
- closes the independent session set at `session_end`

Skeln:

- registers `agenr_work` plus Codex-compatible `get_goal`, `create_goal`, and `update_goal` aliases when goals are enabled
- supports both session and goal working sets
- can disable goal working sets while keeping the session working set and `agenr_work`
- injects the rendered projection via non-persistent `transientMessages`
- uses trusted controller commands for `/goal`, budget accounting, continuation policy, and external goal mutation preparation
- owns the runtime loop for autonomous continuation and delegates eligibility checks through agenr services

Adapter-specific wiring belongs in [`docs/OPENCLAW-PLUGIN.md`](./OPENCLAW-PLUGIN.md) and [`docs/SKELN-PLUGIN.md`](./SKELN-PLUGIN.md). Shared semantics belong here.
