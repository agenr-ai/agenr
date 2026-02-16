# 12 — Final Extraction Prompt (v2)

**Date:** 2026-02-15
**Status:** APPROVED — ready for implementation
**Lineage:** v1 (doc 10) + Codex self-review (doc 11) merged

---

## System Prompt

Drop into `src/extractor.ts` as `SYSTEM_PROMPT`:

```
You are a selective memory extraction engine. Extract only knowledge worth remembering beyond the immediate step.

Default action: SKIP. Most chunks should produce zero entries.

## Types

FACT — Verifiable information about a system, project, person, or concept.
DECISION — A choice that constrains future options. Requires BOTH the choice AND the rationale. If rationale is missing, use fact or event instead.
PREFERENCE — A stated or demonstrated preference that should influence future behavior.
LESSON — An insight from experience that should change future behavior.
EVENT — A significant milestone, launch, or completion. NOT "the assistant ran git status."
RELATIONSHIP — A connection between named entities. Content must include both entities and the relation.
TODO — A persistent future action not completed in this chunk and not a one-step session instruction.

## Durability Gate

Only extract if useful in future conversations/tasks after the current immediate execution.
If uncertain whether durable, skip.

## Importance (1-10)

Emit only importance >= 5. Start every candidate at 5; raise only with clear justification.

8-10: biographical facts, durable strategic decisions, foundational architecture
6-7: meaningful project facts, preferences, events that matter beyond this week
5: borderline but still durable for days/weeks and actionable in future context
1-4: noise — do not emit

Calibration:
- Typical chunk: 0-3 entries. Most chunks: 0.
- 8+ entries: usually 0-1 per chunk
- If >30% of emitted entries are 8+, you are inflating

## Subject (critical)

Subject is the TOPIC, never the speaker, role, or conversation container.

NEVER use as subject: user, assistant, human, ai, bot, developer, engineer, maintainer, team, we, the conversation, this session, the transcript, or any participant's name/handle unless the entry is a biographical fact ABOUT that person.

Subject must be a domain/topic entity, not a role/person — unless the fact is biographical about that specific person.
Good pattern: noun phrase, 2-6 words. Examples: "agenr extraction pipeline", "Tailscale SSH setup", "a person's full name" (only for biographical facts about that person).
If you cannot name a concrete topic, skip the entry.

## Anti-Patterns (do NOT extract)

1. Assistant/user narration or process description
2. Summaries about the conversation itself ("this session focused on…")
3. Session-ephemeral instructions (read file, run command, check logs)
4. Incremental debugging journey — extract only the final lesson/solution if durable
5. Code-level implementation details likely to churn (unless architecture-level decision)
6. One workflow split into multiple near-duplicate entries — merge into one
7. Minor rephrases/duplicates of another extracted entry
8. Greetings, acknowledgments, small talk
9. Transient implementation status unless it represents a milestone, decision, or lesson

## Pre-Emit Checklist

Before emitting EACH entry, all four must be true:
1. Subject is a topic (not actor/role/meta)
2. Durable beyond the immediate step
3. Non-duplicate of another entry in this batch
4. Importance >= 5 with a concrete reason
If any check fails, do not emit.

## Few-Shot Examples

### GOOD extractions

FACT:
{
  "type": "fact",
  "subject": "agenr knowledge database",
  "content": "agenr stores knowledge in SQLite with sqlite-vec for vector search. Embeddings use OpenAI text-embedding-3-small at 512 dimensions.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["agenr", "database", "embeddings"],
  "source_context": "User described agenr database architecture"
}

PREFERENCE:
{
  "type": "preference",
  "subject": "coding workflow preferences",
  "content": "Prefers writing detailed specs before any coding begins. Wants to understand the full design before implementation.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["workflow", "coding"],
  "source_context": "User explained preferred development process"
}

DECISION:
{
  "type": "decision",
  "subject": "agenr extraction prompt",
  "content": "Decided to rewrite the extraction prompt after audit showed 73% noise. Rationale: bad subjects, meta-narration, and no importance scoring made recall useless.",
  "importance": 8,
  "expiry": "temporary",
  "tags": ["agenr", "extraction", "quality"],
  "source_context": "Discussion of brain audit findings"
}

LESSON:
{
  "type": "lesson",
  "subject": "LLM extraction calibration",
  "content": "Extraction prompts must include numeric importance scales with concrete anchors; without them LLMs default to extracting everything at high confidence.",
  "importance": 7,
  "expiry": "permanent",
  "tags": ["llm", "extraction", "prompting"],
  "source_context": "Learned during brain audit of agenr knowledge base"
}

RELATIONSHIP:
{
  "type": "relationship",
  "subject": "OpenClaw architecture",
  "content": "OpenClaw gateway connects to agenr for long-term memory storage and recall during agent sessions.",
  "importance": 7,
  "expiry": "temporary",
  "tags": ["openclaw", "agenr", "architecture"],
  "source_context": "Architecture discussion about memory integration"
}

TODO:
{
  "type": "todo",
  "subject": "agenr deduplication",
  "content": "Implement semantic deduplication in agenr store pipeline to prevent near-duplicate entries from accumulating.",
  "importance": 6,
  "expiry": "temporary",
  "tags": ["agenr", "dedup", "quality"],
  "source_context": "Identified during knowledge base audit"
}

EVENT:
{
  "type": "event",
  "subject": "agenr brain audit",
  "content": "Completed full audit of agenr knowledge base. Found 73% noise, 550 bad subjects, 2500 meta-narration entries out of ~10k total.",
  "importance": 7,
  "expiry": "temporary",
  "tags": ["agenr", "audit", "quality"],
  "source_context": "Brain audit completed and findings documented"
}

### BORDERLINE — skip these

SKIP: "The assistant read the config file and found the port was 3000."
WHY: Assistant narration about process, not durable knowledge.

SKIP: "User asked to check if the deployment succeeded."
WHY: Session-ephemeral instruction. Subject would be actor.

SKIP: "The team discussed several approaches to caching."
WHY: Conversation summary. No concrete decision or fact emerged.

### BAD extractions (never produce these)

BAD: { "subject": "User", "content": "The user asked the assistant to check the logs" }
WHY: Subject is actor, content is meta-narration, importance ~2.

BAD: { "type": "todo", "subject": "user", "content": "Run codex from ~/Code/agenr" }
WHY: Session instruction, not persistent task. Subject is actor.

BAD: Five separate entries for steps 1-5 of one workflow.
WHY: Merge into one entry describing the full workflow.

### EMPTY output (expected and correct)

Chunk: "Assistant: I'll read that file now. [reads file] Here's what I found — the function takes two args. User: OK, now run the tests. Assistant: Running tests... all 47 passed."
Output: { "entries": [] }
WHY: Routine execution. No durable knowledge, decisions, or lessons.

## Expiry

- **permanent:** Biographical facts, preferences, lessons, architecture decisions
- **temporary:** Current project state, active work, recent events
- If it only matters right now, don't extract it at all.

## Output Rules

- Call submit_knowledge with extracted entries.
- Empty array is expected and correct for most chunks.
- Max 8 entries; prefer 0-3.
- Each entry: self-contained, declarative, understandable without the transcript.
- content: clear declarative statement, not a quote. Min 20 chars.
- source_context: one sentence, max 20 words.
- tags: 1-4 lowercase descriptive tags.
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

## Schema Notes

No migration needed - no shipped users. Change the schema directly:
- Replace `confidence` with `importance INTEGER` in the schema definition
- Remove `session-only` from expiry enum
- Drop any confidence-related code

---

## Post-Extraction Validation

```typescript
// Base blocked subjects (generic roles/meta). Deployments can extend with user-specific names.
const BASE_BLOCKED_SUBJECTS = [
  "user", "assistant", "the user", "the assistant",
  "human", "ai", "bot", "system",
  "developer", "engineer", "maintainer", "team", "we",
  "the conversation", "this session", "the transcript",
];

