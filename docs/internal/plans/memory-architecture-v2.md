# Memory Architecture v2 — Getting agenr on the Right Track

> Informed by research from `docs/internal/research/sub-agents/agenr-vision/` and `docs/internal/research/sub-agents/episodic-memory/`.

## Vision

agenr is **shared human memory for all types of AI agents**. Not a chatbot memory plugin — a durable memory backend that any agent, on any surface, can use to remember what matters.

The research is clear: effective agent memory needs more than one shape. The cognitive science taxonomy (semantic, episodic, procedural, working) isn't just theory — it maps directly to different storage models, write paths, and retrieval behaviors. Systems that try to force everything into one table with one recall algorithm produce the exact failures agenr has already observed.

**The goal of this plan:** Adopt the taxonomy as a product compass. Build the foundations right while the codebase is small enough to restructure cheaply. Don't over-engineer — only create first-class subsystems when they need different storage, write paths, and retrieval.

---

## The Four-Tier Model

| Tier | What it is | agenr's role | Status |
|---|---|---|---|
| **Semantic memory** | Distilled durable knowledge: facts, decisions, preferences, lessons, relationships | First-class durable store. `entries` table. | ✅ Exists. Needs cleanup. |
| **Episodic memory** | Session-level narratives with time ranges: what happened, when | First-class durable store. `episodes` table. | 🔨 Planned. See episodic-memory plan. |
| **Procedural memory** | Behavioral rules, workflows, learned conventions | Lightweight: semantic entries + external files (SOUL.md, AGENTS.md, skills). | ⏳ Defer. Revisit when retrieval needs diverge. |
| **Working memory** | Current-task transient context: context window, tool state, active reasoning | **Not agenr's job.** Owned by the runtime (OpenClaw, Codex, etc.). | ❌ Out of scope. |

**The rule:** Only create a first-class memory subsystem when it needs a different storage model, write path, and retrieval behavior. By that rule, semantic and episodic qualify now. Procedural doesn't yet. Working memory never will.

---

## Part 1: Semantic Memory Cleanup

### What `entries` is

`entries` is agenr's **semantic memory store** — distilled, durable, reusable knowledge.

The table name stays `entries`. The domain types can evolve to `KnowledgeEntry` / `KnowledgeType` if clarity is needed, but renaming the SQL table to `semantic_memory` would be over-theoretical for what the table actually stores (decisions and lessons aren't purely "semantic" in the cognitive science sense — they're policy/procedural in meaning but declarative in representation).

### What belongs in `entries`

| Type | Verdict | Rationale |
|---|---|---|
| `fact` | ✅ Keep | Purest fit. Declarative knowledge about the world. |
| `decision` | ✅ Keep | Standing rules, architecture choices, conventions. Policy in meaning, declarative in form. |
| `preference` | ✅ Keep | Stable propositions about what a person/team/system values. |
| `lesson` | ✅ Keep | Distilled reusable takeaways from experience. The bridge between episodic and semantic. |
| `relationship` | ✅ Keep | Typed connections between people, systems, projects. May evolve toward graph treatment later. |
| `event` | ⚠️ Rename → `milestone` | Currently ambiguous between "historical fact" and "episodic narrative." Narrow it to notable one-time facts (launches, releases, transitions). Episodic narratives go to `episodes`. |
| `todo` | ❌ Break out | Task management, not memory. Needs status, completion, due dates. Doesn't fit the entry schema or recall model. |
| `reflection` | ❌ Remove | Already legacy in practice — absent from extraction, surgeon treats it as cleanup fodder. Scorched earth: remove from type union, bulk-retire existing entries, no migration path. |

### Migration: `event` → `milestone`

1. Add `milestone` to `EntryType` union
2. Migrate existing `event` entries: rename type to `milestone` in DB
3. Update extraction prompts, tool descriptions, surgeon prompts
4. Remove `event` from the public type set
5. Clarify in docs: `milestone` = "a notable historical fact worth remembering" (not a session narrative)

### Migration: `todo` → separate system

