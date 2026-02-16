# Prompt Candidate B — Selective Extraction with Importance Scoring

**Date:** 2026-02-15  
**Author:** Subagent (prompt-writer-B)

---

## Design Philosophy

The core question for every potential memory: **"Would knowing this change how I approach a future conversation?"** If no, don't extract it.

The current prompt says "extract ALL knowledge" — that's the root bug. This prompt inverts the default: **skip unless worth remembering.**

---

## 1. Full System Prompt

```
You are a selective memory extraction engine. You read conversation transcripts
and extract ONLY knowledge worth remembering long-term.

YOUR DEFAULT IS TO SKIP. Most conversation chunks contain nothing worth storing
in long-term memory. Routine task execution, debugging steps, code output, and
assistant narration are NOT memories. Only extract entries that would change how
someone approaches a FUTURE conversation or task.

## What to Extract

FACT — Verifiable information about a person, system, project, or concept that
would be useful to know in a future context. "Jim's mother has two dogs named
Tucker and Oliver." "The Domino's unofficial API lives at order.dominos.com/power/*."

DECISION — A choice that sets direction and constrains future options. Must
include the WHY, not just the WHAT. "Chose SQLite over Postgres for agenr because
it's single-user, zero-config, and embeddable."

PREFERENCE — A stated or strongly demonstrated preference that should influence
future behavior. "Jim prefers specs and research before coding, not rushing to ship."
"Jim wants sub-agents for heavy context work, not in-line dumps."

LESSON — An insight derived from experience that should change future behavior.
"Dead CI is worse than no CI because it creates false confidence."

EVENT — A significant occurrence worth referencing later. Milestones, launches,
hires, completions. NOT "the assistant ran git status."

RELATIONSHIP — A connection between entities worth knowing. "Jim works at [company]."
"agenr is built on @mariozechner/pi-ai."

TODO — A genuine persistent action item that outlives this conversation. NOT
session-ephemeral instructions like "run this command" or "check this log."

## Importance Scale (1-10)

Every entry gets an importance score. This is the most critical field — calibrate carefully.

### 1-2: Don't extract these. (Examples of what to SKIP, not store.)
- "The assistant ran git status and found 3 modified files"
- "User asked for help with a TypeScript error"
- "The build succeeded after fixing the import"
- Intermediate debugging steps, routine commands, transient state

### 3-4: Marginal — extract only if nothing better exists in the chunk
- Current branch name or PR number (stale in days)
- Which specific test file was modified
- A minor config value that could be looked up

### 5-6: Contextually useful — worth storing
- Active project details: "agenr extraction pipeline processes JSONL session transcripts"
- Current work state: "Migrating from confidence field to importance scoring"
- Technical context: "agenr uses text-embedding-3-small at 512 dimensions"
- Team/org facts: "Engineering team uses React + TypeScript stack"

### 7-8: Significant — would meaningfully help a future conversation
- Architecture decisions with rationale
- Lessons learned from failures
- Workflow preferences that affect how to interact
- Key relationships (who works on what, who reports to whom)
- Project milestones and outcomes

### 9-10: Core — identity-level or life-changing
- Biographical facts (family, location, career history)
- Deep personal preferences that define interaction style
- Fundamental principles ("specs before code", "dead CI is worse than no CI")
- Life events (job changes, moves, major milestones)

## Subject Field Rules

The subject is the TOPIC — never the actor.

GOOD subjects:
- "agenr extraction pipeline"
- "Tailscale SSH setup"
- "end-of-day briefing workflow"
- "Jim Martin" (ONLY for biographical facts ABOUT Jim)
- "Tucker and Oliver" (Jim's mother's dogs)

BAD subjects (NEVER use these):
- "User", "user", "Human", "human"
- "Assistant", "assistant", "AI", "Bot"
- "EJA", "the assistant", "the user"
- "the conversation", "this session", "the transcript"

If you can't name a specific topic, the entry probably isn't worth extracting.

## Anti-Patterns — DO NOT EXTRACT

1. **Assistant narration:** "The assistant decided to...", "The assistant was instructed to...",
   "EJA ran the command...", "The assistant suggested..." — These describe process, not knowledge.

2. **Session-ephemeral instructions:** "Run codex from ~/Code/agenr", "Check the gateway logs",
   "Do a hard refresh with Cmd+Shift+R" — These are commands, not memories.

3. **Code-level details:** "The function expandInputFiles uses expandGlobRecursive",
   "Line 42 of store.ts has a bug in the hash check" — These go stale with every commit.
   Exception: architecture-level patterns or recurring bug categories ARE worth extracting.

4. **Meta-commentary:** "The conversation covered several topics including...",
   "In this session, the user and assistant discussed..." — This is narration, not knowledge.

5. **Redundant obvious facts:** "agenr is a CLI tool" (if this is already established context),
   "TypeScript is a typed superset of JavaScript" — Common knowledge isn't memory.

6. **One step of a multi-step workflow as separate entries:** If a workflow has 5 steps,
   extract ONE entry describing the whole workflow, not 5 entries for each step.

## Expiry Rules

- **permanent:** Biographical facts, preferences, lessons, relationship facts, architecture decisions
- **temporary:** Current project state, active work context, recent events (will decay)
- Do NOT use "session-only" — if it only matters for this session, don't extract it at all.

## Output Rules

- Call submit_knowledge with extracted entries.
- If the chunk contains NOTHING worth remembering, call submit_knowledge with an EMPTY entries array. This is expected and correct — most chunks are routine.
- Target: 0-8 entries per chunk. If you're producing more than 8, you're not being selective enough.
- Each entry must be self-contained and understandable without the transcript.
- The content field should be a clear declarative statement, not a quote from the transcript.
- source_context: one sentence, max 20 words. Where in the conversation this came from.
```

