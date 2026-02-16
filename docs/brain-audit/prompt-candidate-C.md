# Prompt Candidate C — Radical Rethink

**Author:** Subagent prompt-writer-C  
**Date:** 2026-02-15  
**Philosophy:** Extract less, extract better. Rethink the type system. Kill confidence. Add importance with brutal calibration.

---

## Rationale: Why Radical?

The current system extracts 50-150 entries per session, 73% of which are noise. The other candidates will try to fix this by adding rules to the existing 7-type system. I'm arguing the 7-type system itself is part of the problem — it gives the LLM too many buckets to fill, encouraging over-extraction.

### Key Changes From Current System

1. **4 types instead of 7.** Merge `relationship` into `fact`. Merge `event` and `decision` into `event` (decisions are events). Keep `preference`, `lesson`, `task` (renamed from `todo`).
2. **Kill `confidence`.** It's useless (96.5% "high"). Replace with `importance` (1-10) with aggressive calibration examples.
3. **Kill `session-only` expiry.** If it's session-only, don't extract it. Period.
4. **Two-pass extraction model.** First: "What are the 3-5 KEY TOPICS discussed?" Then: "Extract entries for each topic." This prevents the LLM from narrating the conversation linearly.
5. **Temporal marker field.** Optional `as_of` date so we know when a fact was true.
6. **Explicit NOOP.** Empty array is valid and expected for low-signal conversations.

---

## Schema Changes

```typescript
// NEW schema
const KnowledgeEntrySchema = Type.Object({
  type: Type.Union([
    Type.Literal("fact"),        // Verifiable info: biographical, technical, configs, relationships, states
    Type.Literal("preference"),  // What someone wants, likes, dislikes, how they want things done
    Type.Literal("task"),        // Genuine persistent action items (NOT session instructions)
    Type.Literal("lesson"),      // Insights, principles, things learned from experience
    Type.Literal("event"),       // Things that happened, decisions made, milestones reached
  ]),
  subject: Type.String({ minLength: 3 }),  // Topic, not actor. Min 3 chars kills "Jim" as subject.
  content: Type.String({ minLength: 20 }), // Forces substantive content
  importance: Type.Number({ minimum: 1, maximum: 10 }),
  expiry: Type.Union([
    Type.Literal("permanent"),   // Identity, deep preferences, biographical
    Type.Literal("temporary"),   // Current projects, recent states (decays in weeks/months)
  ]),
  as_of: Type.Optional(Type.String()),  // ISO date — when was this true? null = timeless
  tags: Type.Array(Type.String()),
  source_context: Type.String(),
});
```

### Type Consolidation Rationale

| Old Type | New Type | Why |
|----------|----------|-----|
| `fact` | `fact` | Kept — broadened to include relationships |
| `relationship` | `fact` | "Jim works at Acme" is a fact. The relationship is implicit in the content. Separate type just encouraged low-value entries like "User and Assistant discussed X." |
| `decision` | `event` | A decision is an event that happened. "Decided to use PostgreSQL" = event with decision context in content. |
| `event` | `event` | Kept |
| `preference` | `preference` | Kept |
| `todo` | `task` | Renamed. "Todo" encouraged extracting session instructions as tasks. |
| `lesson` | `lesson` | Kept |

---

## The Prompt

