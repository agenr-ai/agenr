# PRD: Agenr working memory for Skeln

Date: 2026-05-18  
Status: Draft PRD  
Branch: `skeln-working-memory`

## Summary

Add first-class scoped working memory to agenr and expose it to Skeln through provider context hooks and an `agenr_work` tool.

Working memory is the missing layer between:

- ephemeral model context, which disappears across turns, compaction, restarts, and sub-agent boundaries; and
- durable memory, which should contain stable facts, decisions, preferences, lessons, relationships, procedures, and episodes — not every transient bit of work-in-progress state.

The product shape is: **working set snapshot + event log + scoped context injection + explicit close/promotion lifecycle**.

This also makes working memory the staging layer for memory consolidation. As the agent works, raw WIP stays short-term; significant activity becomes episodic memory; stable learnings become semantic long-term candidates; repeated successful patterns can later become procedural memory.

This is inspired by Codex CLI's `/goal` design, but generalized beyond a single active objective. Codex proved the useful pattern: host-owned persisted task state, constrained model tools, hidden contextual turn injection, lifecycle accounting, and optional continuation behavior. Agenr should borrow the pattern while keeping durable truth separate from transient WIP.

## North-star vision: lifelong agent memory

This is bigger than task continuity. Agenr should be the memory substrate that lets a Skeln agent learn throughout its life.

The agent should not be a stateless model repeatedly rehydrated by prompts. It should have a persistent, inspectable, correctable memory system that accumulates experience over days, months, and years:

- **Working continuity:** what the agent is doing right now and what it should do next.
- **Autobiographical continuity:** what happened across tasks, sessions, projects, and relationships.
- **Semantic learning:** stable truths, decisions, preferences, and lessons distilled from experience.
- **Procedural growth:** reusable methods and skills learned from repeated successful work.
- **Identity continuity:** the agent can remember its own commitments, boundaries, habits, and relationship with the user without confusing transient state for truth.

The AGI-ish move is not “more tokens.” It is a lifelong learning loop with provenance, consolidation, forgetting, correction, and authority boundaries.

Working memory is the front edge of that loop.

## Problem

Skeln's current agenr integration is tool-only. The adapter exposes durable memory tools, while `buildSessionStartContext` and `buildBeforeTurnContext` are no-ops. That leaves the model to reconstruct active work from chat history, compaction summaries, filesystem state, git state, and manual recall.

This causes predictable failures:

1. **Compaction loses the task ledger.** The model may retain the high-level goal but lose files inspected, commands run, unresolved questions, assumptions, or next steps.
2. **Durable memory gets abused for WIP.** `entries.expiry = temporary` still behaves like a claim. That is the wrong semantic model for “current scratchpad/task state.”
3. **Session boundaries are too hard.** Work can span multiple Skeln sessions, branches, directories, and sub-agents. Session ID alone is not enough scope.
4. **No authoritative current state exists.** The runtime has pieces of state, the transcript has pieces, and durable memory has selected truths, but no single WIP object says “here is what we are doing right now.”
5. **Promotion is fuzzy.** At the end of a task, we need a clean path from transient WIP → closed episode → durable candidates. Today that boundary depends on model discipline alone.
6. **Memory consolidation is missing.** Long-running agents learn continuously, but agenr currently has no first-class pipeline for turning short-term work state into episodic memory, semantic long-term memory, or procedural candidates without blurring their meanings.

## Product goal

Agenr should provide Skeln with a first-class working-memory layer that makes active work resumable, inspectable, and closeable without polluting durable memory.

The bigger product ambition: working memory should be the state substrate that lets a Skeln agent work on a goal for hours or days. The model context can churn, compact, restart, or hand off between agents; the working set remains the durable operational ledger of objective, checkpoint, plan, progress, blockers, budgets, and next action.

It also ties the memory layers together. Working memory captures the agent's short-term operational state. Periodic checkpoints and task closeout consolidate that state into episodes. Durable conclusions become explicit semantic candidates. Repeated reliable methods can later become procedural candidates.

A fresh model turn should be able to answer:

- What are we working on?
- Why are we doing it?
- What is the current plan?
- What has already been inspected or tried?
- What changed materially since the last turn?
- What are the next steps?
- What is blocked or uncertain?
- What, if anything, should become durable memory when this closes?

