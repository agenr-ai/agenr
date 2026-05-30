# Comprehensive plan: Skeln session memory, working memory, and `/goal`

Date: 2026-05-30
Status: Implementation-ready synthesis
Audience: Agenr core/app, Skeln host adapter, and OpenClaw parity work where noted

Sources combined:

- [Original plan](./2026-05-29-skeln-session-memory-working-memory-and-goal-plan.md)
- [Prior-art review](./reviews/2026-05-29-skeln-working-memory-prior-art-review.md)

Scope assumption: Agenr and Skeln may both change. There is no backward-compatibility constraint for the new working-memory contract.

## Executive summary

Skeln sessions are append-only trees with compaction, fork, branch, and resume semantics. Agenr already owns durable entries, episodes, procedures, and before-turn recall. The missing layer is a scoped working-memory ledger that can preserve active task state without turning temporary WIP into durable truth or replay pollution.

The combined design keeps the original layered architecture and applies the prior-art corrections as blocking contracts:

1. Working memory belongs in Agenr, not in persisted Skeln transcript messages.
2. `<agenr_work_context>` must be model-visible through a non-persistent context path by default.
3. A resolved scope has at most one non-closed working set unless an explicit task id is supplied.
4. Working-set mutations are typed, granular operations with `expectedRevision` and `updateReason`.
5. Close is consolidation, not automatic durable truth. It creates a final snapshot and optional episode/candidate payloads, never silent semantic entries.
6. Lifecycle capture and checkpoint reliability come before autonomous continuation.
7. Skeln owns execution, approvals, interrupts, budgets, and continuation gates. Agenr owns the durable working ledger and consolidation state.

## Prior-art conclusions

The reviewed systems support the same split:

| Prior-art pattern | Planning implication |
|---|---|
| LangGraph separates thread-scoped short-term memory from cross-thread long-term memory. | Keep working sets separate from durable entries, episodes, and procedures. |
| MemGPT and Letta use hierarchical context instead of full-history replay. | Inject compact, editable working state instead of replaying or re-summarizing every turn. |
| Cloudflare Agents and OpenAI Agents SDK separate session history from durable or prompt-injected state. | Do not store rendered volatile working context as normal Skeln messages. |
| Graphiti and Zep rely on temporal episodes and provenance. | Episode and durable candidates emitted from working sets must cite event sequence ranges. |
| CoALA, Reflexion, Generative Agents, and Voyager show value from reflection with review. | Semantic and procedural promotion stays explicit or reviewable. |
| LongMemEval, Mem0, and Mastra favor compact, structured evidence over replay. | Evaluate preservation, temporal correctness, abstention, and stale-WIP avoidance, not just text similarity. |
| Mastra's working-memory postmortem warns against whole-object replacement. | Use typed operations and merge semantics. Full replacement is explicit and rare. |
| Codex `/goal` is a strong runtime prior. | Borrow UX and continuation gates, but keep Agenr's ledger richer than Codex's goal object. |

## North-star memory stack

Agenr is the memory substrate that lets Skeln agents preserve task continuity and learn over time.

| Layer | Question answered | Primary store | Trusted as durable fact? |
|---|---|---|---|
| Live replay | What is in the current active branch? | Skeln session tree | No, host-owned transcript only |
| Working continuity | What are we doing now and what is next? | `working_sets` + `working_events` | No |
| Session checkpoints | What did compaction, branch movement, or fork preserve? | `session_artifacts` + lineage | No, provenance source |
| Autobiographical continuity | What happened in prior sessions or tasks? | `episodes` | Historical narrative, not fact table |
| Semantic learning | What should future sessions treat as true? | `entries` | Yes, with claim keys and lifecycle |
| Procedural growth | What reusable methods did we learn? | `procedures` | Yes, after review or sync |

Working memory is the front edge of a consolidation pipeline:

```text
working events + snapshot
  -> checkpoints and rolling summaries
  -> task or session episodes
  -> semantic candidates
  -> optional procedural candidates
  -> explicit durable promotion
```

Each transition changes meaning. Temporary notes, hypotheses, stale observations, and active plans are not semantic memory.

## Core principles

