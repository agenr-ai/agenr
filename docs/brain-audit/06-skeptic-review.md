# 06 — Skeptic Review of Fix Plan

**Date:** 2026-02-15  
**Role:** Adversarial reviewer — poking holes in the proposed Phase 1/2/3 plan

---

## TL;DR

The plan correctly identifies the biggest bug (MCP session-start) but underestimates how much the extraction prompt is the root of everything. Phase 2 (importance scoring) will fail for the same reason confidence scoring failed — you're asking the same LLM with the same vague prompt to produce a new number, and it'll stamp "8/10" on everything just like it stamps "high" on 96.5% today. **The highest-impact change is fixing the extraction prompt, not adding scores to bad data.**

---

## 1. Phase 1 Critique: Port CLI Session-Start to MCP

**This is correct and should ship immediately.** No objections to the approach.

However, two things the plan misses:

### 1a. MCP recall doesn't pass `noUpdate: true`

Report 02 caught this but the plan doesn't explicitly call it out. The MCP path lets `recall()` update metadata for all 500 candidates it fetches internally, then returns 10. This means every session-start inflates recall_count on entries that weren't even shown to the user. **This is actively corrupting the scoring data right now.** Fix it in the same PR as the port.

### 1b. The shared function extraction is straightforward but test it

`buildSessionStartResults` in `recall.ts` command depends on `RecallCommandResult` (which adds `category`), `consumeByBudget`, `estimateEntryTokens`, etc. These are all in `commands/recall.ts` currently. When extracting to a shared module, make sure the MCP path also passes `budget` — right now `callRecallTool` doesn't accept or forward a budget parameter at all. Without budget, the CLI path returns unlimited results capped by `limit`. Is that what you want from MCP? Probably yes for now, but document the decision.

---

## 2. Phase 2 Critique: Importance Scoring + Reweight Recall

### 2a. Importance scoring at extraction will fail

This is my biggest concern. Here's the evidence:

**The confidence field already IS an importance signal.** "High" = explicitly stated, "medium" = implied, "low" = weakly implied. That's a quality/importance gradient. The LLM assigns "high" to 96.5% of entries.

Adding a separate 1-10 "importance" field asks the same model, processing the same transcript, to make a finer-grained version of the same judgment. Why would it suddenly develop discrimination? The extraction prompt says "extract ALL knowledge" — the LLM is doing exactly what it's told. It extracts everything and marks it all important because the prompt incentivizes completeness.

**Prediction:** You'll add importance scoring, the LLM will assign 7-9 to 90%+ of entries, and you'll be back here in a week wondering why importance is also useless.

### 2b. What would actually work instead

The problem isn't scoring — it's **what gets extracted in the first place.** The prompt says "extract ALL knowledge." That's the bug. Fix the prompt to:

