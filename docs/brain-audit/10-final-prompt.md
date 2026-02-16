# 10 — Final Extraction Prompt

**Date:** 2026-02-15  
**Status:** APPROVED — ready for implementation

---

## System Prompt

Drop into `src/extractor.ts` as `SYSTEM_PROMPT`:

```
You are a selective memory extraction engine. You read conversation transcripts and extract ONLY knowledge worth remembering long-term.

YOUR DEFAULT IS TO SKIP. Most conversation chunks contain nothing worth storing in long-term memory. Routine task execution, debugging steps, code output, and assistant narration are NOT memories. Only extract entries that would change how someone approaches a FUTURE conversation or task.

## What to Extract

FACT — Verifiable information about a person, system, project, or concept useful in a future context.

DECISION — A choice that sets direction and constrains future options. Must include the WHY, not just the WHAT.

PREFERENCE — A stated or strongly demonstrated preference that should influence future behavior.

LESSON — An insight derived from experience that should change future behavior.

EVENT — A significant occurrence worth referencing later. Milestones, launches, completions. NOT "the assistant ran git status."

RELATIONSHIP — A connection between entities worth knowing.

TODO — A genuine persistent action item that outlives this conversation. NOT session-ephemeral instructions like "run this command" or "check this log."

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

{
  "type": "event",
  "subject": "agenr extraction pipeline",
  "content": "Decided to rewrite the extraction prompt after audit revealed 73% of extracted entries were noise. Key issues: bad subjects, meta-narration, no importance scoring.",
  "importance": 7,
  "expiry": "temporary",
  "tags": ["agenr", "extraction", "quality"],
  "source_context": "Discussion of brain audit findings and next steps"
}

## Examples of BAD Extractions (DO NOT produce these)

BAD: { "subject": "User", "content": "The user asked the assistant to check the logs" }
WHY: Subject is actor, content is meta-narration, importance ~2

BAD: { "type": "todo", "subject": "user", "content": "Run codex from ~/Code/agenr" }
WHY: Session instruction, not persistent task. Subject is actor.

BAD: Five separate entries for steps 1-5 of one workflow.
WHY: Merge into one entry describing the full workflow.

## Expiry

- **permanent:** Biographical facts, preferences, lessons, architecture decisions
- **temporary:** Current project state, active work, recent events
- Do NOT use "session-only" — if it only matters now, don't extract it.

## Output Rules

- Call submit_knowledge with extracted entries.
- If nothing is worth remembering, call submit_knowledge with an EMPTY entries array. This is expected and correct — most chunks are routine.
- Target: 0-8 entries per chunk. More than 8 means you're not selective enough.
- Each entry must be self-contained and understandable without the transcript.
- Content: clear declarative statement, not a quote.
- source_context: one sentence, max 20 words.
- Tags: 1-4 lowercase descriptive tags.
```

---

## Schema

```typescript
interface KnowledgeEntry {
  type: "fact" | "decision" | "preference" | "todo" | "relationship" | "event" | "lesson";
  subject: string;       // min 1 char, topic not actor
  content: string;       // min 20 chars, declarative statement
  importance: number;    // integer 1-10, only >= 5 emitted
  expiry: "permanent" | "temporary";
  tags: string[];        // 1-4 lowercase tags
  source_context: string; // max 20 words
}
```

**Changes from current schema:**
- `confidence: "high" | "medium" | "low"` → `importance: integer(1-10)`
- `expiry: "session-only"` removed (don't extract session-only knowledge at all)
- Types unchanged (7 types preserved)

---

## Migration SQL

```sql
-- Add importance column
ALTER TABLE entries ADD COLUMN importance INTEGER DEFAULT 5;

-- Backfill from confidence
UPDATE entries SET importance = 6 WHERE confidence = 'high';
UPDATE entries SET importance = 5 WHERE confidence = 'medium';
UPDATE entries SET importance = 3 WHERE confidence = 'low';

-- Remove session-only entries
DELETE FROM entries WHERE expiry = 'session-only';

-- Optional: drop confidence column (SQLite doesn't support DROP COLUMN before 3.35)
-- If on SQLite >= 3.35:
-- ALTER TABLE entries DROP COLUMN confidence;
```

---

## Post-Extraction Validation

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

function validateEntry(entry: KnowledgeEntry): string | null {
  const subjectLower = entry.subject.toLowerCase().trim();
  if (BLOCKED_SUBJECTS.has(subjectLower)) return `blocked subject: "${entry.subject}"`;
  for (const pattern of META_PATTERNS) {
    if (pattern.test(entry.content)) return `meta-pattern: ${pattern}`;
  }
  if (entry.content.length < 20) return "content too short";
  if (entry.importance < 5) return `importance ${entry.importance} < 5`;
  return null; // passes validation
}
```

---

## Design Decisions

| Choice | Decision | Why |
|--------|----------|-----|
| Base prompt | Judge 2 (B+) | Tighter, fewer tokens, numbered anti-patterns |
| Third example | From Judge 1 | Event type needed representation |
| Tags line | From Judge 1 | "1-4 lowercase" constraint was missing in J2 |
| Validation code | From Judge 1 | Complete, ready to drop in |
| Migration SQL | From Judge 1 | Includes backfill logic |
| Type merging | Rejected | Both judges agreed: 7 types, no migration risk |
| `as_of` field | Rejected | LLM will hallucinate dates |
| Two-pass extraction | Rejected | Doubles cost, marginal quality gain |

---

## Expected Impact

| Metric | Current | After |
|--------|---------|-------|
| Entries per session | 50-150 | 5-20 |
| Garbage subjects | ~550 | 0 (blocked) |
| Meta-narration entries | ~2,500 | ~0 |
| Importance distribution | 96.5% "high" | Bell curve 5-8 |
| Empty chunks | 0% | 30-50% |
| Signal ratio | ~27% | ~85%+ |
