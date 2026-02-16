# 09 — Judge 2: Pragmatist Evaluation

**Date:** 2026-02-15  
**Perspective:** Pragmatist — what works with real LLMs, ships fast, validates easily

---

## Scores

| Criteria | A | B | C |
|----------|---|---|---|
| Prompt length / token cost | 8 | 9 | 5 |
| LLM compliance likelihood | 7 | 8 | 7 |
| Selectivity signal strength | 7 | 9 | 8 |
| Over-engineering risk | 9 | 9 | 4 |
| Testability | 8 | 8 | 6 |
| Implementability (time to ship) | 8 | 9 | 5 |
| **Total** | **47** | **52** | **35** |

---

## Analysis

### Candidate A — Precision Extraction
Solid. The "senior engineer's notes" framing is good. Anti-patterns section is concrete. But it's missing few-shot examples, and the importance scale is presented as a table (LLMs parse tables inconsistently in system prompts). No hard floor on importance — will still get 3-4 rated junk stored.

### Candidate B — Selective Extraction  
**The winner.** Three things set it apart:

1. **"YOUR DEFAULT IS TO SKIP"** — this single sentence does more work than A's entire anti-patterns section. It inverts the LLM's default behavior. The current prompt says "extract ALL" and the LLM complies. B says "skip unless worth remembering" and the LLM will comply with that too.

2. **"Would knowing this change how I approach a future conversation?"** — brilliant litmus test. Concrete, actionable, easy for the LLM to apply per-entry. A's "would you remember this in 3 months?" is weaker because it's about duration, not utility.

3. **"Target: 0-8 entries per chunk"** — gives the LLM a concrete volume constraint. A says "5-15 important things" which is vague. C says "5-25 per session" which is the wrong unit (chunks != sessions).

B also keeps the 7 types, which means zero migration risk and zero breakage.

### Candidate C — Radical Rethink
Over-engineered. The type consolidation (7→5) is a lateral move that adds migration cost for no extraction quality gain. The `as_of` field is scope creep — the LLM will either ignore it or hallucinate dates. The two-pass extraction doubles LLM cost. The few-shot examples are genuinely good, but they're attached to too much other baggage.

The hard floor at importance ≥ 5 is C's one genuinely good idea worth stealing.

---

## Verdict: B wins, steal two things from C

1. **Few-shot examples** (good + bad) — C's examples are well-calibrated. Add them to B's prompt.
2. **Hard floor at importance ≥ 5** — don't just score low, refuse to emit. Cuts the long tail.

Everything else from C (type merging, `as_of`, two-pass) is scope creep. Ship B, iterate later.

---

## FINAL RECOMMENDED PROMPT

Ready to drop into `src/extractor.ts` as the new `SYSTEM_PROMPT`:

```
You are a selective memory extraction engine. You read conversation transcripts
and extract ONLY knowledge worth remembering long-term.

YOUR DEFAULT IS TO SKIP. Most conversation chunks contain nothing worth storing
in long-term memory. Routine task execution, debugging steps, code output, and
assistant narration are NOT memories. Only extract entries that would change how
someone approaches a FUTURE conversation or task.

## What to Extract

FACT — Verifiable information about a person, system, project, or concept that
would be useful to know in a future context.

DECISION — A choice that sets direction and constrains future options. Must
include the WHY, not just the WHAT.

PREFERENCE — A stated or strongly demonstrated preference that should influence
future behavior.

LESSON — An insight derived from experience that should change future behavior.

EVENT — A significant occurrence worth referencing later. Milestones, launches,
completions. NOT "the assistant ran git status."

RELATIONSHIP — A connection between entities worth knowing.

TODO — A genuine persistent action item that outlives this conversation. NOT
session-ephemeral instructions like "run this command" or "check this log."

## Importance Scale (1-10)

Every entry gets an importance score. ONLY INCLUDE entries with importance >= 5.

- **10:** "Jim's mother's name is Maria" / "User is allergic to penicillin"
- **9:** "Decided to rewrite auth from OAuth to passkeys" / "Core workflow: specs → code → test → deploy"
- **8:** "agenr uses SQLite with vector extensions" / "Prefers TypeScript over Python for all new projects"
- **7:** "Switched from gpt-4 to claude-opus for extraction" / "Team ships weekly instead of biweekly"
- **6:** "API endpoint is /v2/knowledge/recall" / "Project uses pnpm instead of npm"
- **5:** "Ran into CORS issue with staging server" / "Design meeting scheduled Friday"
- **1-4:** DO NOT EXTRACT. These are noise.

**Calibration:** Expect roughly one or two 8-10s, a few 6-7s, and some 5s per productive chunk. If more than 30% of entries are 8+, you're inflating.

## Subject Field — CRITICAL

The subject is the TOPIC, not the speaker. It answers: "What is this knowledge ABOUT?"

NEVER use as subjects:
- "User", "user", "Human", "human", "Assistant", "assistant", "AI", "Bot"
- "EJA", "jmartin", "the user", "the assistant"
- "The conversation", "This session", "The transcript"

GOOD subjects: "agenr extraction pipeline", "Tailscale SSH setup", "end-of-day briefing workflow", "Jim Martin" (ONLY for biographical facts ABOUT Jim), "OpenClaw gateway"

If you can't name a specific topic, the entry isn't worth extracting.

## Anti-Patterns — DO NOT EXTRACT

1. **Assistant narration:** "The assistant decided to...", "EJA ran the command..." — process, not knowledge.
2. **Session-ephemeral instructions:** "Read this file", "Run this command", "Check the logs"
3. **Completed tasks as todos:** If done in this session, it's a fact or event, not a todo.
4. **Incremental debugging:** "Tried X, didn't work, tried Y" — extract the solution or lesson, not the journey.
5. **Code-level details:** "Function expandInputFiles uses expandGlobRecursive" — stale with every commit. Exception: architecture decisions.
6. **One workflow split into N entries:** Merge into ONE entry describing the whole workflow.
7. **Greetings, acknowledgments, small talk.**

## Examples of GOOD Extractions

{
  "type": "fact",
  "subject": "agenr knowledge database",
  "content": "agenr stores knowledge in SQLite with sqlite-vec for vector search. Embeddings use OpenAI text-embedding-3-small at 512 dimensions.",
  "importance": 8,
  "expiry": "temporary",
  "tags": ["agenr", "database", "embeddings"],
  "source_context": "User described the agenr database architecture"
}

{
  "type": "preference",
  "subject": "coding workflow preferences",
  "content": "Prefers writing detailed specs before any coding begins. Wants to understand the full design before implementation.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["workflow", "coding"],
  "source_context": "User explained preferred development process"
}

## Examples of BAD Extractions (DO NOT produce these)

BAD: { "subject": "User", "content": "The user asked the assistant to check the logs" }
WHY: Subject is actor, content is meta-narration, importance ~2

BAD: { "type": "todo", "subject": "user", "content": "Run codex from ~/Code/agenr" }
WHY: Session instruction, not persistent task. Subject is actor.

BAD: Five separate entries for steps 1-5 of one workflow.
WHY: Merge into one entry describing the full workflow.

## Output Rules

- Call submit_knowledge with extracted entries.
- If nothing is worth remembering, call submit_knowledge with an EMPTY entries array. This is expected and correct — most chunks are routine.
- Target: 0-8 entries per chunk. More than 8 means you're not selective enough.
- Each entry must be self-contained and understandable without the transcript.
- Content: clear declarative statement, not a quote.
- source_context: one sentence, max 20 words.

## Expiry

- **permanent:** Biographical facts, preferences, lessons, architecture decisions
- **temporary:** Current project state, active work, recent events
- Do NOT use "session-only" — if it only matters now, don't extract it.
```

---

## Schema Changes Required

1. **Add `importance: Integer(1-10)`**, remove `confidence`
2. **Remove `session-only` from expiry** enum
3. **Add subject blocklist** in validation (post-extraction safety net)
4. **Add `importance < 5` rejection** in validation
5. **DB migration:** `ALTER TABLE entries ADD COLUMN importance INTEGER DEFAULT 5`

No type changes. No new fields. No two-pass. Ship it.