1. Host adapters translate. Agenr app/core decide memory semantics.
2. Working memory is not durable truth.
3. Snapshot plus event log is the canonical working-memory shape.
4. Typed artifacts beat summary blobs.
5. Lineage is a graph edge, not a comment in a session summary.
6. Live replay, injected context, archived branch text, and recall-only sources are distinct.
7. Memory work is event-triggered: compact, fork, branch movement, shutdown, checkpoint, and close each have specific behavior.
8. Scope confidence gates injection. Wrong WIP is worse than missing WIP.
9. Skeln executes. Agenr remembers.
10. Manual mode ships first. Native lifecycle capture and continuation follow after the ledger is reliable.
11. Promotion is explicit. Close returns candidates; it does not silently write durable entries.
12. Do not duplicate host checkpoints. Reference Skeln compaction and branch summaries when they already exist.
13. Long-horizon work requires checkpoints, leases, budgets, and stop gates, not larger prompts.

## Authority and composition

When sources conflict, rank them in this order:

1. Live Skeln replay on the active branch
2. Latest host compaction checkpoint on the active branch
3. Active Agenr working-set snapshot
4. Handoff artifacts such as continuity summaries or recent-session tails
5. Durable entries
6. Episodes
7. Exploration residue such as branch-abandonment artifacts
8. Archived branch text, queryable but not auto-injected

Composition rules:

- Working set: what we are doing now.
- Compaction checkpoint: what the host compressed away from replay.
- Branch abandonment: what we explored and left.
- Episode: what happened.
- Durable entry: what future sessions should treat as true.
- Procedure: how to do reusable work.

Post-compaction injection combines sources without duplication:

- Plan, objective, next actions, and blockers come from the working set.
- Historical narrative and facts dropped from replay come from the compaction checkpoint.
- Render checkpoint prose under "Context no longer in replay" and the working set under "Current task state."

## Critical contract changes

These changes supersede conflicting wording in the original plan.

### 1. Non-persistent working-context injection

Phase 1 must not inject `<agenr_work_context>` as a normal persisted Skeln `message`.

Agenr returns a projection:

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

Skeln must deliver the projection through one of these non-persistent paths:

- a `context` event/provider-context transform
- `BeforeAgentStartResult.transientMessages`
- `BeforeAgentStartResult.contextMessages` with `persist: false`

Skeln may persist a compact audit pointer:

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

The audit pointer is not replayed as a user message. If any host persists rendered working context, it must mark it as an injected memory projection and exclude it from compaction source text and episode mining unless explicitly requested.

Durable session-start recall may continue using the existing persisted injection behavior if that remains intentional. Volatile working context may not.

### 2. Active working-set cardinality

Agenr enforces:

- one non-closed working set per resolved scope unless `taskId` is supplied
- `expectedRevision` required for all updates and close operations targeting an existing set
- `UNIQUE(working_set_id, sequence)` for events
- snapshot revision increment and event append in one write transaction
- explicit replace semantics that close, abandon, or supersede the previous active set

SQLite should enforce this with partial unique indexes when the status set is stable. Otherwise the app service must enforce it inside the same transaction that writes the snapshot and event.

### 3. Typed, granular updates

`agenr_work update` is not arbitrary snapshot replacement. It accepts typed operations:

```ts
type AgenrWorkUpdateOperation =
  | { type: "set_objective"; objective: string; title?: string }
  | { type: "replace_plan"; currentPlan: string[]; nextActions?: WorkingNextAction[] }
  | { type: "merge_checkpoint"; checkpoint: WorkingCheckpoint }
  | { type: "add_file_note"; file: WorkingFileNote }
  | { type: "add_command_note"; command: WorkingCommandNote }
  | { type: "record_decision"; decision: WorkingDecisionNote }
  | { type: "record_assumption"; assumption: WorkingAssumptionNote }
  | { type: "set_next_actions"; nextActions: WorkingNextAction[] }
  | { type: "set_status"; status: WorkingSetStatus }
  | { type: "add_candidate"; candidate: WorkingCandidate };
```

Every operation carries:

```ts
interface AgenrWorkMutationEnvelope {
  operation: AgenrWorkUpdateOperation;
  expectedRevision: number;
  updateReason: string;
  actor?: "model" | "user" | "runtime" | "system";
  source?: "tool" | "goal_command" | "lifecycle_hook" | "consolidation_job";
}
```

Full snapshot replacement is an explicit admin operation, not the normal tool path.

### 4. Close is consolidation

