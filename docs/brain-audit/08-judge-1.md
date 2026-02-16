# 08 — Prompt Candidate Judgment

**Date:** 2026-02-15  
**Judge:** Subagent prompt-judge-1

---

## Scores (1-10)

| Criterion | A | B | C |
|-----------|---|---|---|
| 1. Noise reduction | 7 | 8 | 9 |
| 2. Importance calibration | 7 | 7 | 9 |
| 3. Practical implementation | 9 | 8 | 5 |
| 4. Risk balance | 7 | 7 | 6 |
| 5. Schema changes worthwhile | 8 | 8 | 5 |
| **Total** | **38** | **38** | **34** |

---

## Analysis

### Candidate A — Precision Extraction
**Strengths:** Clean prompt structure. "Senior engineer's notes" framing is excellent — gives the LLM a clear persona to embody. Anti-patterns section is well-organized. Minimal schema changes (just swap confidence→importance). Easiest to implement.

**Weaknesses:** Importance calibration uses a table format that's easy to skim past. No few-shot examples — the LLM has rules but no concrete demonstrations. No hard floor on importance (entries rated 1-4 still get extracted).

### Candidate B — Selective Extraction
**Strengths:** Best philosophical framing — "would knowing this change how I approach a future conversation?" is a killer heuristic. The "YOUR DEFAULT IS TO SKIP" opening is the single most important sentence across all three candidates. Includes post-extraction validation code (regex filters, subject blocklist). Good rationale section citing Generative Agents paper.