## Non-goals

This PRD does **not** propose:

- Replacing durable `entries`, `episodes`, or `procedures`.
- Modeling working memory as temporary semantic entries.
- Capturing hidden chain-of-thought or private reasoning.
- Building a full project/task manager with owners, due dates, calendars, or external ticket sync.
- Automatically promoting WIP to durable semantic memory.
- Requiring Skeln-native event capture in the first phase.
- Implementing Codex-style autonomous continuation in the first phase.
- Making agenr itself a scheduler, executor, or approval authority. Skeln owns runtime execution; agenr owns scoped state.
- Refactoring agenr into cognitive-theory subsystems beyond what the product needs.

## Design principles

### 1. Working memory is not durable truth

A working set may contain hypotheses, stale observations, partial plans, commands attempted, and unresolved questions. It should not participate in semantic recall as trusted claims.

Durable memory remains explicit and high-signal. Working memory is operational state.

### 2. Snapshot plus event log

Use two complementary storage shapes:

- `working_sets`: compact current state optimized for prompt injection.
- `working_events`: append-oriented provenance trail optimized for audit, recovery, and episode creation.

The model should usually see the snapshot plus a small recent/salient event window, not the whole log.

### 3. Agenr owns cognition/state; Skeln owns runtime hosting

Agenr should define the working-memory model, persistence, retrieval, merge semantics, and close/promote lifecycle.

Skeln should provide runtime context and lifecycle events: session, turn, cwd, git root, branch, project/task IDs where available, tool events later, compaction events later.

### 4. Scope first or don't inject

Wrong working memory is worse than missing working memory. Agenr must be conservative about scope matching and explicit about confidence/disambiguation.

### 5. Manual first, native later

Phase 1 should work with an explicit `agenr_work` tool and provider hooks. Native Skeln event capture can come after the data model and workflow prove themselves.

### 6. Promotion is explicit

Closing a working set can produce:

- an episode summary; and
- suggested durable candidates.

It should not silently create semantic `entries`. Durable promotion still goes through `agenr_store` or a future explicit approval flow.

### 7. Working memory is the consolidation staging layer

Long-horizon agents do not just need to remember what to do next; they need a safe path for learnings to mature into the right memory type.

The lifecycle should be:

```text
working events + snapshot
  -> checkpoints / rolling summaries
  -> task/session episodes
  -> durable semantic candidates
  -> optional procedural candidates
```

Each transition changes meaning:

- **Working memory:** short-term operational state, including hypotheses and incomplete work.
- **Episodic memory:** what happened over a bounded task/session, with time, actors, and sources.
- **Semantic memory:** stable distilled truths and decisions worth recalling in future sessions.
- **Procedural memory:** reusable workflows or methods learned from repeated success.

Agenr should support this consolidation pipeline without pretending every intermediate note is trusted long-term truth.

### 8. Long-horizon work requires checkpoints, not longer prompts

The answer to multi-hour or multi-day work is not “make the prompt enormous.” It is disciplined checkpoints.

Every autonomous or semi-autonomous work unit should leave behind enough state for another turn, model, process, or sub-agent to resume safely:

- current objective and success criteria
- last checkpoint / known-good state
- next action queue
- what was tried and what happened
- blockers and required user decisions
- budgets, limits, and stop conditions
- whether the agent is currently allowed to continue

## Users and jobs-to-be-done

### Primary user: Jim working with EJA in Skeln

Jobs:

- Resume a design or implementation thread after compaction or restart.
- Keep momentum across multi-step code/research tasks.
- Let an agent safely work toward a goal over hours or days without losing the plot.
- Avoid re-reading the same files or re-running the same investigation.
- Close a task with a clean episode and durable-memory candidates.

### Agent user: EJA / Skeln model runtime

Jobs:

- Get compact, scoped, trustworthy WIP context before each turn.
- Update the task ledger when facts about the work change.
- Leave resumable checkpoints after each meaningful work unit.
- Separate transient notes from durable memory.
- Ask fewer redundant questions.

### Future user: sub-agents / other agent hosts

Jobs:

- Share scoped task state across parallel research and implementation agents.
- Read a task ledger without seeing irrelevant global memory.
- Contribute bounded findings back to the parent working set.

## Key use cases

### UC1: Resume after compaction

A long design conversation is compacted. On the next turn, Skeln calls `buildBeforeTurnContext`. Agenr returns a scoped `<agenr_work_context>` containing the active objective, design decisions, open questions, files inspected, and next steps.

Acceptance: the model can continue without asking “where were we?” and without recalling durable memory manually.

### UC2: Resume after restart in same repo/branch

Jim opens a new Skeln session in `/Users/jmartin/code/agenr` on branch `skeln-working-memory`. Agenr identifies an active working set by repo + branch + optional session key/project and injects it at session start or before turn.

Acceptance: active work survives process restart.

### UC3: Avoid durable memory pollution

The model records that `src/adapters/skeln/index.ts` was inspected and that hooks are currently no-ops. This is useful WIP but not necessarily a durable claim. It goes into the working set, not `entries`.

Acceptance: `agenr_recall` over durable entries does not return transient file-inspection notes as trusted semantic facts unless they were explicitly promoted.

### UC4: Close a task

The model or user closes the working set. Agenr writes a closed task episode and returns durable-memory candidates such as standing architectural decisions or lessons.

Acceptance: the episode captures what happened; durable candidates are proposed but not automatically stored as semantic entries.

### UC5: Multiple active scopes

Jim has separate work on two branches or projects. `agenr_work list` shows active sets. Before-turn injection chooses only a high-confidence matching set; otherwise it emits a short ambiguity notice or no context.

Acceptance: no cross-project contamination.

### UC6: Hours/days goal execution

Jim gives Skeln a large goal: for example, research an architecture, implement it, run tests, iterate on failures, write docs, and produce a final summary. The agent may run across many turns, compactions, process restarts, sub-agent runs, and user interruptions.

Agenr working memory stores the durable operational ledger: objective, success criteria, plan, checkpoints, next action queue, completed steps, relevant files/commands, blockers, budgets, heartbeats, and durable candidates.

Skeln remains responsible for actually running the loop: starting turns, respecting approvals, enforcing budgets, pausing on user input, and deciding when continuation is allowed.

Acceptance: after any safe stop — compaction, restart, user interrupt, usage limit, or model handoff — a fresh Skeln agent can inspect the working set and continue from the last checkpoint without rereading the whole transcript.

## Product requirements

### P0 requirements

#### P0.1 Working-set storage

Add first-class working-memory tables, conceptually:

```sql
working_sets (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  title TEXT,
  objective TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  snapshot_json TEXT NOT NULL,
  checkpoint_json TEXT,
  budget_json TEXT,
  continuation_policy TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  resume_after TEXT,
  stale_after TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  user_id TEXT,
  project TEXT,
  surface TEXT,
  session_id TEXT,
  session_key TEXT,
  host_thread_id TEXT,
  cwd TEXT,
  git_root TEXT,
  git_branch TEXT,
  task_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  episode_id TEXT
)
```

```sql
working_events (
  id TEXT PRIMARY KEY,
  working_set_id TEXT NOT NULL REFERENCES working_sets(id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor TEXT,
  source TEXT,
  host_event_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL
)
```

Recommended indexes:

- `working_sets(status, last_active_at)`
- `working_sets(scope_key, status)`
- `working_sets(git_root, git_branch, status)`
- `working_sets(session_key, status)`
- `working_sets(status, resume_after)`
- `working_sets(lease_expires_at)`
- `working_events(working_set_id, sequence)`
- `working_events(working_set_id, created_at)`

#### P0.2 Snapshot shape

`working_sets.snapshot_json` should be a bounded object optimized for prompt context:

```ts
interface WorkingSnapshot {
  objective?: string;
  successCriteria?: string[];
  summary?: string;
  currentPlan?: string[];
  nextActions?: WorkingNextAction[];
  nextSteps?: string[];
  completedSteps?: string[];
  checkpoint?: WorkingCheckpoint;
  files?: WorkingFileNote[];
  commands?: WorkingCommandNote[];
  decisions?: WorkingDecisionNote[];
  assumptions?: WorkingAssumptionNote[];
  openQuestions?: string[];
  blockers?: string[];
  references?: WorkingReference[];
  memoryCandidates?: MemoryCandidate[];
  durableCandidates?: DurableCandidate[]; // compatibility alias for semantic candidates
  continuation?: WorkingContinuationState;
  budgets?: WorkingBudgetState;
  lastMaterialChange?: string;
}
```

