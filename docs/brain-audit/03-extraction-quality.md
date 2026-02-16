# 03 — Extraction Quality Audit

**Date:** 2026-02-15  
**DB:** `~/.agenr/knowledge.db` — 12,415 entries (6403 fact, 2215 event, 1473 todo, 1313 decision, 490 preference, 289 relationship, 232 lesson)

---

## 1. Problem Summary

The extraction pipeline produces structurally valid but semantically bad entries. Three categories:

1. **Wrong subjects** — "User", "user", "Assistant", "assistant", "EJA", "jmartin" used as subjects when the subject should be the *topic* discussed
2. **Massive duplication** — "End-of-day recap workflow" appears 6+ times with near-identical content; "User" has 123 entries, "Jim Martin" 92, "user" 75
3. **Meta-entries** — entries about what the assistant *did* rather than knowledge worth remembering (e.g., "The assistant was instructed to execute an end-of-day recap workflow")

## 2. Root Causes

### 2.1 System Prompt Doesn't Define "Subject" Well Enough

The prompt says:
> "For the subject field, use the most specific identifier (name, project name, etc.)"

This is too vague. The LLM interprets "identifier" as the speaker/actor. When a conversation says "Jim asked EJA to set up agenr", the LLM creates `subject: "Jim"` or `subject: "EJA"` instead of `subject: "agenr setup"`.

**Location:** `src/extractor.ts`, `SYSTEM_PROMPT` constant.

### 2.2 No Subject Blocklist/Validation

The `validateKnowledgeEntry()` function (extractor.ts) and `normalizeEntry()` function (store.ts) check that subject is non-empty but nothing else. No filtering of:
- Generic actor names: "user", "assistant", "User", "Assistant"
- Speaker identifiers: "EJA", "jmartin"
- Vague subjects: "the conversation", "the transcript"

### 2.3 No Content Quality Filter

No minimum content length, no check for self-referential content ("The assistant was instructed to..."), no dedup at extraction time. The store layer has semantic dedup (cosine similarity thresholds at 0.98/0.92/0.80) but:
- Entries with the same *topic* but slightly different *wording* slip through (e.g., 6 "End-of-day recap workflow" entries with similarity < 0.98)
- The 0.98 auto-skip threshold is too high for catching paraphrased duplicates

### 2.4 No Extraction-Time Dedup Within a Batch

`extractKnowledgeFromChunks()` accumulates entries across chunks with no dedup. If the same workflow instruction appears in multiple transcript chunks (common for multi-session ingestion), identical entries multiply.

### 2.5 Todos About the Assistant Itself

Many entries are `todo` type with subject "User" or "Assistant" describing things the assistant was asked to do *in that session* — not persistent action items. Example:
```
todo | User | Run codex from ~/Code/agenr with docs/prompts/v0.3-ingest/ingest-command.md when ready.
todo | Assistant | Research the Codex App when possible.
```

These are session-ephemeral instructions, not real todos.

## 3. Evidence from DB

### Top Subjects (showing the problem)
| Subject | Count |
|---------|-------|
| User | 123 |
| Jim Martin | 92 |
| user | 75 |
| Jim | 73 |
| agenr | 70 |
| Assistant | 50 |
| jmartin | 32 |
| assistant | 30 |
| EJA | 16 |

"User" + "user" = 198 entries. "Assistant" + "assistant" = 80 entries. These are almost all garbage — the subject should be the *topic*, not the speaker.

### Duplicate Content Example
"End-of-day recap workflow" appears with these near-identical contents:
- "Check Gmail label Work/Emails for the last day..."
- "List files in Google Drive folder 'Plaud Inbox'..."
- "Find all meeting summaries from today..."
- "Analyze meetings and emails together..."
- "Write the end-of-day briefing to..."

These are 5 steps of one workflow extracted as 5 separate entries, then duplicated across multiple sessions.

## 4. Recommendations

### 4.1 Subject Blocklist (Quick Win)

Add to `validateKnowledgeEntry()` and/or `normalizeEntry()`:

```typescript
const BLOCKED_SUBJECTS = new Set([
  "user", "assistant", "the user", "the assistant",
  "human", "ai", "bot", "system",
]);

function isBlockedSubject(subject: string): boolean {
  return BLOCKED_SUBJECTS.has(subject.toLowerCase().trim());
}
```

Drop entries with blocked subjects, or better: log a warning and skip them.

### 4.2 Improve System Prompt Subject Guidance

Replace:
> "For the subject field, use the most specific identifier (name, project name, etc.)"

With:
> "For the subject field, use the TOPIC being discussed — a project name, tool name, concept, or specific thing. NEVER use speaker roles ('user', 'assistant') or person names as subjects unless the entry is biographical information ABOUT that person. Bad: 'User', 'Assistant', 'EJA'. Good: 'agenr CLI', 'end-of-day briefing workflow', 'Tailscale SSH setup'."

### 4.3 Add Anti-Patterns to System Prompt

Add to rules:
```
- Do NOT extract instructions the assistant was given as "todo" entries. Only extract genuine persistent action items.
- Do NOT create entries about what the assistant did or was told to do. Extract the KNOWLEDGE discussed, not the meta-conversation.
- Merge related steps of a single workflow into ONE entry, not separate entries per step.
- If something was discussed AND completed in the same conversation, mark it as a "fact" or "event", NOT a "todo".
```

### 4.4 Post-Extraction Subject Normalization

Add a normalization pass after extraction:
- Merge "Jim Martin", "Jim", "jmartin" → canonical "Jim Martin" (for biographical facts only)
- Map "User"/"user" entries → try to infer actual topic from content field
- Lowercase normalize to catch "Assistant" vs "assistant"

### 4.5 Content Quality Filters

Add to validation:
```typescript
// Reject meta-entries about the conversation itself
const META_PATTERNS = [
  /^the (assistant|user) was (instructed|asked|told) to/i,
  /^(assistant|user) (mentioned|stated|said|discussed)/i,
  /^in the conversation/i,
];

// Reject entries with too-short content
if (content.length < 20) { skip; }

// Reject entries where content just restates the subject
if (content.toLowerCase().includes(subject.toLowerCase()) && content.length < subject.length * 2) { skip; }
```

### 4.6 Batch Dedup at Extraction Time

Before returning from `extractKnowledgeFromChunks()`, dedup by (subject, content) similarity. Simple approach: exact subject match + Jaccard similarity on content words > 0.7 → keep only the longest/best version.

### 4.7 Lower Auto-Skip Threshold

Consider lowering `AUTO_SKIP_THRESHOLD` from 0.98 to 0.95 in `src/db/store.ts`. The "End-of-day recap workflow" duplication shows that paraphrased duplicates are getting through at 0.98.

## 5. Priority Order

1. **Subject blocklist** — instant win, 5 min to implement, kills ~280 garbage entries
2. **System prompt improvements** — biggest long-term impact on extraction quality
3. **Anti-pattern rules in prompt** — stops meta-entries and instruction-as-todo problem
4. **Content quality filters** — catches what the prompt misses
5. **Batch dedup** — prevents within-ingestion duplication
6. **Lower auto-skip threshold** — reduces cross-ingestion duplication
7. **Subject normalization** — cleanup pass for consistency