---

## 2. Schema Changes

### Replace `confidence` with `importance`

The confidence field is broken — 96.5% of entries are "high" because the LLM maps it to "was this explicitly stated?" which is almost always yes. Importance is the signal that actually matters for retrieval.

```typescript
// schema.ts — PROPOSED

export const KnowledgeEntrySchema = Type.Object({
  type: Type.Union([
    Type.Literal("fact"),
    Type.Literal("decision"),
    Type.Literal("preference"),
    Type.Literal("todo"),
    Type.Literal("relationship"),
    Type.Literal("event"),
    Type.Literal("lesson"),
  ]),
  subject: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  importance: Type.Integer({ minimum: 1, maximum: 10 }),
  expiry: Type.Union([
    Type.Literal("permanent"),
    Type.Literal("temporary"),
  ]),
  scope: Type.Optional(Type.Union([
    Type.Literal("private"),
    Type.Literal("personal"),
    Type.Literal("public"),
  ])),
  tags: Type.Array(Type.String()),
  source_context: Type.String(),
});
```

### Key changes:

| Field | Before | After | Why |
|-------|--------|-------|-----|
| `confidence` | `high\|medium\|low` | **REMOVED** | Useless — 96.5% "high". Replaced by importance. |
| `importance` | (didn't exist) | `1-10 integer` | The single most important ranking signal. Calibrated with examples in prompt. |
| `expiry` | `permanent\|temporary\|session-only` | `permanent\|temporary` | `session-only` eliminated — if it's session-only, don't extract it. |

### DB migration:

```sql
ALTER TABLE entries ADD COLUMN importance INTEGER DEFAULT 5;
-- Keep confidence column for backward compat, stop using in scoring
-- Backfill: map high→6, medium→5, low→3 as starting point, then LLM-rescore
```

### Should we add an "actionability" field?

**No.** Actionability is already captured by the type system (todos and decisions are inherently actionable, facts and events are not) and by importance (a high-importance lesson is more actionable than a low-importance one). Adding another numeric field creates the same calibration problem we're solving. Keep it simple: type + importance is sufficient.

### Should entry types be refined?

**Not now.** The current 7 types map reasonably well to cognitive memory categories (semantic: fact/relationship, episodic: event, procedural: preference/lesson, prospective: todo/decision). The problem isn't the types — it's what gets extracted into them. Fix extraction quality first; refine types only if recall quality demands it.

---

## 3. User Prompt Change

```typescript
function buildUserPrompt(chunk: TranscriptChunk): string {
  return [
    "Read this conversation chunk and extract ONLY knowledge worth remembering long-term.",
    "If nothing is worth remembering, return an empty entries array.",
    "",
    "Transcript:",
    "---",
    chunk.text,
    "---",
    "",
    "Call submit_knowledge with extracted entries (or empty array if nothing worth storing).",
  ].join("\n");
}
```

Key change: "Extract all knowledge" → "Extract ONLY knowledge worth remembering long-term" + explicit permission to return empty.

---

## 4. Post-Extraction Validation Changes

Add to `validateKnowledgeEntry` (or as a separate filter pass):

```typescript
const BLOCKED_SUBJECTS = new Set([
  "user", "assistant", "the user", "the assistant",
  "human", "ai", "bot", "system", "eja",
  "the conversation", "this session", "the transcript",
]);

const META_PATTERNS = [
  /^the (assistant|user|ai|bot) (was |is |has been |should |decided to |suggested )/i,
  /^(assistant|user) (mentioned|stated|said|discussed|asked|instructed)/i,
  /^in (the |this )?(conversation|session|transcript)/i,
  /^(eja|the assistant) (ran|executed|checked|looked at|opened)/i,
];

function shouldRejectEntry(entry: KnowledgeEntry): string | null {
  const subjectLower = entry.subject.toLowerCase().trim();
  if (BLOCKED_SUBJECTS.has(subjectLower)) {
    return `blocked subject: "${entry.subject}"`;
  }
  for (const pattern of META_PATTERNS) {
    if (pattern.test(entry.content)) {
      return `meta-pattern match: ${pattern}`;
    }
  }
  if (entry.content.length < 20) {
    return "content too short";
  }
  return null; // accept
}
```

---

## 5. Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Entries per session | 50-150 | 5-30 |
| Subject = actor name | ~550 entries (4.4%) | 0 (blocked) |
| Meta-narration entries | ~2,500 (20%) | 0 (anti-patterned + filtered) |
| Confidence distribution | 96.5% "high" | N/A (field removed) |
| Importance distribution | N/A | Calibrated 1-10 with examples |
| Session-only entries | 1,102 (9%) | 0 (expiry option removed) |
| Empty/NOOP chunks | 0% | Est. 30-50% of chunks |

---

## 6. Rationale Summary

The fundamental insight from the Generative Agents paper (Park et al., 2023): **memories are valuable in proportion to how much they change future behavior.** Their importance scoring (1-10, LLM-assigned at creation) is the single most predictive feature for memory retrieval quality.

The current prompt fails because it optimizes for **completeness** ("extract ALL knowledge"). The new prompt optimizes for **selectivity** ("would this change a future conversation?"). This aligns with how human memory actually works — we don't remember everything, we remember what matters.

The NOOP/empty-array mechanism is critical. Mem0 and LangMem both allow the extraction step to say "nothing worth storing." Without this, the LLM is forced to find *something* in every chunk, which is why it resorts to narrating what the assistant did.

Replacing confidence with importance isn't just renaming — it's changing what we're asking the LLM to evaluate. Confidence asks "how sure are you this was said?" (almost always: very sure). Importance asks "how much does this matter for the future?" — a much harder, more discriminating question. The calibration examples anchor the scale so the LLM can't just stamp 8 on everything.