Rules:

- No hidden chain-of-thought.
- Prefer concise externally useful state.
- Each file/command/decision should include enough provenance to be useful later.
- Snapshot must stay small enough for before-turn injection.
- For long-running goals, checkpoint and next-action fields are higher priority than exhaustive history.
- Detailed provenance belongs in `working_events`.

#### P0.3 Event types

Initial event types:

- `created`
- `snapshot_updated`
- `note_added`
- `file_inspected`
- `command_run`
- `decision_recorded`
- `assumption_recorded`
- `plan_updated`
- `next_step_added`
- `next_action_started`
- `next_action_completed`
- `checkpoint_recorded`
- `heartbeat_recorded`
- `budget_updated`
- `lease_acquired`
- `lease_released`
- `question_opened`
- `question_resolved`
- `blocker_added`
- `blocker_resolved`
- `subagent_finding`
- `status_changed`
- `memory_candidate_added`
- `episode_checkpoint_created`
- `semantic_candidate_added`
- `procedural_candidate_added`
- `durable_candidate_added`
- `closed`

Events are not semantic truth. They are an audit trail for WIP.

Every material snapshot update should increment `working_sets.revision`. Tool callers can provide an expected revision to avoid overwriting newer state, mirroring Codex `/goal`'s use of opaque goal IDs to avoid stale accounting/mutations.

#### P0.4 Scope model

Agenr needs richer Skeln context than the current adapter's `sessionId` and `sessionKey`.

Desired host context:

```ts
interface SkelnMemoryContextLike {
  sessionId?: string;
  sessionKey?: string;
  turnId?: string;
  userId?: string;
  agentId?: string;
  surface?: string;
  cwd?: string;
  gitRoot?: string;
  gitBranch?: string;
  gitRemote?: string;
  project?: string;
  projectId?: string;
  taskId?: string;
  threadId?: string;
  model?: string;
}
```

Scope resolution priority:

1. Explicit `workingSetId`.
2. Explicit `taskId` / project task key.
3. Explicit `scopeKey` supplied by host or tool args.
4. `gitRoot + gitBranch + project/user`.
5. `gitRoot + cwd + project/user`.
6. `sessionKey`.
7. `sessionId` fallback.

If multiple active working sets match with similar confidence, do not inject the full context. Return a compact ambiguity notice and let the model call `agenr_work list/get`.

#### P0.5 `agenr_work` tool

Expose one Skeln tool with action-based parameters.

Actions:

- `get`: return active working set for scope or by ID.
- `list`: list active/recent working sets matching optional scope/status filters.
- `update`: create or update a working set and append an event.
- `close`: close a working set, generate/attach episode summary data, and return durable candidates.

Conceptual tool contract:

```ts
type AgenrWorkAction = "get" | "list" | "update" | "close";

interface AgenrWorkParams {
  action: AgenrWorkAction;
  workingSetId?: string;
  scope?: Partial<WorkingScope>;
  status?: "active" | "paused" | "blocked" | "waiting" | "needs_review" | "budget_limited" | "closed" | "abandoned";
  title?: string;
  objective?: string;
  summary?: string;
  event?: {
    type: WorkingEventType;
    note?: string;
    payload?: Record<string, unknown>;
  };
  append?: {
    currentPlan?: string[];
    nextActions?: WorkingNextAction[];
    nextSteps?: string[];
    completedSteps?: string[];
    checkpoint?: WorkingCheckpoint;
    files?: WorkingFileNote[];
    commands?: WorkingCommandNote[];
    decisions?: WorkingDecisionNote[];
    assumptions?: WorkingAssumptionNote[];
    openQuestions?: string[];
    blockers?: string[];
    references?: WorkingReference[];
    memoryCandidates?: MemoryCandidate[];
    durableCandidates?: DurableCandidate[];
  };
  replace?: Partial<WorkingSnapshot>;
  budget?: WorkingBudgetState;
  continuationPolicy?: "manual" | "on_idle" | "scheduled";
  heartbeat?: boolean;
  lease?: {
    action: "acquire" | "release" | "renew";
    owner?: string;
    ttlSeconds?: number;
  };
  expectedRevision?: number;
  includeEvents?: boolean;
  eventLimit?: number;
  closeReason?: string;
  createEpisode?: boolean;
}
```