Close means "finish or stop managing this working set." It does not mean "write every note as durable truth."

Close behavior:

- Always writes a final checkpoint/snapshot.
- Creates an episode only when the close is explicit and activity is substantial enough, or when the caller requests it and thresholds pass.
- For `/goal clear`, tiny goals, or abandonment, queues or returns an episode candidate instead of forcing a rich episode.
- Emits semantic and procedural candidates with evidence. It never silently writes `entries` or `procedures`.
- Is deterministic and no-LLM in Phase 1 unless a bounded summary dependency is explicitly added.

Episode source references use the working set and revision:

```text
working_set:<workingSetId>#rev:<revision>
```

Episode and durable candidates cite working-event sequence ranges.

### 5. Prompt-injection and staleness rules

Every model-visible field is escaped or strongly delimited:

- objective
- summary
- plan
- notes
- files
- commands
- decisions
- assumptions
- open questions
- candidate text
- external links

The rendered block states:

- it is transient WIP, not durable truth
- it may contain stale or hypothetical information
- filesystem, git, tests, tool output, and the user's newest message are authoritative for current-state claims
- the model should update the working set only on material state changes
- the model should not store transient WIP with `agenr_store`

### 6. Lifecycle hook alignment

Use Skeln's real event model:

| Skeln event | Agenr behavior |
|---|---|
| `session_start` | resolve scope, transition reason, predecessor facts |
| `session_before_fork` | request or require checkpoint before fork |
| `session_before_compact` | request or require checkpoint before compact |
| `session_compact` | upsert compaction artifact and refresh working checkpoint |
| `session_before_tree` | derive branch-abandonment input from `entriesToSummarize` |
| `session_tree` | persist committed branch movement after Skeln wires it to extensions |
| `session_shutdown` | checkpoint only, never implicit close |
| `context` | deliver non-persistent working-context projection |

Do not create duplicate summaries when Skeln already wrote compaction or branch summaries. Store source refs and metadata.

### 7. Cross-repo tests are early deliverables

Agenr Phase 1 tests:

- working-set create, update, close, and revision conflicts
- one-active-working-set invariant
- typed operations append ordered events
- close emits final snapshot plus episode/candidate payload with evidence sequences
- before-turn renderer refuses ambiguous scopes
- working memory and durable memory stay separate

Skeln Phase 1 tests:

- transient Agenr work context reaches provider context
- transient context is not appended as a session `message`
- persisted audit pointer does not re-enter live replay as a user message
- compaction input excludes transient working-context projections
- `/goal` commands use Agenr-first mutation order
- `/goal` volatile state does not advance when Agenr mutation fails

Phase 2 and 3 cross-repo tests:

- lifecycle hook payloads are consumed with exact field names
- `session_tree` after-event reaches extension handlers once implemented
- compaction and branch summaries are referenced, not duplicated
- fork and resume inject predecessor context without treating archived text as live replay

## Ownership boundary

| Concern | Skeln | Agenr |
|---|---|---|
| `/goal` command UI, menus, status pill | yes | no |
| Turn scheduling, approvals, Ctrl+C, mailbox checks | yes | no |
| Idle continuation loop and continuation lock | yes | no |
| Token and wall-clock enforcement | yes | stores counters |
| Objective, snapshot, checkpoint, plan, blockers | reads and writes through adapter | yes |
| Hidden model-visible working context | renders through transient path | selects and builds |
| Goal and working-state tools | exposes provider tool | implements `agenr_work` |
| Scope facts from runtime | supplies raw facts | resolves canonical scope |
| Episodes and durable candidates on close | triggers close | generates handoff payload |
| Compaction, fork, resume, branch event emission | yes | consumes and records memory artifacts |

Rule: Skeln executes; Agenr remembers. Skeln does not persist a second objective, plan, or checkpoint ledger when a working set exists.

## `/goal` mapping

Skeln adopts Codex's user experience and continuation discipline while using Agenr as the source of truth.

| Codex concept | Agenr/Skeln mapping |
|---|---|
| Thread goal objective | `working_sets.objective` |
| Goal status | `working_sets.status` |
| `goal_id` stale guard | `working_sets.id` + monotonic `revision` |
| Token and time budgets | `working_sets.budget_json`, enforced by Skeln |
| Continuation policy | `working_sets.continuation_policy` |
| `<goal_context>` | transient `<agenr_work_context>` |
| `get_goal`, `create_goal`, `update_goal` | optional aliases over `agenr_work` only |
| Host SQLite goal state | no semantic ledger in Skeln, read-through UI cache only |