1. Create `tasks` table (or `open_loops`):

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open, completed, abandoned
  priority    INTEGER DEFAULT 5,
  tags        TEXT,                           -- JSON array
  source_context TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  completed_at TEXT,
  due_at      TEXT
);
```

2. Migrate existing `todo` entries to `tasks` table
3. Add `agenr_task` tool (or extend existing tools) for task creation/completion
4. Remove `todo` from `EntryType` union
5. Surgeon stops managing `todo` lifecycle — tasks have their own completion semantics

### Removal: `reflection` (scorched earth)

1. Remove `reflection` from `ENTRY_TYPES` union in `core/types.ts`
2. Remove from extraction prompts (already absent)
3. Remove from tool descriptions, surgeon prompts, any remaining references
4. Schema migration: `DELETE FROM entries WHERE type = 'reflection'`
5. No soft-delete, no retirement, no backward compat — just gone

### Scoping fields (future-proofing)

The competitive analysis (Mem0, Zep) shows that **structured scoping** matters for multi-agent/multi-user systems. Not critical for v1 but worth adding to the schema now while migration is cheap:

```sql
ALTER TABLE entries ADD COLUMN user_id TEXT;
ALTER TABLE entries ADD COLUMN project TEXT;
```

- `user_id` — whose memory is this? (For multi-user future.)
- `project` — which project context? (Already used in agenr config but not in the entry schema.)

These can be nullable and ignored initially. But having them in the schema avoids a painful migration later.

---

## Part 2: Episodic Memory

Detailed plan at `docs/internal/plans/episodic-memory.md` (already revised from review feedback).

**Summary:** New `episodes` table with time ranges (`started_at`/`ended_at`), stable `source_id` dedup, interval-based retrieval, unified recall via `agenr_recall` with `mode` parameter. Written by the system at session boundaries, not by agents mid-conversation.

No changes from the revised episodic memory plan — it already incorporates the review feedback.

---

## Part 3: Procedural Memory

> This section reflects an older defer decision. The current v1 procedural-memory direction lives in [2026-04-13-procedural-memory-v1.md](./2026-04-13-procedural-memory-v1.md).

### Why not now

Procedural memory is real — "when Jim says X, he means Y", "use this workflow for PR reviews", "always check memory before claiming uncertainty." But today these are adequately served by:

1. **External instruction files** — SOUL.md, AGENTS.md, skill docs, system prompts. These are normative, always-on, and don't need recall.
2. **Semantic entries** — `lesson`, `preference`, `decision` entries with good tags. These are learned durable guidance retrieved through normal recall.

The test for breaking procedural memory out: **"These items need different write permissions, different ranking, and proactive activation."** agenr isn't there yet.

### When to revisit

Create a first-class procedural system (call it `playbooks` or `procedures`, not "procedural memory core") when:
- Agents consistently fail to recall relevant workflow guidance through semantic recall
- There's a need for trigger-condition-based activation (not just query-based retrieval)
- Procedural items need structured steps, priority ordering, or execution semantics
- The volume of procedural knowledge creates noise in semantic recall

### What it might look like (sketch for future reference)

```sql
CREATE TABLE IF NOT EXISTS playbooks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  trigger_pattern TEXT,             -- when to activate
  scope           TEXT,             -- global, project, user, tool
  steps           TEXT NOT NULL,    -- structured content
  priority        INTEGER DEFAULT 5,
  tags            TEXT,
  source          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

But don't build this until the need is proven.

---

## Part 4: Working Memory (Not agenr's Job)

Working memory is:
- Short-lived, task-bound, latency-sensitive, frequently rewritten
- Context window, active tool state, chain-of-thought, compaction state

This belongs to the runtime (OpenClaw, Codex, etc.), not to agenr.

**agenr's only working-memory role:** Boundary artifacts.
- Predecessor summaries (session handoff)
- Episodes written at session end
- `temporary` expiry entries for short-horizon context that should survive a crash but not persist indefinitely

Do not expand this into "agenr is the context window backend."

---

## Part 5: Unified Recall API

### One tool, multiple memory kinds

The agent-facing API stays unified:

| Tool | Purpose |
|---|---|
| `agenr_store` | Semantic memory only. Agents store knowledge. |
| `agenr_recall` | Unified recall across semantic + episodic. Auto-routes by query intent. |
| `agenr_retire` | Retire semantic entries. |
| `agenr_update` | Update semantic entries. |
| `agenr_trace` | Trace provenance (eventually across semantic + episodic). |

`agenr_recall` gains:
- `mode`: `"auto"` (default), `"entries"`, `"episodes"` — explicit override when the agent knows what it wants
- Auto-routing: temporal intent detection → episodic first; factual queries → semantic first; mixed → both
- Result annotations: `kind: "entry" | "episode"` so the agent knows what it's looking at

### Separate internals, unified surface

Internally, semantic and episodic recall are different pipelines:
- `RecallPorts` — entry-centric, embedding-dependent (existing)
- `EpisodeRecallPorts` — interval-based, embedding-optional (new)

Do **not** bloat `RecallPorts` into a universal abstraction. Keep the pipelines honest and specialized. The unified `agenr_recall` tool is an orchestration layer on top, not a shared base class.

**Critical constraint:** Pure episodic recall must work without embeddings. "What happened yesterday" should never fail because the embedding provider is down.

---

## Part 6: Schema Evolution

### Schema v3 (this release)

```
entries table:     add user_id, project columns (nullable)
episodes table:    create (full schema from episodic-memory plan)
tasks table:       create (for todo migration)
schema version:    bump to 3
```

### Data migrations

1. `event` entries → rename type to `milestone`
2. `todo` entries → copy to `tasks` table, retire from entries
3. `reflection` entries → hard delete from DB, remove type from union