Default approval posture:

- `get` / `list`: `risk = read`, approval never.
- `update`: `risk = write`, default approval never or host-configurable because it writes transient WIP, not durable truth.
- `close`: `risk = write`, host-configurable. Closing can create an episode, but must not create semantic entries automatically.

Tool output should include:

- working set ID
- current revision
- scope key/kind
- status
- compact snapshot
- recent events if requested
- durable candidates if present
- continuation/budget/heartbeat/lease state when present
- whether an episode was created on close
- clear warning when scope was ambiguous or missing

#### P0.6 Provider context hooks

Implement non-empty Skeln provider hooks.

`buildSessionStartContext(context)`:

- Return a compact summary of high-confidence active/recent working sets for the current scope.
- Prefer “you have active WIP; call `agenr_work get` if needed” over dumping large context at session start.

`buildBeforeTurnContext(context)`:

- Resolve the best matching active working set.
- Return compact prompt context if confidence is high.
- Return no context or an ambiguity note if confidence is low.

Suggested injection format:

```xml
<agenr_work_context>
This is transient working memory for the current task, not durable truth.
Scope: agenr repo, branch skeln-working-memory
Working set: agenr working memory PRD
Status: active
Objective: Design first-class scoped working/task/session memory for Skeln.
Summary: ...
Current plan:
- ...
Last checkpoint: ...
Next actions:
- ...
Budgets/continuation: manual/on_idle/scheduled; remaining limits when known
Touched files:
- ...
Open questions:
- ...
Durable candidates pending review:
- ...
Rules:
- Update this working set when the material task state changes.
- Leave a checkpoint before pausing, handing off, compacting, or waiting.
- Do not store transient WIP with agenr_store.
- Promote only durable facts/decisions/lessons explicitly.
</agenr_work_context>
```

The XML-ish wrapper mirrors Codex `/goal`'s successful `<goal_context>` pattern. Any user-provided objective text must be escaped or otherwise treated as untrusted data.

#### P0.7 Close lifecycle

Closing a working set should:

1. Mark the working set `closed` or `abandoned`.
2. Append a `closed` event.
3. Produce a concise episode-style summary.
4. Link to an `episodes` row when episode creation is enabled.
5. Return durable candidates for explicit review/promotion.

Closing should not silently write semantic entries.

#### P0.8 Long-horizon state primitives

P0 should include the state primitives needed for future hours/days execution even if Skeln does not yet run an autonomous loop.

Minimum primitives:

- `checkpoint`: the last known resumable state, including known-good worktree/test state when relevant.
- `nextActions`: ordered, bounded queue of concrete next actions.
- `heartbeat_at`: last time a running agent confirmed it was alive and still working this set.
- `resume_after`: optional time before which Skeln should not continue automatically.
- `stale_after`: optional time after which Skeln should require review before continuing.
- `budget_json`: optional token/time/cost/turn/action budgets and stop conditions.
- `continuation_policy`: host-readable policy such as `manual`, `on_idle`, or `scheduled`.
- `lease_owner` / `lease_expires_at`: optional guard against multiple agents mutating the same long-running work set at once.

These primitives do not make agenr an executor. They let Skeln safely decide whether and how to continue.

#### P0.9 Memory consolidation candidates

Working memory should track candidate learnings separately from both raw WIP and already-promoted memory.

Candidate types:

- `episode`: material that should contribute to a task/session episode.
- `semantic`: stable facts, decisions, preferences, lessons, relationships, or milestones that may deserve `agenr_store`.
- `procedural`: reusable workflow or method candidate, likely deferred until repeated evidence exists.

Candidate fields should include:

- type
- subject/title
- content/summary
- evidence event IDs or source refs
- confidence
- promotion status: `candidate`, `accepted`, `rejected`, `promoted`
- promoted target ID when applicable

P0 may keep candidates inside `snapshot_json`; a separate candidate table can wait until promotion workflows need richer querying.

#### P0.10 Tests

P0 is not done without tests for:

- Creating/updating/getting/listing/closing working sets.
- Scope resolution priority and ambiguity behavior.
- Before-turn context injection for a high-confidence scope.
- No context injection for ambiguous scope.
- Stale `expectedRevision` handling prevents silent overwrites.
- Long-horizon fields round-trip through create/update/get and appear in context when relevant.
- Memory candidates round-trip without becoming durable entries until explicitly promoted.
- Lease/heartbeat fields do not cause semantic recall pollution.
- Closing creates/links an episode when enabled.
- Closing does not create durable entries.
- `agenr_work update` does not affect semantic recall results.
- Adapter remains compatible when Skeln only sends `sessionId`/`sessionKey`.

### P1 requirements

#### P1.1 Skeln-native lifecycle capture

After manual tool usage proves the model, Skeln should emit lifecycle events into agenr:

- turn started
- turn finished
- tool completed
- command completed
- file edited/read if available
- compaction starting/completed
- sub-agent completed

Agenr can translate these into working events or snapshot hints.

#### P1.2 Compaction integration

Before compaction, Skeln should ask agenr for the current working set summary and/or let agenr update the snapshot from the current turn summary.

After compaction, before-turn context should restore the WIP state without relying entirely on the compaction text.

#### P1.3 Better episode generation

Closed working sets should produce higher-quality episodes by combining:

- final snapshot
- salient event log
- Skeln turn metadata
- optional model-generated summary

#### P1.4 Sub-agent contribution path

Sub-agents should be able to append bounded findings to the parent working set without inheriting the entire parent context.

### P2 requirements

#### P2.1 Long-horizon continuation behavior

Consider Codex-style autonomous continuation only after the basic working set lifecycle is stable. The target is not just “continue one more turn”; it is allowing Skeln to work toward a goal over hours or days while remaining interruptible and auditable.

If implemented, constraints should mirror Codex's safety checks and add long-horizon guardrails:

- no active turn
- no queued user input
- no pending mailbox/input that should run first
- active working set still current
- continuation enabled by config/user
- continuation policy permits automatic work
- no unexpired lease owned by another agent/process
- heartbeat is fresh or the prior lease has expired
- current time is after `resume_after`
- current time is before `stale_after`, or user/model review has refreshed the checkpoint
- budgets and stop conditions permit another work unit

#### P2.2 Long-horizon watchdog and budgets

Skeln should use agenr's long-horizon fields to enforce:

- token budget
- wall-clock budget
- turn/action budget
- cost budget where available
- stale-after review requirement
- max auto-injected context size
- max continuous runtime before checkpointing
- stop-on-user-input and stop-on-approval-needed behavior

#### P2.3 UI affordances

Possible Skeln commands/UI later:

- `/work`
- `/work list`
- `/work close`
- `/work pause`
- `/work resume`
- status pill showing active working set

## Relationship to Codex `/goal`

Implementation facts verified in Codex:

- The real feature lives in core/app-server/TUI/state, not the sketch extension crate.
- Durable state is one SQLite-backed goal per materialized thread, with `thread_id`, opaque `goal_id`, objective, status, token budget, token/time accounting, and timestamps.
- Runtime state is separate from durable state: active goal ID, token/wall-clock baselines, budget-steering marker, continuation lock, and continuation turn marker.
- Context is injected as a hidden model-visible `role: user` message wrapped in `<goal_context>...</goal_context>`.
- User-provided objective text is XML-escaped before prompt insertion.
- App-server emits resume snapshots before core runtime considers idle continuation.
- Model tools can read/create/update goals, but `update_goal` is authority-limited to complete/blocked; pause/resume/limits are user/system-controlled.
- Ctrl+C during an active goal turn pauses the goal before interrupting.

What to borrow:

- Runtime-owned persisted state with a separate volatile runtime layer.
- Constrained model tools and clear status ownership.
- Context injection as a special hidden/runtime context block.
- Explicit statuses.
- Optimistic revisions/IDs to prevent stale updates.
- Escaping user-provided objective or note text.
- Resume snapshot ordering before any continuation behavior.
- Direct user controls that mutate state, not ordinary prompts.
- Idle continuation pattern as a future option.

What not to copy directly:

- Single-thread-only scope.
- Single-objective-only model.
- Treating the feature primarily as autonomous goal execution.
- Collapsing task ledger, episode, and durable memory into one object.

Agenr working memory should be broader: a scoped task ledger that can support goals, design work, implementation work, sub-agent findings, closeout, and long-horizon execution across hours or days.

## Data boundary with existing agenr layers

| Layer | Existing/future storage | Purpose | Working-memory relationship |
|---|---|---|---|
| Durable semantic memory | `entries` | Stable facts, decisions, preferences, lessons, relationships, milestones | Working memory can propose candidates; does not auto-write |
| Episodic memory | `episodes` | Narrative of what happened over a bounded session/task | Closed working sets can become episodes |
| Procedural memory | `procedures` + docs/skills | How to do recurring workflows | Working memory may reference procedures, not replace them |
| Working memory | `working_sets` + `working_events` | Current scoped WIP/task state | New layer in this PRD |

## Memory consolidation lifecycle

Working memory should continuously collect short-term operational state, but consolidation should happen at explicit boundaries.

### During work

- Append working events for material actions, observations, decisions, blockers, and checkpoints.
- Keep the snapshot compact: objective, plan, checkpoint, next actions, active blockers, and candidate learnings.
- Record candidate memories with evidence, not as trusted durable entries.

### At checkpoint

- Summarize progress since the last checkpoint.
- Refresh next actions and blockers.
- Mark candidate episode material.
- Leave enough state for another model/process to resume.

### At close

- Convert final snapshot plus salient events into an `episodes` row when enabled.
- Return semantic candidates for explicit `agenr_store` review.
- Return procedural candidates separately when the work revealed a reusable method.
- Mark candidate promotion status so the same lesson is not repeatedly suggested.

### Later consolidation

Future surgeon-style jobs can revisit closed working sets and episodes to extract better semantic/procedural candidates, but they must preserve provenance and not promote unverified hypotheses as truth.

## Lifelong learning requirements

To support an agent that learns throughout its life, memory needs more than storage. It needs lifecycle mechanics:

- **Provenance:** every important memory should know where it came from.
- **Confidence:** candidates and memories should distinguish observed fact, inference, hypothesis, preference, and decision.
- **Correction:** wrong memories must be superseded, retired, or bounded by validity dates.
- **Forgetting/compression:** not all WIP deserves retention; old low-value working events can collapse into episodes or be discarded.
- **Identity boundaries:** the agent can remember commitments and habits, but user authority and privacy remain higher priority than self-continuity.
- **Cross-scope recall:** lifelong memory must still respect project, user, surface, and task scopes.
- **Learning feedback loop:** future failures/successes should update lessons and procedures, not just pile up transcripts.

## Prompt and safety requirements

- The working context must state that it is transient WIP, not durable truth.
- Objectives and notes originating from user/model text must be escaped or clearly delimited.
- The model must be instructed not to store hidden reasoning.
- The model should update working memory only for material state changes, not every minor thought.
- Durable promotion candidates must pass the future-session test before `agenr_store`.
- Episodic summaries should say what happened, not rewrite uncertain work as facts.
- Semantic candidates should distinguish verified observations from hypotheses.
- Procedural candidates should generally require repeated evidence or explicit human approval.
- The event log may include wrong hypotheses; recall surfaces must not present them as verified facts.

## Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Scope collision | Injecting the wrong task context can derail the model. | Conservative scope confidence, ambiguity notices, explicit `workingSetId`, and strong indexes around repo/branch/session/task. |
| Durable-memory pollution | WIP notes could become false trusted claims. | Separate tables, no semantic recall participation, explicit durable candidates, no auto-`entries` writes. |
| Bad consolidation | A wrong hypothesis or failed attempt could be promoted into long-term memory. | Evidence-linked candidates, explicit promotion status, future-session test, and review/approval before semantic/procedural promotion. |
| Prompt bloat | Working context could consume too much turn budget. | Snapshot-first injection, event limits, max context size, and recency/salience trimming. |
| Model over-updates | The model might write every tiny thought. | Tool description says material state only; native event capture later can summarize rather than log everything. |
| Hidden reasoning leakage | Working memory could become a chain-of-thought sink. | Explicit policy: store externally useful task state only, never hidden reasoning. |
| Premature automation | Codex-style continuation could make the system too agentic too soon. | Keep continuation out of P0/P1; require explicit config/user enablement later. |
| Runaway long-horizon work | An hours/days agent could burn budget or keep acting after context becomes stale. | Skeln-owned watchdogs, budgets, leases, heartbeat expiry, stale-after review, and stop-on-user-input/approval-needed rules. |
| Identity drift | A lifelong agent could overfit to stale memories or treat old self-notes as current truth. | Validity windows, supersession, scoped recall, explicit user authority, and periodic consolidation/review. |

## Rollout plan

### Phase 0: PRD/design agreement

- Agree on data model, tool actions, lifecycle, and Skeln context contract.
- No implementation changes beyond docs/design.

### Phase 1: Agenr manual working memory MVP

- Add schema migration for `working_sets` and `working_events` (next logical schema version after current v10).
- Add core types, repository, and service.
- Add `agenr_work` tool with `get/list/update/close`.
- Add provider hook injection using currently available `sessionId`/`sessionKey`, while accepting richer optional fields.
- Add tests.

### Phase 2: Skeln richer context

- Extend Skeln memory provider context with cwd, git root, branch, project/task/thread IDs, turn ID, user/agent/surface.
- Improve scope confidence and before-turn injection.

### Phase 3: Native event capture and consolidation

- Wire Skeln lifecycle events into agenr working events.
- Add compaction integration.
- Add sub-agent contribution flow.
- Generate checkpoint summaries and episode material from salient working events.
- Track semantic/procedural candidates with evidence and promotion status.

### Phase 4: Long-horizon goal mode

- Optional continuation loop driven by Skeln, with agenr as the working-state source of truth.
- Heartbeats, leases, watchdogs, resume-after/stale-after policies, and budget enforcement.
- Required checkpoint before every pause, interruption, compaction, model handoff, or scheduled delay.
- UI commands/status for `/work`, pause/resume, active lease, budget remaining, and last checkpoint.

## Open questions

1. Should `close` create an episode by default in Phase 1, or should episode creation be a separate explicit action until the summary quality is proven?
2. Should `update` default to no approval despite being a persistent write, because it is non-durable WIP?
3. How aggressive should before-turn injection be at session start? Full snapshot or “active WIP available” stub?
4. What is the minimum Skeln context contract we can land without destabilizing other memory providers?
5. Should scope keys be fully deterministic strings owned by agenr, or should Skeln optionally provide host-native stable task IDs?
6. What exact stale-update behavior should `expectedRevision` use: reject, merge best-effort, or append an event with a conflict warning?
7. How long should closed working events be retained after episode creation?
8. What are the minimum user-visible controls for hours/days work: pause, resume, budget, stop-after, require-review-after, approval mode?
9. Should long-horizon continuation require an explicit user-created goal, or can the model create a continuable working set from conversational intent?
10. Should semantic/procedural promotion candidates be reviewed inline by the model/user at close, or queued for a later consolidation job?
11. What evidence threshold is enough for a procedural candidate: one successful run, repeated runs, or explicit user approval?

## Success criteria

The PRD is successful when a new Skeln session in the same repo/branch can resume current work from agenr without durable memory pollution — and when the same model scales conceptually from a single resumed turn to an hours/days goal and ultimately a lifelong agent memory loop with checkpoints, budgets, safe continuation controls, and a clear consolidation path into episodic, semantic, and procedural memory.

The MVP is successful when:

- A model can create/update/read/close scoped WIP through `agenr_work`.
- Before-turn context reliably injects the right active working set.
- Ambiguous scopes are handled conservatively.
- Closing produces an episode/candidate handoff without silently creating semantic entries.
- Existing durable memory behavior remains unchanged.
- Tests demonstrate that working memory and durable memory stay separate.