Phase 1 command surface:

| Command | Agenr action | Skeln volatile action after success |
|---|---|---|
| `/goal` | `agenr_work get` | refresh UI cache |
| `/goal set <objective>` | create or replace active working set at resolved scope | store `workingSetId` and `revision` |
| `/goal clear` | close or abandon per explicit user intent | clear volatile runtime |

Phase 5b adds:

- `/goal edit`
- `/goal pause`
- `/goal resume`
- token and wall-clock budgets
- stop-after controls
- require-review-after controls

Model tools may mark the working set blocked or request close through strict audit rules. User and runtime control pause, resume, budget limit, usage limit, waiting, cancellation, and continuation enablement.

## End-to-end flows

### User sets a goal

1. Skeln validates that no conflicting active goal exists at the resolved scope, or asks to replace.
2. Skeln supplies raw scope facts: `sessionKey`, `cwd`, git facts when available, project, `runtimeThreadKey` or `conversationKey` when available.
3. Skeln calls Agenr to create or update the working set with `status=active` and `continuation_policy=manual`.
4. Agenr writes `created` or `snapshot_updated`, returns `workingSetId` and `revision`.
5. Skeln updates volatile runtime only after Agenr succeeds.

### Before each goal turn

1. Skeln emits scope facts and optional `workingSetId`.
2. Agenr resolves the best active working set.
3. Agenr returns a transient projection. Full context requires high confidence; ambiguous scope returns a stub.
4. Skeln delivers the projection through provider context, not persisted transcript replay.
5. If continuation is enabled later, Skeln may prepend continuation steering using the fresh Agenr snapshot.

### Model updates task state

1. Material changes use `agenr_work update`.
2. The tool requires `expectedRevision`, `updateReason`, and a typed operation.
3. Agenr applies the merge in a transaction, increments `revision`, and appends an ordered event.
4. The tool response includes the new revision and compact snapshot.

### Pause, compact, fork, handoff, or shutdown

1. Skeln requests a checkpoint before the transition.
2. Phase 1 to 4 treat this as guidance unless a host hook can enforce it.
3. Phase 5a and later require a checkpoint before pause, compaction, fork, handoff, scheduled delay, and shutdown when a goal is active.
4. Shutdown checkpoints the active working set and never implicitly closes it.

### Close

1. Caller supplies `expectedRevision` and `closeReason`.
2. Agenr writes a final checkpoint and `closed` event.
3. Agenr creates an episode only if thresholds pass or the close path explicitly requests one.
4. Agenr returns semantic and procedural candidates with evidence ranges.
5. Durable promotion happens only through explicit store/review surfaces.

## Scope model

Hosts supply raw facts. Agenr computes the canonical `scope_key`.

```ts
interface WorkingScope {
  scopeKey?: string;
  sessionKey?: string;
  gitRoot?: string;
  gitBranch?: string;
  cwd?: string;
  project?: string;
  taskId?: string;
  conversationKey?: string;
  runtimeThreadKey?: string;
  hostThreadId?: string;
}

interface ResolvedSessionScope {
  scopeKey: string;
  scopeKind:
    | "task"
    | "conversation"
    | "git_branch"
    | "git_cwd"
    | "session"
    | "session_id";
  sessionKey?: string;
  gitRoot?: string;
  gitBranch?: string;
  cwd?: string;
  project?: string;
  taskId?: string;
  conversationKey?: string;
  runtimeThreadKey?: string;
  hostThreadId?: string;
}
```

Resolution priority:

1. Explicit `workingSetId`
2. Explicit `taskId`
3. Explicit `conversationKey` or `runtimeThreadKey`
4. Explicit `scopeKey`
5. `gitRoot + gitBranch + project/user`
6. `gitRoot + cwd + project/user`
7. `sessionKey`
8. `sessionId` fallback

`threadId` is not a required Skeln primitive. Use host-neutral `conversationKey` or `runtimeThreadKey` in plan and code. Only use `threadId` at Codex compatibility edges or when a host actually supplies that name.

Missing git facts do not disable working memory. They lower scope confidence and may force stub injection instead of full context.