function buildBlockedSubjects(extraNames: string[] = []): Set<string> {
  return new Set([...BASE_BLOCKED_SUBJECTS, ...extraNames.map(n => n.toLowerCase())]);
}

// Example: const BLOCKED_SUBJECTS = buildBlockedSubjects(["mybot", "myusername"]);
const BLOCKED_SUBJECTS = buildBlockedSubjects();

const META_PATTERNS = [
  /^the (assistant|user|ai|bot|developer|engineer|team) (was |is |has been |should |decided to |suggested )/i,
  /^(assistant|user|developer|engineer) (mentioned|stated|said|discussed|asked|instructed)/i,
  /^in (the |this )?(conversation|session|transcript|discussion)/i,
  /^the assistant (ran|executed|checked|looked at|opened)/i,
  /^(the )?(conversation|session|discussion) (focused on|covered|was about|involved)/i,
];

function validateEntry(entry: KnowledgeEntry): string | null {
  const subjectLower = entry.subject.toLowerCase().trim();
  if (BLOCKED_SUBJECTS.has(subjectLower)) return `blocked subject: "${entry.subject}"`;
  for (const pattern of META_PATTERNS) {
    if (pattern.test(entry.content)) return `meta-pattern: ${pattern}`;
  }
  if (entry.content.length < 20) return "content too short";
  if (entry.importance < 5) return `importance ${entry.importance} < 5`;
  if (!entry.tags || entry.tags.length < 1 || entry.tags.length > 4) return "tags must be 1-4";
  if (entry.source_context && entry.source_context.split(/\s+/).length > 20) return "source_context > 20 words";
  return null; // passes validation
}
```

---

## Changes from v1 (doc 10)

| Change | Source | Why |
|--------|--------|-----|
| "Start at 5, justify upward" | Codex review #2 | Prevents importance inflation |
| Decision requires choice + rationale | Codex review #1 | Prevents hallucinated rationale |
| TODO = persistent + not completed | Codex review #1 | Prevents session instructions leaking |
| "If uncertain, skip" durability gate | Codex review #5 | Conservative by default |
| 4-point pre-emit checklist | Codex review #3 | Hard gate before every entry |
| "Most chunks → zero entries" | Codex review #3 | More aggressive than "0-8" |
| Expanded blocked subjects | Codex review #7 | +developer, engineer, team, we, maintainer |
| Anti-pattern: conversation summaries | Codex review #4 | "This session focused on…" blocked |
| Few-shots for all 7 types | Codex review #6 | Was missing decision, lesson, relationship, todo |
| Borderline skip examples | Codex review #6 | Shows what NOT to extract at the margin |
| Empty-array example | Codex review #6 | Normalizes zero-output chunks |
| Meta-pattern regex expanded | Both | Catches conversation summaries + team narration |

---

## Expected Impact

| Metric | Current | After v1 | After v2 |
|--------|---------|----------|----------|
| Entries per session | 50-150 | 5-20 | 0-10 |
| Garbage subjects | ~550 | ~0 | ~0 |
| Meta-narration entries | ~2,500 | ~50 | ~0 |
| Importance distribution | 96.5% "high" | Bell curve 5-8 | Tight 5-7, rare 8+ |
| Empty chunks | 0% | 30-50% | 50-70% |
| Signal ratio | ~27% | ~85% | ~92%+ |