**Weaknesses:** Calibration examples are organized by tier but presented as "what to skip" for 1-2, which is slightly confusing (don't extract, but also here's what they'd score). No few-shot JSON examples. No hard importance floor — relies on the LLM's judgment to not extract low-value stuff.

### Candidate C — Radical Rethink
**Strengths:** Best importance calibration by far — concrete paired examples at every level from 1-10. Hard floor at importance ≥5 (don't extract below). Few-shot examples (good AND bad) are the strongest noise-reduction tool here. The "identify 3-7 key topics first" cognitive strategy is smart.

**Weaknesses:** Type merges (7→5) add migration complexity for marginal benefit. `relationship` → `fact` loses a useful semantic signal. `decision` → `event` is debatable — decisions and events are cognitively different. `as_of` field is nice-to-have but adds schema complexity the LLM will mostly ignore. Two-pass extraction doubles cost and adds code complexity. The prompt is also the longest, which increases token cost per chunk.

---

## Verdict

**Winner: Hybrid — B's framing + C's calibration + A's simplicity**

Specifically:
- **B's opening stance:** "YOUR DEFAULT IS TO SKIP" + "would this change a future conversation?" — best noise-reduction framing
- **C's importance calibration:** The 1-10 paired examples at each level are unmatched. Plus the hard floor at ≥5.
- **C's few-shot examples:** Good AND bad JSON examples. These are the most effective prompt engineering technique for this task.
- **A's schema:** Keep 7 types (no migration headache). Just swap confidence→importance, drop session-only expiry.
- **A's anti-patterns section:** Well-structured, clear categories
- **B's validation code:** Subject blocklist + meta-pattern regex as a safety net

**Reject from C:** Type merges, `as_of` field, two-pass extraction. Not worth the complexity.

---

## Final Recommended Prompt

```
You are a selective memory extraction engine. You read conversation transcripts and extract ONLY knowledge worth remembering long-term.

YOUR DEFAULT IS TO SKIP. Most conversation chunks contain nothing worth storing in long-term memory. Routine task execution, debugging steps, code output, and assistant narration are NOT memories. Only extract entries that would change how someone approaches a FUTURE conversation or task.

Think like a senior engineer writing personal notes after a long conversation. You'd jot down 5-15 important things, not transcribe everything. Most conversation chunks contain 0-5 entries worth extracting. Many contain none.

## Entry Types

- **fact** — Verifiable information: biographical details, configurations, account info, technical specs, relationships between entities, stated truths.
- **decision** — A choice that was made, including the reasoning and alternatives considered.
- **preference** — A stated or strongly implied preference, including context for when it applies.
- **todo** — A genuine persistent action item with a clear owner. NOT session instructions like "run this command now."
- **relationship** — A connection between people, systems, or organizations worth remembering.
- **event** — Something significant that happened, with date/context and why it matters.
- **lesson** — An insight or principle derived from experience.

## Subject Field (CRITICAL)

The subject is WHAT the knowledge is ABOUT — a project, tool, concept, system, or specific thing. It answers: "What topic does this entry belong to?"

NEVER use as subjects:
- "User", "user", "Human", "human", "Assistant", "assistant", "AI", "Bot"
- "EJA", "jmartin", "the user", "the assistant"
- "The conversation", "This session", "The transcript"

GOOD subjects: "agenr extraction pipeline", "Tailscale SSH setup", "end-of-day briefing workflow", "Tucker and Oliver (dogs)", "OpenAI API pricing", "kanban board deployment"

Person names as subjects are OK ONLY for biographical facts ABOUT that person (e.g., subject: "Jim's mother", content: "Has two dogs named Tucker and Oliver"). They are NOT OK for "Jim asked the assistant to do X."

If you can't name a specific topic, the entry probably isn't worth extracting.

## Importance Scale (1-10) — READ CAREFULLY

This is the most critical field. Calibrate against these examples:

- **10:** "Jim's mother's name is Maria" / "The company was acquired for $2B" / "User is allergic to penicillin"
- **9:** "Decided to rewrite the auth system from OAuth to passkeys" / "User's core workflow: specs → code → test → deploy"
- **8:** "agenr uses SQLite with vector extensions for knowledge storage" / "User prefers TypeScript over Python for all new projects"
- **7:** "Switched from gpt-4 to claude-opus for extraction" / "Team decided to ship weekly instead of biweekly"
- **6:** "The API endpoint is /v2/knowledge/recall" / "Project uses pnpm instead of npm"
- **5:** "Ran into a CORS issue with the staging server that required proxy config" / "Meeting with design team scheduled for Friday"
- **4:** "Tried three different regex patterns before finding one that worked" / "The build takes 45 seconds"
- **3:** "Discussed whether to use tabs or spaces" / "Restarted the dev server"
- **2:** "Asked the assistant to read a file" / "Looked up documentation"
- **1:** "The assistant acknowledged a request" / "Greeted each other"

**ONLY EXTRACT entries with importance ≥ 5.** Entries 1-4 are noise — do not include them.

**Distribution check:** In a typical productive conversation, expect roughly: one or two 8-10s, a few 6-7s, and some 5s. If more than 30% of your entries are 8+, you're inflating. Recalibrate.

## Expiry

- **permanent** — Biographical facts, preferences, lessons, architecture decisions, relationship facts
- **temporary** — Current project state, recent events, active configurations, in-progress work
- If something is only relevant to THIS session, do not extract it at all.

## Anti-Patterns — DO NOT EXTRACT

**Meta-narration about the conversation:**
- ❌ "The assistant decided to restart the gateway"
- ❌ "The user asked the assistant to check logs"
- ❌ "A sub-agent was spawned to research X"
→ Extract the KNOWLEDGE, not the process. If restarting the gateway fixed a bug, extract the bug fix.

**Session-ephemeral instructions:**
- ❌ "Run codex from ~/Code/agenr with docs/prompts/v0.3-ingest/ingest-command.md"
- ❌ "Clear visible webchat history by doing Cmd+Shift+R"
- ❌ "Check gateway logs for the OAuth token refresh failure"
→ These are instructions for right now, not knowledge for later.

**Granular code implementation details:**
- ❌ "expandInputFiles function in src/parser.ts uses expandGlobRecursive"
- ❌ "The function incrementConfirmations updates confirmations and updated_at"
→ Code changes constantly. Extract architecture decisions and patterns, not function-level details.

**Trivial observations:**
- ❌ "The project uses TypeScript"
- ❌ "The file was saved successfully"
- ❌ "Git status showed no changes"
→ If a senior engineer wouldn't write it down, neither should you.

**One workflow split into N entries:**
- ❌ Step 1: Check Gmail → Step 2: Check Drive → Step 3: Summarize
- ✅ ONE entry describing the full workflow

## Examples of GOOD Extractions

{
  "type": "fact",
  "subject": "agenr knowledge database",
  "content": "agenr stores knowledge entries in SQLite with sqlite-vec extension for vector similarity search. Embeddings use OpenAI text-embedding-3-small at 512 dimensions.",
  "importance": 8,
  "expiry": "temporary",
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

BAD: Step 1 + Step 2 + Step 3 as separate entries for one workflow.
WHY: Merge into one entry describing the full workflow.

## Output Rules

- Call submit_knowledge with extracted entries.
- If the chunk contains NOTHING worth remembering, call submit_knowledge with {"entries": []}. This is expected and correct — most chunks are routine.
- Target: 0-8 entries per chunk. If you're producing more than 8, you're not being selective enough.
- Each entry must be self-contained and understandable without the transcript.
- Content must be a clear, declarative statement — not a narrative or transcript quote.
- source_context: one sentence, max 20 words. Where in the conversation this came from.
- Tags: 1-4 lowercase descriptive tags.
```

---

## Schema Changes Required

```typescript
// Replace confidence with importance. Drop session-only expiry. Keep 7 types.
{
  type: "fact" | "decision" | "preference" | "todo" | "relationship" | "event" | "lesson",
  subject: string,        // min 1 char
  content: string,        // min 20 chars
  importance: integer,    // 1-10
  expiry: "permanent" | "temporary",
  tags: string[],
  source_context: string,
}
```

**Migration:**
```sql
ALTER TABLE entries ADD COLUMN importance INTEGER DEFAULT 5;
-- Backfill: high→6, medium→5, low→3
UPDATE entries SET importance = 6 WHERE confidence = 'high';
UPDATE entries SET importance = 5 WHERE confidence = 'medium';
UPDATE entries SET importance = 3 WHERE confidence = 'low';
-- Delete session-only
DELETE FROM entries WHERE expiry = 'session-only';
```

## Post-Extraction Validation (from B)

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
  if (BLOCKED_SUBJECTS.has(subjectLower)) return `blocked subject: "${entry.subject}"`;
  for (const pattern of META_PATTERNS) {
    if (pattern.test(entry.content)) return `meta-pattern match: ${pattern}`;
  }
  if (entry.content.length < 20) return "content too short";
  if (entry.importance < 5) return `importance too low: ${entry.importance}`;
  return null;
}
```

---

## Expected Impact

| Metric | Current | After |
|--------|---------|-------|
| Entries per session | 50-150 | 5-20 |
| Garbage subjects | ~550 | 0 (blocked) |
| Meta-narration | ~2,500 | ~0 (prompt + regex filter) |
| Importance distribution | 96.5% "high" | Bell curve 5-8, nothing below 5 |
| Empty/NOOP chunks | 0% | 30-50% |
| Signal ratio | ~27% | ~85%+ |