## Data model

### Working memory: schema v11

Phase 1 creates only `working_sets` and `working_events`.

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
  conversation_key TEXT,
  runtime_thread_key TEXT,
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
);

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
  created_at TEXT NOT NULL,
  UNIQUE(working_set_id, sequence)
);
```

Indexes:

- `(status, last_active_at)`
- `(scope_key, status)`
- `(git_root, git_branch, status)`
- `(session_key, status)`
- `(conversation_key, status)`
- `(runtime_thread_key, status)`
- `(status, resume_after)`
- `(lease_expires_at)`
- `(working_set_id, created_at)`

Partial uniqueness:

```sql
CREATE UNIQUE INDEX working_sets_one_open_per_scope
ON working_sets(scope_key)
WHERE status NOT IN ('closed', 'abandoned');
```

If SQLite/libsql support is insufficient for this index across all target deployments, enforce the same rule in the repository transaction.

### Session tree: schema v12

Phase 2 creates session lineage and artifact tables. Phase 1 must not create them.

```sql
session_lineage_edges (
  id TEXT PRIMARY KEY,
  child_session_key TEXT NOT NULL,
  parent_session_key TEXT,
  parent_source_ref TEXT,
  reason TEXT NOT NULL,
  fork_entry_id TEXT,
  fork_position TEXT,
  observed_at TEXT NOT NULL
);

session_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_ref TEXT,
  content_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(kind, session_key, source, source_id, content_hash)
);
```

Artifact kinds:

```ts
type SessionArtifactKind =
  | "continuity_summary"
  | "recent_session"
  | "compaction_checkpoint"
  | "branch_abandonment"
  | "session_episode";
```

Working state is not a `SessionArtifactKind`.

`session_episode` artifacts are pointer-only:

```ts
interface SessionEpisodeArtifactMetadata {
  episodeId: string;
  sourceRef: string;
  contentHash: string;
  summaryOneLiner: string;
}
```

Full narrative stays in `episodes`.

## Working snapshot

```ts
interface WorkingSnapshot {
  objective?: string;
  successCriteria?: string[];
  summary?: string;
  currentPlan?: string[];
  nextActions?: WorkingNextAction[];
  completedSteps?: string[];
  checkpoint?: WorkingCheckpoint;
  files?: WorkingFileNote[];
  commands?: WorkingCommandNote[];
  decisions?: WorkingDecisionNote[];
  assumptions?: WorkingAssumptionNote[];
  openQuestions?: string[];
  blockers?: string[];
  references?: WorkingReference[];
  candidates?: WorkingCandidate[];
  continuation?: WorkingContinuationState;
  budgets?: WorkingBudgetState;
  lastMaterialChange?: string;
}

interface WorkingNextAction {
  text: string;
  status?: "pending" | "in_progress" | "blocked" | "done";
  ref?: string;
}

interface WorkingCheckpoint {
  summary: string;
  recordedAt: string;
  nextActions?: string[];
  blockers?: string[];
}

interface WorkingFileNote {
  path: string;
  note?: string;
  observedAt?: string;
}

interface WorkingCommandNote {
  command: string;
  outcome?: string;
  observedAt?: string;
}

interface WorkingDecisionNote {
  decision: string;
  rationale?: string;
  decidedAt?: string;
}

interface WorkingAssumptionNote {
  assumption: string;
  confidence?: "low" | "medium" | "high";
  validated?: boolean;
}

interface WorkingReference {
  label: string;
  uri?: string;
  kind?: "doc" | "issue" | "pr" | "url" | "entry" | "episode";
}

interface CandidateProvenance {
  evidenceEventSequences: number[];
  sourceRef?: string;
  note?: string;
}

type WorkingCandidate =
  | {
      kind: "episodic";
      summary: string;
      provenance: CandidateProvenance;
      promotionStatus: "pending" | "promoted" | "dismissed";
    }
  | {
      kind: "semantic" | "procedural";
      subject: string;
      content: string;
      suggestedClaimKey?: string;
      provenance: CandidateProvenance;
      promotionStatus: "pending" | "promoted" | "dismissed";
    };
