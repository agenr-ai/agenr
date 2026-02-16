# Brain Audit: Database Content Analysis

**Date:** 2026-02-15  
**Total entries:** 12,415  
**All created:** 2026-02-15 (single day — bulk ingest from ~106 session transcripts)

---

## 1. Distribution Overview

### By Type
| Type | Count | % |
|------|-------|---|
| fact | 6,403 | 51.6% |
| event | 2,215 | 17.8% |
| todo | 1,473 | 11.9% |
| decision | 1,313 | 10.6% |
| preference | 490 | 3.9% |
| relationship | 289 | 2.3% |
| lesson | 232 | 1.9% |

### By Confidence
| Confidence | Count | % |
|------------|-------|---|
| high | 11,979 | 96.5% |
| medium | 426 | 3.4% |
| low | 10 | 0.1% |

**Problem:** Almost everything is "high" confidence. The extraction LLM over-assigns confidence, making the field useless for ranking.

### By Expiry
| Expiry | Count | % |
|--------|-------|---|
| temporary | 9,103 | 73.3% |
| permanent | 2,209 | 17.8% |
| session-only | 1,102 | 8.9% |
| core | 1 | 0.0% |

**Problem:** 1,102 "session-only" entries still exist. These should have been pruned immediately after their session ended. Additionally, "temporary" has no actual expiry date — it's just a label with no TTL mechanism.

### Recall Usage
- **Never recalled:** 12,165 (98%)
- **Recalled 1+ times:** 250 (2%)
- **Max recall count:** 7

98% of entries have never been used. The DB is write-heavy with almost no read value.

---

## 2. Subject Quality — The Core Problem

The top subjects reveal the extraction model doesn't know *who* to attribute entries to:

| Subject | Count | Problem |
|---------|-------|---------|
| `User` | 123 | Generic — should be "Jim" or the specific topic |
| `Jim Martin` | 92 | Better, but still too broad |
| `user` | 75 | Same as "User" but lowercase (inconsistent) |
| `Jim` | 73 | Duplicate of "Jim Martin" |
| `agenr` | 70 | Meta/self-referential |
| `Assistant` | 50 | About the AI itself — not useful knowledge |
| `jmartin` | 32 | Username variant of Jim |
| `assistant` | 30 | Same as "Assistant" |

**~550 entries (4.4%) have the subject "User", "user", "Assistant", or "assistant"** — these are effectively unindexed. When you search for something about Jim's preferences, you get noise about "User prefers the assistant to handle X" mixed with "User's mother has two dogs."

Short subjects (≤3 chars): 101 entries — these are mostly "Jim" and "EJA" which are actually fine.

---

## 3. Noise Categories & Quantification

### Category A: Process Noise (~2,500 entries, ~20%)
Entries about what the assistant did during a session, not knowledge worth remembering.

**Examples:**
- `"The assistant decided to restart the gateway to force a fresh reload due to cached old session context."`
- `"The assistant should draft the technical architecture section, code examples, and the 'how it works' flow for the blog post."`
- `"Launch parallel research sub-agents before drafting the specification."`

**Pattern:** 655 entries start with "The assistant". 935 entries match assistant/sub-agent process language. These are session narration, not knowledge.

### Category B: Self-Referential / Meta (~3,379 entries, ~27%)
Entries about agenr itself — how it works, its code, its bugs, its development. This is the tool remembering how to build itself.

**Examples:**
- `"merge.ts defines EXPIRY_SET as {core, permanent, temporary, session-only}..."`
- `"consolidate command options: ConsolidateCommandOptions includes rulesOnly, dryRun, verbose, json, and db fields."`
- `"The extraction was made resilient to source format variants..."`

Some of these are useful for agenr development, but they dominate recall results for any query. When Jim asks "what did I decide about the API design?", he gets agenr implementation details instead.

### Category C: Stale Todos (~1,200 entries, ~10%)
Todos that were relevant during a session but are now meaningless:

- `"Check gateway logs for details of the OAuth token refresh failure"` (session-only, stale)
- `"Clear visible webchat history by doing a hard refresh (Cmd+Shift+R)"` (session-only, stale)
- `"User should delete the local untracked PLAN.md file"` (one-time action, done or irrelevant)

281 are explicitly `session-only` but weren't cleaned up. Many `temporary` todos are equally stale.

### Category D: Granular Code Facts (~2,000 entries, ~16%)
Facts about specific functions, files, and implementation details that are too granular to be useful in recall:

- `"expandInputFiles function in src/parser.ts uses a custom expandGlobRecursive to walk directories"`
- `"The function incrementConfirmations updated confirmations and updated_at but did not update content_hash"`
- `"square runtime dependency is present but not imported in server/SDK scoped source"`

These are essentially code comments stored as "knowledge." They go stale with every code change.

### Category E: Genuine Signal (~3,300 entries, ~27%)
Actual useful knowledge:

- **Personal facts:** `"The user's mother has two dogs named Tucker and Oliver."` ✅
- **Architecture decisions:** `"agenr is intended to give multiple AI coding tools a shared persistent memory"` ✅  
- **Workflow preferences:** `"Specs should be researched and iterated before coding rather than rushing to ship"` ✅
- **Lessons learned:** `"Dead CI is worse than no CI because it creates false confidence"` ✅
- **Project context:** `"Domino's has a well-known unofficial API at order.dominos.com/power/*"` ✅
- **Work events:** `"AI-assisted code review POC — engineering reported promising results"` ✅

---

## 4. Signal vs Noise Summary

| Category | Est. Count | % | Action |
|----------|-----------|---|--------|
| **E: Genuine signal** | ~3,300 | 27% | Keep |
| **D: Granular code facts** | ~2,000 | 16% | Delete or demote |
| **B: Self-referential/meta** | ~3,400 | 27% | Delete most, keep architecture-level |
| **A: Process noise** | ~2,500 | 20% | Delete all |
| **C: Stale todos** | ~1,200 | 10% | Delete all |

**Bottom line: ~73% of the database is noise.** Only ~27% represents actual useful knowledge. After aggressive cleanup, the DB should be ~3,000-3,500 entries.

---

## 5. Duplication Analysis

- **Exact content duplicates:** 24 groups (26 wasted rows) — surprisingly low, the content_hash dedup works
- **Subject+type combos appearing 5+ times:** 20+ groups — e.g., 68 facts about "agenr", 62 todos for "User"
- **Semantic duplicates:** The consolidation merged only 61 clusters from 11.5K entries. This is because most duplication is *thematic* (many entries about the same topic with slightly different wording) rather than near-exact. The cosine similarity threshold is too tight.

**Example of thematic duplication** — subject "agenr", type "fact":
All 68 entries describe different aspects of agenr. They're not duplicates per se, but collectively they drown out everything else in recall.

---

## 6. Root Causes

### 6.1 Extraction is too aggressive
The LLM extracts 50-150 entries per session transcript. It treats every statement, decision, and action as worth remembering. A 2-hour coding session generates dozens of "The assistant decided to..." entries.

**Fix:** Add extraction rules:
- Skip entries where subject is "Assistant", "assistant", "the assistant"
- Skip entries where content starts with "The assistant decided/should/was tasked"
- Skip `session-only` expiry entries entirely (don't even store them)
- Limit code-level detail (function names, file paths) to `session-only` or don't extract

### 6.2 No importance/relevance scoring
Everything is stored with equal weight. A fact about Jim's mother's dogs has the same priority as "The assistant ran git status."

**Fix:** Add a 1-10 importance score during extraction. Filter recall to importance ≥ 5 by default.

### 6.3 No decay or cleanup
9,103 "temporary" entries have no TTL. 1,102 "session-only" entries were never cleaned up. Nothing expires.

**Fix:** 
- Delete all `session-only` entries immediately (they're stale by definition since all sessions are over)
- Add TTL to `temporary`: 7 days for todos, 30 days for facts, etc.
- Run nightly cleanup

### 6.4 Confidence is meaningless
96.5% of entries are "high" confidence. The field provides zero discrimination.

**Fix:** Either calibrate the extraction prompt to actually vary confidence, or replace with importance score.

### 6.5 Subject normalization is missing
"User", "user", "Jim", "Jim Martin", "jmartin" all refer to the same person. "Assistant", "assistant" refer to the AI.

**Fix:** Normalize subjects during extraction. Map known aliases. Reject generic subjects.

---

## 7. Recommended Immediate Actions

### Quick wins (automated, no LLM needed):
1. **Delete all `session-only` entries** → removes 1,102 entries
2. **Delete all entries where subject IN ('Assistant', 'assistant')** → removes 80 entries  
3. **Delete all entries where content LIKE 'The assistant %'** → removes ~655 entries
4. **Normalize subjects:** merge "User"/"user" → "Jim Martin", "Jim"/"jmartin" → "Jim Martin"

### Medium-term (needs LLM or manual review):
5. **Score and filter self-referential entries** — keep architecture-level agenr facts, delete implementation details
6. **Score and filter code facts** — delete anything referencing specific function names/file paths unless it's a bug pattern or architecture decision
7. **Triage todos** — delete all todos older than 7 days or mark completed

### Extraction improvements:
8. **Add subject blocklist** in extraction: never use "Assistant", "User", "the assistant" as subjects
9. **Add importance score** (1-10) to extraction schema
10. **Reduce extraction volume** — aim for 10-30 high-quality entries per session, not 50-150
11. **Don't store `session-only`** — if it's only relevant for the session, it doesn't belong in long-term memory

---

## 8. Expected Impact

| Metric | Before | After cleanup |
|--------|--------|---------------|
| Total entries | 12,415 | ~3,000-3,500 |
| Signal ratio | ~27% | ~85%+ |
| Recall relevance | Poor (drowned in noise) | Good (mostly signal) |
| Session-start bootstrap | Returns agenr code details | Returns personal context + active projects |

The fundamental insight: **this is a recall quality problem, not a storage problem.** The DB needs 70-75% fewer entries, and the remaining entries need better subjects and importance scoring. Consolidation (merging duplicates) only addresses ~5% of the problem. The real fix is better extraction filtering and aggressive pruning.