1. **Extract 10-30 entries max per session** (explicitly cap it)
2. **Define what NOT to extract** (assistant actions, session-ephemeral instructions, code-level details)
3. **Require the subject to be a topic, not an actor** (the #1 quality signal)
4. **Don't store session-only entries at all** — if it expires with the session, it's not memory

If you still want importance scoring after fixing the prompt, fine — but fix the prompt first and see if you even need it.

### 2c. Recall formula reweighting is good but insufficient

The recall_count feedback loop (report 02, Bug 4) is real. The proposed fix of decaying effective recall count is sound. But there's a deeper issue: **`scoreSessionOnly` uses `Math.max(conf, recall)` which means recall can completely override confidence.** 

An entry that's been recalled 10+ times but has low intrinsic quality will score higher than a genuinely important entry that's never been recalled. This isn't just a weighting problem — it's a structural issue. Consider:

```typescript
// Instead of max, use weighted combination:
const memoryStrength = 0.7 * conf + 0.3 * recall;
```

This ensures confidence (the intrinsic quality signal) always dominates, and recall history is just a boost.

---

## 3. Phase 3 Critique: Tiered Memory

No strong objections since it's deferred, but one concern: **the expiry tiers already exist and are broken.** You have "temporary" (73% of entries) with no TTL, and "session-only" (9%) that never got cleaned up. Before adding more tiers, make the existing ones work:

- `session-only` should auto-delete (or never be stored)
- `temporary` should have actual TTL (7d for todos, 30d for facts, configurable)
- `permanent` should require some validation (not just what the LLM says)

Don't build new tiers on top of broken tiers.

---

## 4. What the Plan Doesn't Address

### 4a. The 9,500 entries currently in the DB are still mostly noise

Cleanup removed 1,861 entries (15%). The audit estimated 73% noise. That means ~6,000+ noise entries remain. The plan improves new extraction and recall scoring but **doesn't fix the existing data.** Every session-start will still pull from a pool that's majority garbage.

Options:
1. **Nuke and re-extract** with a better prompt (nuclear but honest)
2. **Batch-score existing entries** with the improved prompt and delete low-scorers
3. **Accept degraded quality** until old entries age out (they won't — no TTL)

I'd lean toward option 2: run a one-time LLM pass over existing entries asking "is this worth remembering?" and delete the noise. It's cheaper than re-extracting from 106 transcripts.

### 4b. No subject normalization plan

Report 01 and 03 both flag this: "Jim", "Jim Martin", "jmartin", "User", "user" all refer to the same person. The plan doesn't address subject normalization. Without it, searches for Jim's preferences will miss entries filed under "user" or "jmartin."

Quick fix: add a subject alias map at extraction time AND a migration script for existing data.

### 4c. Dedup threshold is too tight

`AUTO_SKIP_THRESHOLD` at 0.98 cosine similarity means paraphrased duplicates slip through. The "End-of-day recap workflow" example shows 5-6 near-identical entries surviving. Lower to 0.93-0.95. This is a one-line change with outsized impact on DB quality.

### 4d. No extraction-time batch dedup

`extractKnowledgeFromChunks()` processes chunks independently with no cross-chunk dedup. Multi-session ingestion creates duplicates before they even hit the store. Add a simple Jaccard or exact-match dedup pass after extraction, before store.

---

## 5. The Simplest Change With Biggest Impact RIGHT NOW

**Fix the extraction prompt.** Specifically:

1. Change "extract ALL knowledge" → "extract the 10-30 MOST IMPORTANT knowledge entries"
2. Add explicit blocklist: never use "User", "Assistant", "the assistant" as subjects
3. Add anti-patterns: don't extract assistant actions, don't extract session-ephemeral instructions as todos
4. Don't store `session-only` entries

This costs zero code changes to the scoring/recall pipeline. It's purely a prompt edit + one `if (entry.expiry === 'session-only') continue;` guard. And it addresses the root cause: bad data going in.

Second highest impact: fix `noUpdate: true` in MCP recall (stops the feedback loop corruption).

Third: port CLI session-start to MCP (the stated Phase 1).

---

## 6. Should You Nuke the DB?

**Not yet, but soon.**

Right now the DB has ~9,500 entries, ~27% signal. That's ~2,500 good entries mixed with ~7,000 noise entries. A re-extraction with a better prompt from 106 transcripts would produce maybe ~2,000-3,000 high-quality entries (at 20-30 per session vs the current 50-150).

The problem with nuking: you lose the 2,500 good entries and need to re-extract everything, which costs LLM tokens and time.

The better path:
1. Fix the prompt first
2. Run a batch quality-check pass on existing entries (LLM asks: "is this worth keeping?" for each entry — could be done in batches cheaply)
3. Delete entries that fail the check
4. Re-extract only from sessions that produced mostly garbage

This is more surgical than a full nuke and preserves the good data.

---

## 7. Summary: Revised Priority Order

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 1 | Fix extraction prompt (cap volume, blocklist subjects, anti-patterns) | **Highest** — stops garbage at the source | Low (prompt edit) |
| 2 | Fix MCP `noUpdate: true` + port session-start pipeline | **High** — fixes the immediate broken feature + stops data corruption | Medium |
| 3 | Lower dedup threshold 0.98 → 0.94 | **Medium** — reduces future duplication | Trivial |
| 4 | Stop storing `session-only` entries | **Medium** — eliminates a whole noise category | Trivial |
| 5 | Reweight scoring: `0.7*conf + 0.3*recall` instead of `max(conf, recall)` | **Medium** — fixes feedback loop | Low |
| 6 | Add TTL to `temporary` entries | **Medium** — enables natural decay | Medium |
| 7 | Batch quality-check existing entries, delete noise | **High** — cleans the pool | Medium (LLM cost) |
| 8 | Subject normalization (alias map) | **Low-Medium** — improves search | Low |
| 9 | Add importance scoring to extraction | **Low** — only if prompt fix isn't sufficient | Medium |
| 10 | Tiered memory | **Low** — premature until basics work | High |

The proposed plan has the right Phase 1 but Phase 2 is solving the wrong problem. Fix the input (extraction prompt) before adding complexity to the output (scoring formulas). You can't score your way out of garbage data.