```

## Tool contract

`agenr_work` actions:

- `get`
- `list`
- `update`
- `close`

```ts
interface AgenrWorkParams {
  action: "get" | "list" | "update" | "close";
  workingSetId?: string;
  scope?: Partial<WorkingScope>;
  operation?: AgenrWorkUpdateOperation;
  expectedRevision?: number;
  updateReason?: string;
  includeEvents?: boolean;
  eventLimit?: number;
  closeReason?: string;
  createEpisode?: boolean;
}
```

Approval posture:

- `get` and `list`: read-only
- `update`: WIP write, default no approval, host-configurable
- `close`: write and possible episode/candidate emission, host-configurable

Status authority:

| Actor | May set |
|---|---|
| Model | `blocked`, and close request under tool rules |
| User | `active`, `paused`, `closed`, `abandoned` |
| Skeln runtime | `budget_limited`, `usage_limited`, `waiting`, `needs_review` |
| Consolidation job | candidate promotion status only |

## Injection rendering

Example full block:

```xml
<agenr_work_context>
This is transient working memory for the current task, not durable truth.
It may be stale or hypothetical. Prefer current filesystem, git, tests, tool output, and the user's latest message for current-state claims.

Scope: ...
Working set: ...
Revision: ...
Status: active
Objective: ...
Summary: ...

Current plan:
- ...

Last checkpoint:
...

Next actions:
- ...

Touched files:
- ...

Open questions:
- ...

Pending memory candidates:
- ...

Rules:
- Update this working set when material task state changes.
- Leave a checkpoint before pausing, handing off, compacting, forking, or waiting.
- Do not store transient WIP with agenr_store.
- Promote only durable facts, decisions, preferences, or reusable procedures explicitly.
</agenr_work_context>
```

Budget coordination:

1. Durable recall stays first and unchanged.
2. Working context is snapshot-first; event tails are trimmed by salience.
3. Phase 3 adds compaction refresh context.
4. A single coordinator enforces the total context budget and prevents double injection.

## App services

New modules:

```text
src/app/working-memory/
  types.ts
  repository.ts
  service.ts
  scope-resolver.ts
  injection.ts
  close-service.ts

src/app/session-memory/
  types.ts
  lineage-service.ts
  artifact-service.ts
  trigger-router.ts
  post-compaction.ts
  branch-abandonment.ts
  fork-start.ts
  finalize-session.ts