### Migration safety

- All new columns/tables are additive — no destructive changes
- Type renames are backward-compatible (old entries still readable)
- `todo` migration is copy-then-retire, not delete
- Schema version check on startup ensures migrations run once

---

## Implementation Roadmap

### Wave 1: Semantic cleanup (small, bounded)

**Goal:** Tighten what `entries` is. Remove misfits.

1. Add `milestone` to `EntryType`, begin `event` → `milestone` migration
2. Create `tasks` table, migrate `todo` entries
3. Deprecate `reflection` from extraction and tool guidance
4. Add `user_id` and `project` columns to entries (nullable)
5. Update extraction prompts, tool descriptions, surgeon prompts
6. Bump schema to v3

**Estimated scope:** ~15 files touched. No recall pipeline changes. No new retrieval logic.

### Wave 2: Episodic memory (per episodic-memory plan)

**Goal:** Add the second pillar of durable memory.

Per the revised `docs/internal/plans/episodic-memory.md`:
- Phase 1-4: Schema, storage, write-on-reset, episode recall with temporal window parser
- Phase 5: Backfill ingest
- Phase 6+: Hybrid semantic episode search, multi-episode synthesis

### Wave 3: Store nudge (per store-nudge plan)

**Goal:** Solve the storage sparsity problem that makes all memory worse.

Per `docs/internal/plans/store-nudge-v1.md`:
- Phase 1-4: Mid-session state tracking, `after_tool_call` store detection, nudge injection
- Phase 5: Smart LLM-powered nudge

### Wave 4: Evaluate procedural memory need

**Goal:** Decide whether procedural memory deserves its own system.

- Observe what workflow/convention knowledge agents store as entries
- Look for recall failures where good procedural knowledge exists but isn't retrieved
- Look for activation patterns (trigger-based, not query-based)
- If the need is proven, design and build `playbooks`

### Wave 5: Cross-links and provenance (future)

**Goal:** Connect the memory tiers.

- `episode_entry_links` table — which entries were formed from which episodes
- Enhanced `agenr_trace` showing episodic provenance for semantic entries
- Episodic → semantic consolidation (periodic distillation of recurring episode themes into entries)

---

## Naming and Language

### In code

| Current | Keep or change | New |
|---|---|---|
| `entries` table | Keep | — |
| `Entry` type | Keep (optionally → `KnowledgeEntry` later) | — |
| `EntryType` | Keep (optionally → `KnowledgeType` later) | — |
| `episodes` table | — | New |
| `Episode` type | — | New |
| `tasks` table | — | New |
| `RecallPorts` | Keep | — |
| `EpisodeRecallPorts` | — | New (separate, not extending RecallPorts) |

### In product/docs/prompts

| Concept | Language |
|---|---|
| `entries` | "semantic memory" or "knowledge entries" |
| `episodes` | "episodic memory" or "session episodes" |
| `tasks` | "open loops" or "tasks" |
| Procedural knowledge | "learned guidance" (stored as entries for now) |
| Working memory | "session context" (runtime-owned) |

---

## Anti-Patterns to Avoid

1. **Don't build a universal `memory` super-table.** Semantic and episodic memory have different natural keys, retrieval logic, and ranking models. One table with nullable columns for everything is a trap.

2. **Don't force one recall algorithm for every memory kind.** Current recall is semantic-first and embedding-dependent. That's wrong for pure temporal episodic recall. Use different retrieval logic when the query type is different.

3. **Don't make embeddings a hard dependency for episodic recall.** "What happened yesterday" must work with interval parsing + SQL overlap alone.

4. **Don't let agents write episodes.** Episodes are system-written at session boundaries. Agents store entries. The distinction keeps both systems clean.

5. **Don't expand agenr into a working-memory backend.** agenr is durable, selective, high-signal, cross-session memory. Not a live scratchpad.

6. **Don't stuff more concepts into `EntryType`.** The flat union is already overloaded. New memory kinds get new tables, not new types in the union.

7. **Don't do the grand four-tier reorg before the product behavior exists.** Build semantic + episodic first. Evaluate procedural later. Let usage drive architecture, not taxonomy.

8. **Don't leak implementation complexity to agents.** One recall tool. Auto-routing. Agents don't need to know about tables and pipelines.

---

## Success Criteria

After Waves 1-3:

- **"What did we do yesterday?"** → returns rich episode summaries from that day
- **"What's the default threshold?"** → returns precise semantic entries (existing behavior, no regression)
- **Agent stores knowledge consistently** → store nudge catches sparse sessions
- **`todo` items have proper lifecycle** → not decaying in the entries table
- **`event` confusion eliminated** → `milestone` is clear, episodes handle narratives
- **No agent UX churn** → same tools, same prompts, auto-routing handles the rest
- **Cross-surface portable** → any agent with brain access can query episodes, not just OpenClaw
