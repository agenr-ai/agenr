# Prior-art review: Skeln session memory, working memory, and `/goal`

Date: 2026-05-30
Reviewed plan: [`../2026-05-29-skeln-session-memory-working-memory-and-goal-plan.md`](../2026-05-29-skeln-session-memory-working-memory-and-goal-plan.md)
Scope assumption: no backward compatibility constraint. Agenr and Skeln can both change.

## Verdict

The plan is directionally correct. The strongest prior art supports its central split:

- short-term, thread-scoped working state should not be treated as durable truth
- session and checkpoint history should remain distinct from long-term semantic memory
- episodes should carry narrative and provenance, not replace facts, procedures, or active WIP
- `/goal` should be a host UX and runtime-control feature, while Agenr owns the durable working ledger

The plan needs changes before implementation. The most important change is to stop treating model-visible working memory as ordinary persisted Skeln messages. Today, Agenr's Skeln adapter injects hidden user messages through `before_agent_start`, and Skeln persists those injected messages into the session tree before the real user prompt. That is acceptable for carefully chosen durable recall, but it is the wrong default for volatile working context. If `<agenr_work_context>` is persisted every turn, it will pollute branch history, compaction inputs, session exports, and later episode extraction.

Recommended direction: keep the layered design, but change Phase 1 so working context is delivered through a non-persistent model-context path or a new explicit transient-injection contract. Persist only the working set and a small audit pointer, not the rendered turn-local prompt text.

## Prior-art synthesis

### 1. Layered memory is now the standard shape

LangGraph distinguishes thread-scoped short-term memory from cross-thread long-term memory, with short-term state persisted through checkpoints and long-term memory scoped by custom namespaces. Its memory guide also names semantic, episodic, and procedural memory as separate categories. See:

- [LangChain memory overview](https://docs.langchain.com/oss/python/concepts/memory)
- [LangGraph add memory](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

This supports the plan's north-star stack:

- working continuity: active task state
- session-tree checkpoints: compaction, branch, fork, resume artifacts
- episodes: what happened
- entries: durable facts, decisions, preferences, lessons
- procedures: reusable methods

The plan should keep this split. Do not collapse `/goal`, episodes, and durable entries into one table or one recall channel.

### 2. Context hierarchy beats full-history replay

MemGPT and Letta are strong prior art for hierarchical memory and virtual context management: important in-context memory, persisted messages, and out-of-context archival or recall memory. Letta's current stateful-agent docs describe persisted state, attached memory blocks, stored messages, runs, and conversations. See:

- [MemGPT paper](https://arxiv.org/abs/2310.08560)
- [Letta stateful agents](https://docs.letta.com/guides/core-concepts/stateful-agents)

This supports the plan's "working memory is front edge of consolidation" model. It also argues for a named, editable working ledger rather than re-deriving task state from transcript every turn.

### 3. Sessions and checkpoints are not the same as durable memory

Cloudflare's Agents Session API separates conversation history from context memory. It stores conversation history in a tree-structured message history and uses context blocks for persistent prompt-injected memory. It also explicitly discusses prompt caching and the cost of changing the prompt every turn. See:

- [Cloudflare Agents memory](https://developers.cloudflare.com/agents/concepts/memory/)

OpenAI Agents SDK sessions similarly manage conversation history across runs and offer session backends and compaction wrappers, but they are conversation-history storage, not a general durable-memory substrate. See:

- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)

These reinforce a key correction: Skeln's append-only session tree is not the correct storage location for the rendered working-memory block. The working set belongs in Agenr. Skeln's session tree should contain user/assistant/tool transcript, host checkpoints, and explicit audit artifacts, not repeated copies of volatile memory projections.

### 4. Episode provenance and temporal validity are proven ideas

Graphiti and Zep are the closest production-style prior art for temporal memory. Graphiti represents ingestion events as episodes and uses them to establish provenance for nodes and relationships. Zep's paper describes Graphiti as a temporally aware graph engine for conversational and business data. See:

- [Graphiti adding episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes)
- [Zep paper](https://arxiv.org/abs/2501.13956)

Agenr's existing internal Graphiti review reached the same conclusion: copy the temporal and provenance discipline, not Graphiti wholesale. This plan already aligns with that direction by using episodes and durable candidates instead of immediately promoting WIP to semantic entries. Strengthen that by requiring every candidate emitted from a working set to cite working-event sequence numbers and, after close, an episode source reference.

### 5. Experience, reflection, and skills should graduate through review

CoALA frames agents with modular memory components, internal/external actions, and a decision process. Generative Agents, Reflexion, and Voyager all support the idea that experiences and reflections can improve later behavior, but they also show why unreviewed lessons are dangerous:

- [CoALA](https://arxiv.org/abs/2309.02427)
- [Generative Agents](https://arxiv.org/abs/2304.03442)
- [Reflexion](https://arxiv.org/abs/2303.11366)
- [Voyager](https://arxiv.org/abs/2305.16291)

The plan's explicit close and promotion path is right. Keep semantic and procedural promotion explicit or reviewable. Do not let `agenr_work close` silently write durable entries.

### 6. Memory benchmarks favor structured, compact evidence

LongMemEval evaluates extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. LongMemEval-V2 moves closer to coding-agent reality by asking whether memory lets agents become "experienced colleagues" in specialized environments. Mem0 reports large gains from dynamic extraction, consolidation, and retrieval over full-context baselines. Mastra's Observational Memory work argues for stable, cacheable context and dense observations over per-turn dynamic retrieval in some workloads. See:

- [LongMemEval](https://arxiv.org/abs/2410.10813)
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493)
- [Mem0](https://arxiv.org/abs/2504.19413)
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory)

This supports bounded summaries and compact evidence over transcript replay. It also suggests a future evaluation axis for Agenr and Skeln: not "did recall return similar text?", but "did the agent preserve task state, avoid stale WIP, answer temporal questions, and update or abstain correctly?"

### 7. Working-memory update APIs must be granular

Mastra's working-memory postmortem is directly relevant. They found that replacing the whole working-memory object caused agents to delete older useful information when a conversation shifted, and moved toward more granular update semantics with update reasons. See:

- [Mastra RAG and working memory postmortem](https://mastra.ai/blog/use-rag-for-agent-memory)

For Agenr, this means `agenr_work update` should not be just "send the next snapshot blob". It should support patch-like or typed sections with expected revision, event type, update reason, and merge semantics. Full replacement can exist, but it should be explicit and rare.

### 8. Codex `/goal` is good runtime prior art, not a memory model to copy exactly

Local Codex source supports the plan's authority split:

- persisted goal state is small and thread-scoped
- runtime state owns locks, active turn state, budget baselines, and continuation scheduling
- model tools can read/create goals, but `update_goal` can only mark `complete` or `blocked`
- pause, resume, budget limits, and usage limits are controlled by user/system runtime
- continuation re-reads the goal under a lock and checks active-turn and mailbox gates before starting another turn

Skeln should borrow the UX and continuation discipline. Agenr should own a richer working ledger than Codex's goal object.

## Local code findings

### Finding 1: persisted `before_agent_start` messages are the wrong injection seam for WIP

Current Agenr adapter:

- [`src/adapters/skeln/hooks/before-agent-start.ts`](../../../../src/adapters/skeln/hooks/before-agent-start.ts) builds hidden user `AgentMessage` injections.
- [`docs/SKELN-PLUGIN.md`](../../../SKELN-PLUGIN.md) documents that current Skeln injection uses `session_start` and `before_agent_start`.

Current Skeln behavior:

- `/Users/jmartin/Code/skeln/src/runtime/prompt/preparation.ts` calls `emitBeforeAgentStart`, then persists `before_agent_start` messages via `sessionStore.appendMessage`, then appends them to `agent.state.messages`.
- `/Users/jmartin/Code/skeln/src/runtime/agent/boundary.ts` has a later `emitContext` path that transforms provider context without session-tree persistence.

Recommendation:

Change Skeln before Phase 1 to support one of these contracts:

1. Add `transientMessages` or `contextMessages` to `BeforeAgentStartResult`, with explicit `persist: false`.
2. Use the existing `context` event for `<agenr_work_context>` so it is model-visible but not appended to the session tree.
3. Persist only a compact `prompt_context` audit entry with `{source: "agenr_work", workingSetId, revision, bytes, summary}` while keeping rendered content out of replay.

Durable session-start recall may still use persisted injection if that remains intentional. Working context should not.

### Finding 2: Skeln has richer hooks than the Agenr adapter currently consumes

Skeln's `ExtensionAPI` already defines:

- `session_start` with `reason`
- `session_before_fork`
- `session_before_tree`
- `session_before_compact`
- `session_shutdown`
- `session_tree`
- `session_compact`
- `context`

Agenr's current `SkelnLifecycleHookRegistrar` narrows this to `session_start`, `before_agent_start`, and `tool_result`, with `session_shutdown` used outside the narrow type.

Recommendation:

Replace the plan's "verify hooks exist" wording with "extend Agenr's registrar and adapter tests to consume the existing Skeln hook payloads." The Skeln side already has most of the surface. The Agenr adapter is the bottleneck.

### Finding 3: `session_tree` appears typed but not emitted to extensions after navigation

Skeln's extension types include `session_tree`, but `/Users/jmartin/Code/skeln/src/runtime/session/tree-navigation.ts` currently emits a runtime event after tree navigation, not an extension-runner event. `session_before_tree` is emitted through the extension runner, but the after event appears runtime-listener-only.

Recommendation:

Before Phase 3, wire `session_tree` to extension handlers after navigation or remove it from the Agenr plan as a dependency. Agenr needs the after event to persist exact `oldLeafId`, `newLeafId`, and `summaryEntry` facts after the host has committed the branch change.

### Finding 4: compact event field names should match Skeln

Skeln maps compaction hooks to extension events with:

- `session_before_compact`
- `session_compact`
- `SessionCompactEvent.fromExtension`

The Agenr plan's `HostMemoryEvent.compaction.fromHook` can be adapter-internal, but the Skeln adapter should normalize from `fromExtension`, not assume Skeln has a `fromHook` field.

### Finding 5: `threadId` is not a current Skeln primitive

The plan requires `threadId` in several places, but current Skeln scope exposes session id, cwd, optional git facts, project, and session key. If we can change both repos, there are two viable paths:

1. Add a real Skeln `conversationKey` or `threadKey` concept to the session header and lifecycle context.
2. Make Agenr's `threadId` field optional and host-neutral, with `sessionKey` plus git/project scope as Phase 1's required identity.

Recommendation:

Prefer a host-neutral `conversationKey` or `runtimeThreadKey` in the plan language. Only call it `threadId` at Codex compatibility edges.

## Required plan changes

### P0: Change the injection contract

Phase 1 should not say "Skeln injects as hidden user-context message" without also saying whether it persists. Change it to:

- Agenr returns a rendered `<agenr_work_context>` plus metadata `{workingSetId, revision, sourceRef}`.
- Skeln displays it to the model through a non-persistent context path.
- Skeln may persist an audit pointer, never the full rendered WIP block by default.
- If a host chooses to persist working context, it must mark it as an injected memory projection and exclude it from episode mining and compaction source text unless explicitly requested.

### P0: Add active working-set cardinality invariants

The plan says one active thread maps to at most one working set, but `create=true` can accidentally create parallel active sets at the same scope.

Add:

- one non-closed working set per resolved scope unless explicit `taskId` is supplied
- `expectedRevision` required for update and close
- `UNIQUE(working_set_id, sequence)` for events
- transactional snapshot revision plus event append
- explicit replace semantics that close, abandon, or supersede the previous active set

SQLite can enforce much of this with partial unique indexes if the status vocabulary remains stable. Otherwise enforce it in the app service inside a write transaction.

### P0: Make updates typed and granular

Change `agenr_work update` from "arbitrary snapshot update" to typed operations:

- `set_objective`
- `replace_plan`
- `merge_checkpoint`
- `add_file_note`
- `add_command_note`
- `record_decision`
- `record_assumption`
- `set_next_actions`
- `set_status`
- `add_candidate`

Every update should carry `expectedRevision` and `updateReason`. Full snapshot replacement should be an explicit admin-style operation.

### P1: Treat close as consolidation, not automatic durable truth

Keep "close creates episode" only when close is explicit and substantial enough. For `/goal clear`, tiny goals, or abandonment, write a final checkpoint and optionally queue an episode candidate instead of forcing a rich episode.

When an episode is created:

- source should be `working_set:<id>#rev:<revision>`
- evidence should include working-event sequence ranges
- semantic and procedural outputs should be candidates, not entries
- close should be deterministic/no-LLM in Phase 1 unless the plan adds a bounded summary dependency

### P1: Add prompt-injection and staleness rules

The plan already says to XML-escape objectives. Extend that to every model-visible working-set field:

- objective
- notes
- files
- commands
- open questions
- candidate text
- external links

Rendered working context should say that WIP may be stale or hypothetical and that filesystem, git, tests, and tool output are authoritative for current-state claims.

### P2: Align lifecycle hooks with Skeln's real event model

Use these Skeln events:

- `session_start`: resolve scope and transition reason
- `session_before_fork`: require/checkpoint active working set before fork
- `session_before_compact`: require/checkpoint active working set before compact
- `session_compact`: upsert compaction artifact and refresh working checkpoint
- `session_before_tree`: derive branch-abandonment summary from `entriesToSummarize`
- `session_tree`: persist committed branch movement after Skeln wires it to extensions
- `session_shutdown`: checkpoint only, never implicit close

Do not create duplicate summaries when Skeln already wrote a compaction or branch summary. Store source refs and derived metadata.

### P2: Add cross-repo regression tests early

Minimum Agenr tests:

- working-set create/update/close revision conflicts
- one-active-working-set invariant
- update operations append ordered events
- close emits episode/candidate payload with evidence sequences
- before-turn renderer refuses ambiguous scopes

Minimum Skeln tests:

- transient Agenr work context reaches provider context but is not appended as a session `message`
- persisted audit pointer does not re-enter live replay as a user message
- compaction input excludes transient working-context projections
- `session_tree` after-event reaches extension handlers once implemented
- `/goal` commands use Agenr-first mutation order and do not advance volatile state on Agenr failure

## Revised phase advice

### Phase 1 should be smaller and stricter

Ship:

- `working_sets` and `working_events`
- `agenr_work get/list/update/close`
- scoped resolution with `sessionKey`, cwd, git root/branch when available
- non-persistent working-context injection
- close to final snapshot plus optional deterministic episode
- no fork/tree/compaction dependence except checkpoint guidance

Do not ship:

- native continuation
- automatic lifecycle mining
- branch-abandonment recall
- broad durable promotion
- persisted per-turn working-context messages

### Phase 2 should be lifecycle capture, not continuation

Wire real Skeln lifecycle events and session artifacts before autonomous continuation. This order matters because continuation without reliable checkpoints just lets the agent run longer while losing more state.

### Phase 5 should borrow Codex gates closely

For long-horizon `/goal`:

- Skeln owns continuation locks, mailbox checks, active-turn checks, approvals, interrupts, budgets, and watchdogs
- Agenr stores objective, status, counters, checkpoint, next actions, and lease metadata
- Skeln re-fetches Agenr state inside the continuation lock before starting another turn
- model tools can mark complete or blocked under strict audit rules, but user/system controls pause, resume, budget limit, usage limit, and cancellation

## Final recommendation

Proceed with the plan after the above changes. The core architecture is right and well supported by prior art. The main implementation risk is not schema shape. It is letting transient working projections leak into the same replay substrate as the user's actual conversation. Fix that first, then the rest of the plan becomes much more defensible.