```
You are a selective knowledge extractor. You read conversation transcripts and extract ONLY the knowledge worth remembering long-term. Most conversations are 80% process and 20% substance — your job is to find the 20%.

## What You Extract

FACT — Concrete, verifiable information about people, places, things, systems, relationships, configurations, or concepts. This includes biographical details, technical specs, who-works-where, how-things-connect.

PREFERENCE — Stated or strongly implied preferences about how someone wants things done, what they like/dislike, communication style, tool choices.

TASK — Genuine persistent action items that need to happen AFTER this conversation. NOT instructions given to the assistant during the conversation. If it was discussed AND completed in the same session, it's an EVENT, not a task.

LESSON — Insights, principles, or learnings derived from experience. "We learned that X causes Y" or "Never do X because Y."

EVENT — Something that happened: a decision was made, a milestone was reached, a system was deployed, a project was started/completed. Include the significance.

## Importance Scale (1-10) — READ CAREFULLY

This is the most critical field. Calibrate against these examples:

- **10:** "Jim's mother's name is Maria" / "The company was acquired for $2B" / "User is allergic to penicillin"
- **9:** "Decided to rewrite the auth system from OAuth to passkeys" / "User's core workflow: specs → code → test → deploy"
- **8:** "The agenr project uses SQLite with vector extensions" / "User prefers TypeScript over Python for all new projects"
- **7:** "Switched from gpt-4 to claude-opus for extraction" / "Team decided to ship weekly instead of biweekly"
- **6:** "The API endpoint is /v2/knowledge/recall" / "Project uses pnpm instead of npm"
- **5:** "Ran into a CORS issue with the staging server" / "Meeting with design team scheduled for Friday"
- **4:** "Tried three different regex patterns before finding one that worked" / "The build takes 45 seconds"
- **3:** "Discussed whether to use tabs or spaces" / "Restarted the dev server"
- **2:** "Asked the assistant to read a file" / "Looked up documentation"
- **1:** "The assistant acknowledged a request" / "Greeted each other"

**ONLY EXTRACT entries with importance ≥ 5.** Entries 1-4 are noise. If you find yourself assigning 4 or below, DON'T INCLUDE IT.

**Distribution check:** In a typical productive conversation, expect roughly: one or two 8-10s, a few 6-7s, and some 5s. If you're assigning 8+ to more than 30% of entries, you're inflating. Recalibrate.

## Subject Field — CRITICAL RULES

The subject is the TOPIC, not the speaker. It should answer: "What is this knowledge ABOUT?"

NEVER use as subjects:
- "User", "user", "Human", "human", "Assistant", "assistant", "AI", "Bot"
- "EJA", "jmartin" (these are actor identifiers, not topics)
- "The conversation", "This session", "The transcript"

GOOD subjects: "agenr extraction pipeline", "Tailscale SSH setup", "end-of-day briefing workflow", "Jim Martin" (ONLY for biographical facts ABOUT Jim), "OpenClaw gateway"

If you can't name a specific topic for an entry, the entry probably isn't worth extracting.

## What You Do NOT Extract

- **Meta-narration:** "The assistant was asked to...", "User instructed the AI to...", "The conversation covered..."
- **Session-ephemeral instructions:** "Read this file", "Run this command", "Check the logs" — these are process, not knowledge
- **Completed tasks extracted as tasks:** If it was done in this session, it's either a fact (the result) or an event (it happened), not a task
- **Incremental debugging steps:** "Tried X, didn't work, tried Y" — extract only the final solution or lesson, not the journey
- **Greetings, acknowledgments, small talk**
- **Anything you'd rate importance < 5**

## How to Extract

1. Read the entire transcript
2. Identify the 3-7 KEY TOPICS discussed (not every sentence — the themes)
3. For each topic, extract 1-3 entries that capture the essential knowledge
4. Verify each entry: Is the subject a topic (not an actor)? Is importance ≥ 5? Is it self-contained? Would someone benefit from knowing this in 2 weeks?
5. Call submit_knowledge with your entries

**Target: 5-25 entries per session.** If you have more than 25, you're extracting too granularly — merge related entries. If you have 0, that's fine — not every conversation produces lasting knowledge. Call submit_knowledge with an empty entries array.

## Field Rules

- **type:** Exactly one of: fact, preference, task, lesson, event
- **subject:** The topic (3+ chars). See rules above.
- **content:** Clear, declarative, self-contained statement (20+ chars). Must be understandable without the transcript.
- **importance:** 1-10 integer. Only include entries ≥ 5. See calibration above.
- **expiry:** "permanent" (identity, preferences, biographical, timeless facts) or "temporary" (current project state, recent decisions, active tasks)
- **as_of:** Optional ISO date (YYYY-MM-DD). Use when the fact is time-bound: current versions, project states, team compositions. Omit for timeless facts.
- **tags:** 1-4 lowercase descriptive tags
- **source_context:** One sentence, max 20 words. WHERE in the conversation this came from. Do NOT quote the transcript.
```

---

## Few-Shot Examples

Include these in the prompt (after the rules section) for calibration:

```
## Examples of GOOD Extractions

From a conversation about setting up a new project:

{
  "type": "fact",
  "subject": "agenr knowledge database",
  "content": "agenr stores knowledge entries in SQLite with sqlite-vec extension for vector similarity search. Embeddings use OpenAI text-embedding-3-small at 512 dimensions.",
  "importance": 8,
  "expiry": "temporary",
  "as_of": "2026-02",
  "tags": ["agenr", "database", "embeddings"],
  "source_context": "User described the agenr database architecture"
}

{
  "type": "preference",
  "subject": "coding workflow preferences",
  "content": "Prefers writing detailed specs/prompts before any coding begins. Wants to understand the full design before implementation starts.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["workflow", "coding", "preferences"],
  "source_context": "User explained their preferred development process"
}

{
  "type": "event",
  "subject": "agenr extraction pipeline",
  "content": "Decided to rewrite the extraction prompt after audit revealed 73% of extracted entries were noise. Key issues: bad subjects, meta-narration, no importance scoring.",
  "importance": 7,
  "expiry": "temporary",
  "as_of": "2026-02-15",
  "tags": ["agenr", "extraction", "quality"],
  "source_context": "Discussion of brain audit findings and next steps"
}

## Examples of BAD Extractions (DO NOT produce these)

BAD: { "subject": "User", "content": "The user asked the assistant to check the logs" }
WHY: Subject is actor, content is meta-narration, importance ~2

BAD: { "subject": "Assistant", "content": "Was instructed to run the extraction pipeline on session transcripts" }
WHY: Subject is actor, content describes what assistant was told to do

BAD: { "type": "todo", "subject": "user", "content": "Run codex from ~/Code/agenr" }
WHY: Session instruction, not persistent task. Subject is actor.

BAD: { "subject": "end-of-day workflow", "content": "Step 1: Check Gmail" }
  + { "subject": "end-of-day workflow", "content": "Step 2: Check Drive" }
  + { "subject": "end-of-day workflow", "content": "Step 3: Summarize" }
WHY: One workflow split into N entries. Merge into one entry describing the full workflow.
```

---

## Implementation Notes

### Backward Compatibility

The 5-type system needs a migration strategy for existing 7-type entries:
- `relationship` → `fact` (content already contains the relationship info)
- `decision` → `event` (add "Decided:" prefix to content if not already there)
- `todo` → `task` (just rename)

SQL: 
```sql
UPDATE entries SET type = 'fact' WHERE type = 'relationship';
UPDATE entries SET type = 'event' WHERE type = 'decision';
UPDATE entries SET type = 'task' WHERE type = 'todo';
```

### Confidence → Importance Migration

For existing entries without importance:
- `confidence: "high"` + `expiry: "permanent"` → importance 7
- `confidence: "high"` + `expiry: "temporary"` → importance 5
- `confidence: "medium"` → importance 4
- `confidence: "low"` → importance 3
- Then run a batch LLM pass to refine (or just accept the rough mapping)

### The Two-Pass Question

I mentioned two-pass extraction (topics first, then entries) in the rationale. This is optional but powerful. The current single-pass approach causes the LLM to narrate linearly through the transcript, extracting as it goes. A two-pass approach would:

1. **Pass 1:** "What are the 3-7 key topics in this transcript?" (returns topic list)
2. **Pass 2:** "For each topic, extract 1-3 knowledge entries." (returns entries)

This doubles LLM cost but dramatically improves subject quality and reduces volume. **Recommendation:** Try single-pass with this prompt first. If subjects are still bad, add the two-pass approach.

### Skip Mechanism

The prompt explicitly allows empty arrays. The code needs one guard:

```typescript
// In extractChunkOnce or extractToolCallEntries:
if (args.entries.length === 0) {
  // Valid NOOP — conversation had no extractable knowledge
  return { entries: [], warnings: [] };
}
```

---

## What Makes This Candidate Different

| Aspect | Current | Conservative Fix | This Proposal |
|--------|---------|-----------------|---------------|
| Types | 7 | 7 (with better rules) | 5 (merged) |
| Confidence | 3-level (useless) | Kept + importance added | Killed, replaced by importance |
| Importance | None | Added (1-10) | Added (1-10) with aggressive calibration + floor at 5 |
| Session-only | Extracted then stored | Filtered at store | Never extracted |
| Subject rules | Vague | Blocklist added | Blocklist + min-length + anti-pattern examples |
| Volume target | Unlimited (50-150 actual) | 10-30 | 5-25 with merge guidance |
| NOOP | Not possible | Empty array allowed | Explicitly encouraged |
| Temporal | None | None | Optional `as_of` field |
| Few-shot | None | Maybe | Yes, good AND bad examples |

---

## Risk Assessment

**Risk: LLM still inflates importance.** Mitigation: the calibration examples are very specific, and the hard floor at 5 means even inflated scores (5-7 instead of 3-5) produce usable entries. Post-extraction validation can also reject entries where `importance < 5`.

**Risk: 5 types loses information.** Mitigation: the content field carries the nuance. "Decided to use PostgreSQL" as an `event` is just as searchable as a `decision` type. The type is a hint, not a query filter.

**Risk: `as_of` field is ignored by LLM.** Mitigation: it's optional. If the LLM doesn't fill it, no harm. If it does, free temporal context.

**Risk: Breaking existing code that switches on 7 types.** Mitigation: type aliases in the codebase already handle plural/singular. Add `decision → event`, `relationship → fact`, `todo → task` aliases. No breakage.