```

Phase 1 extends existing `runSessionStart(...)` and `runBeforeTurn(...)` instead of introducing a parallel hook API. Session-tree `trigger-router` remains no-op until Phase 2.

Feature flags:

| Flag | Gates |
|---|---|
| `workingMemory` | v11 tables, `agenr_work`, transient WIP injection |
| `sessionTreeLineage` | v12 lineage, fork/resume handoff |
| `sessionTreeCompaction` | compaction refresh and branch-abandonment capture |
| `goalContinuation` | idle continuation and long-horizon `/goal` controls |

All default off until their owning phase ships.

## Recall and routing

Working sets never participate in semantic recall as trusted claims.

| User intent | Modes | Sources |
|---|---|---|
| exact fact or decision | `entries` | durable entries |
| prior approach or what happened | `auto` | entries, episodes, lineage artifacts |
| session narrative | `episodes` | episodes plus `session_episode` pointers |
| abandoned exploration | `auto` | `branch_abandonment` plus episodes |
| post-compaction recovery | internal | compaction checkpoint plus working set |
| active WIP | internal | working-set snapshot through transient context or `agenr_work` |

## Consolidation lifecycle

During work:

- Append typed events for material observations, decisions, blockers, checkpoints, and candidates.
- Keep the snapshot compact and current.
- Record candidates with provenance, not as trusted entries.

At checkpoint:

- Summarize progress since the prior checkpoint.
- Refresh next actions and blockers.
- Mark candidate episode material.
- Leave enough state for another process or model to resume.

At close:

- Write final snapshot and closed event.
- Emit an episode only when explicit and substantial enough.
- Return semantic and procedural candidates for review.
- Mark candidates to prevent repeated suggestions.

Later:

- Surgeon or consolidation jobs revisit closed working sets.
- Default closed-event retention is 90 days after close when an episode exists, then snapshot-only unless host config says otherwise.

## Rollout plan

### Phase 0: Contract re-freeze

Deliverables:

- Freeze this combined plan as the implementation contract.
- Define transient injection shape and choose the Skeln non-persistent path.
- Replace `threadId` requirements with host-neutral `conversationKey` or `runtimeThreadKey`.
- Freeze schema v11 and v12 boundaries.
- Freeze cardinality and revision invariants.
- Freeze typed update operations.
- Confirm Phase 1 has no session-tree table dependency.
- Add typed stubs behind feature flags, no migration yet.

Exit criteria:

- Types compile.
- No `knowledge.db` migration has landed.
- Cross-repo Skeln contract for transient context is documented.

### Phase 1: Smaller working-memory MVP

Agenr:

- Add schema v11 only.
- Implement repository, service, scope resolver, transient renderer, and close service.
- Implement `agenr_work get/list/update/close` with typed operations.
- Enforce one-active-set and revision invariants.
- Add deterministic close to final snapshot plus optional episode/candidate payload.
- Add a host-neutral episode source for Skeln-originated episodes if an episode is emitted.
- Extend before-turn/session-start services with working projections.
- Keep durable recall behavior unchanged.

Skeln:

- Add or expose a non-persistent context path for Agenr working projections.
- Supply `sessionKey`, `cwd`, git facts when available, project, and optional `conversationKey` or `runtimeThreadKey`.
- Implement `/goal`, `/goal set`, `/goal clear` with Agenr-first mutation.
- Keep continuation manual only.
- Persist only optional audit pointers, never rendered WIP blocks by default.

Out of scope:

- v12 session-tree tables
- branch-abandonment recall
- compaction refresh
- autonomous continuation
- automatic lifecycle mining
- semantic or procedural auto-promotion

Delivers:

- restart resume by scope
- no durable pollution
- close handoff
- conservative ambiguity behavior

### Phase 2: Session-tree and lifecycle foundation

Preconditions:

- Confirm exact Skeln payloads for `session_start.reason`, predecessor refs, fork/clone signals, and lifecycle hooks.
- Wire `session_tree` after-event to extension handlers or remove it as a dependency.

Agenr:

- Add schema v12.
- Consume session-start transition reason and predecessor refs.
- Persist lineage edges for fork, clone, resume, and subagent spawn.
- Port predecessor continuity into host-neutral app services.
- Add lifecycle event intake for checkpoint-relevant events, with feature flag off by default until Skeln tests pass.

Skeln:

- Emit lifecycle events through extension runner where needed.
- Keep event field names aligned with Skeln source payloads, for example `fromExtension` for compaction origin.

Delivers:

- fork and resume handoff
- host-neutral lineage model
- checkpoint-relevant hook coverage before continuation exists

### Phase 3: Compaction and branch abandonment

Preconditions:

- `session_compact` payload includes compaction entry, summary, and `firstKeptEntryId`.
- `session_tree` after-event reaches extensions with committed movement facts.

Deliverables:

- `session_compact` upserts `compaction_checkpoint`.
- Before-turn visibility excludes archived pre-compaction messages when possible.
- Working set checkpoint refreshes after compaction.
- `session_before_tree` and `session_tree` create branch-abandonment artifacts from host-supplied summaries.
- Agenr generation of branch summaries remains behind a separate default-off policy flag.

Delivers:

- compaction recovery
- abandoned branch recall without durable pollution

### Phase 4: Close, shutdown, and episode consolidation v1

Deliverables:

- Unified episode writer for Skeln JSONL exports and OpenClaw transcripts.
- `session_shutdown` writes required checkpoint when a working set is active and never closes implicitly.
- Optional bounded episode enqueue when thresholds pass.
- Activity thresholds: at least 8 material turns, at least 20 minutes, or explicit substantial close.
- Subagent findings append as bounded events on parent scope when allowed.

Delivers:

- reliable shutdown resume
- common episode path across adapters

### Phase 5a: Checkpoint resume

Deliverables:

- Hard checkpoint requirement before pause, compaction, handoff, fork, scheduled delay, and shutdown when a goal is active.
- Process restart and interrupt resume through Agenr scope lookup plus `/goal get`.
- Optional `/goal edit`.
- Manual continuation only.

Delivers:

- multi-session task continuity without idle continuation

### Phase 5b: Long-horizon `/goal`

Precondition:

- User ran `/goal set`; model tools alone cannot enable `on_idle`.

Skeln owns:

- continuation lock
- no-active-turn check
- mailbox and pending-input checks
- approval gates
- interrupt handling
- budget watchdogs
- stop-on-user-input
- status pill and UI

Agenr owns:

- objective
- status
- counters
- checkpoint
- next actions
- lease and stale metadata when enabled

Controls:

- `/goal pause`
- `/goal resume`
- token budget
- time budget
- stop-after turns or wall clock, default off
- require-review-after, default 4 hours

Skeln re-fetches Agenr state inside the continuation lock immediately before starting another turn.

### Phase 6: Consolidation maturity

Deliverables:

- Richer episode generation from snapshot, events, and turn metadata.
- Inline or queued semantic/procedural candidate review.
- Surgeon-style revisitation of closed working sets.
- Enforced event retention policy.
- Evaluation suites for task preservation, stale-WIP avoidance, temporal correctness, and abstention.

## Success criteria

Phase 1:

- Model can create, read, update, and close scoped WIP through `agenr_work`.
- `/goal` reads from Agenr and `/goal set|clear` mutate Agenr first.
- Full working context is injected only at high confidence through a non-persistent path.
- Ambiguous scopes return a stub.
- Close produces final snapshot and optional candidate handoff without silent semantic entries.
- Existing durable memory behavior remains unchanged.
- Tests prove rendered working context is not persisted as a Skeln message.

Phases 2 and 3:

- Fork, clone, and resume produce predecessor context through host-neutral app services.
- Compaction triggers bounded refresh without duplicate summaries.
- Abandoned branches are queryable as exploration residue, not durable truth.
- OpenClaw and Skeln converge on shared lineage/artifact services.

Phase 5:

- Restart, interrupt, handoff, and scheduled pause resume from the last checkpoint.
- Idle continuation respects budgets, user input, approvals, and fresh Agenr state.

Phase 6:

- Closed work can become episodes, semantic candidates, and procedural candidates with evidence.
- The system learns without confusing temporary WIP for future-session truth.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Transient context leaks into replay | Non-persistent context path, audit pointer only, tests in Skeln |
| Scope collision | conservative confidence, explicit `workingSetId`, one-active-set invariant |
| Stale writes | required `expectedRevision`, transactional event append |
| Durable-memory pollution | separate tables, no semantic recall participation, explicit promotion |
| Whole-object deletion by model | typed granular update operations |
| Prompt bloat | snapshot-first render, salience trimming, single budget coordinator |
| Stale WIP trusted as fact | rendered staleness warning and authority ordering |
| Duplicate summaries | reference host compaction/branch summaries by source ref |
| Premature continuation | continuation delayed until checkpoints and lifecycle hooks are reliable |
| Runaway long-horizon work | Skeln watchdogs, budgets, review gates, stop-on-user-input |

## Non-goals

- Replacing durable entries, episodes, or procedures.
- Modeling WIP as temporary semantic entries.
- Capturing hidden chain-of-thought.
- Making Agenr a scheduler, executor, or approval authority.
- Reimplementing Skeln session persistence inside Agenr core.
- Auto-storing durable entries from compaction, branch summaries, or close.
- Building a full project manager, calendar, or ticket sync.
- Shipping autonomous continuation before checkpoint reliability.

## References

- [LangChain memory overview](https://docs.langchain.com/oss/python/concepts/memory)
- [LangGraph add memory](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [MemGPT](https://arxiv.org/abs/2310.08560)
- [Letta stateful agents](https://docs.letta.com/guides/core-concepts/stateful-agents)
- [Cloudflare Agents memory](https://developers.cloudflare.com/agents/concepts/memory/)
- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)
- [Graphiti adding episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes)
- [Zep paper](https://arxiv.org/abs/2501.13956)
- [CoALA](https://arxiv.org/abs/2309.02427)
- [Generative Agents](https://arxiv.org/abs/2304.03442)
- [Reflexion](https://arxiv.org/abs/2303.11366)
- [Voyager](https://arxiv.org/abs/2305.16291)
- [LongMemEval](https://arxiv.org/abs/2410.10813)
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493)
- [Mem0](https://arxiv.org/abs/2504.19413)
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory)
- [Mastra RAG and working memory postmortem](https://mastra.ai/blog/use-rag-for-agent-memory)
- [Skeln plugin docs](../../SKELN-PLUGIN.md)
- [OpenClaw plugin docs](../../OPENCLAW-PLUGIN.md)
- [Episodes docs](../../EPISODES.md)
