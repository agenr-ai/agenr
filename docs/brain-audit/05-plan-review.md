# 05 — Plan Review: Technical Analysis & Recommendations

**Date:** 2026-02-15  
**Reviewer:** Technical advisor (subagent)

---

## Verdict: The plan is directionally correct but under-scoped in Phase 2 and wrong about Phase 3.

---

## Phase 1: Port CLI session-start pipeline to MCP — ✅ Correct, do it now

The MCP `callRecallTool` is embarrassingly broken for session-start. It calls `recall()` once with `limit=10`, gets 10 entries scored by `scoreSessionOnly` (recency × memory strength), and returns them. No core/non-core split, no category budgeting, no `noUpdate: true`. The CLI's `buildSessionStartResults` does all of this correctly.

**What to actually do:**

1. Extract `buildSessionStartResults` and its helpers (`classifySessionCategory`, `consumeByBudget`, `compareResults`, `assignCategory`) from `src/commands/recall.ts` into `src/recall/session-start.ts`
2. Have both CLI and MCP import from the shared module
3. MCP needs TWO `recall()` calls (core + non-core), same as CLI lines ~320-340
4. MCP must pass `noUpdate: true` on both recall calls, then explicitly call `updateRecallMetadata` on the final selected set — matching CLI behavior exactly
5. Expose `budget` as an MCP tool parameter (it's not currently)

**Time estimate is right** — 30 min if you don't overthink it. The logic already exists, you're just moving it.

**One thing you're missing:** The MCP path also doesn't pass `scope: "private"` in the recall query. The CLI defaults to private scope. This means MCP may return different scope-filtered results. Fix while you're in there.

---

## Phase 2: Importance scoring — ⚠️ Right idea, wrong execution

### What's right:
- Adding a 1-10 importance score at extraction time: yes
- LLM-assigned during extract: yes
- Reweighting the recall formula: yes
- Capping/decaying recall_count: yes

### What's wrong:

**Problem 1: You're putting importance in the wrong place.**

Adding `importance` as a new column means re-embedding nothing, but it also means your 9,500 existing entries have no score. You'll need a backfill pass. That's fine — but the backfill should be a **batch LLM call** that scores existing entries, not a manual review. Budget ~$2-5 in API costs for 9.5K entries with a cheap model (gpt-4.1-mini).

**Problem 2: The extraction prompt is the real bottleneck, not the scoring formula.**

The audit reports document the symptoms beautifully but your plan doesn't address the extraction prompt aggressively enough. The current prompt says:

> "For the subject field, use the most specific identifier (name, project name, etc.)"

This is why you get `subject: "User"` on 198 entries. Report 03 has good prompt fixes — **implement ALL of them in Phase 2, not later.** Specifically:

- Subject blocklist (User, Assistant, etc.) — enforce in validation, not just prompt
- Anti-pattern rules (no "The assistant was instructed to..." entries)
- Merge workflow steps into single entries
- Content quality filters (min length, meta-pattern rejection)

These are 10x more impactful than formula tweaks. **If you only fix the formula but keep extracting garbage, you're just ranking garbage more carefully.**

**Problem 3: The confidence field should die, not coexist with importance.**

You have 96.5% "high" confidence. The extraction LLM doesn't understand what confidence means (it maps it to "was this stated explicitly?" which is almost always yes). Don't add importance alongside confidence — **replace confidence with importance**. Having both creates confusion about which one matters. 

Schema migration: `ALTER TABLE entries ADD COLUMN importance INTEGER DEFAULT 5`. Keep `confidence` for backward compat but stop using it in scoring. Phase out over time.

**Problem 4: The `scoreSessionOnly` rewrite should be more aggressive.**

Your audit suggests tweaking weights. I'd go further. For session-start (no vector signal), the formula should be:

```typescript
function scoreSessionOnly(entry, now) {
  const daysOld = parseDaysBetween(now, entry.created_at);
  const imp = (entry.importance ?? 5) / 10;  // 0.1 to 1.0
  const rec = recency(daysOld, entry.expiry);
  
  // recall_count influence: logarithmic, capped, decayed
  const recallBoost = entry.recall_count > 0 
    ? 0.1 * Math.min(Math.log2(entry.recall_count + 1) / 4, 1.0) * recency(daysSinceRecall, entry.expiry)
    : 0;
  
  // importance is king, recency is queen, recall is a minor courtier
  return imp * (0.3 + 0.7 * rec) + recallBoost;
}
```

Key changes:
- **importance drives the score**, not memory strength
- **recall_count is additive, not multiplicative** — it can boost but never dominate
- **recall_count is logarithmic AND decayed** — 100 recalls ≠ 100x better than 1
- **confidence is gone** from the formula

**Problem 5: You need extraction-time dedup, not just storage-time.**

`extractKnowledgeFromChunks` accumulates entries across chunks with zero dedup. The storage layer catches exact/near-exact dupes (0.98 cosine), but thematic duplication (6 entries about "end-of-day workflow") sails through. Add a simple within-batch dedup:

```typescript
// After extraction, before return:
// Group by subject, within each group, skip entries with Jaccard word similarity > 0.6
```

### Revised Phase 2 scope:

| Task | Effort |
|------|--------|
| Add `importance` column + migration | 15 min |
| Update extraction prompt (subject blocklist, anti-patterns, importance field) | 1 hr |
| Add importance to schema/validation | 30 min |
| Backfill existing entries (batch LLM scoring) | 1 hr (mostly waiting) |
| Rewrite `scoreSessionOnly` and `scoreEntry` to use importance | 1 hr |
| Cap/decay recall_count influence | 30 min |
| Add extraction-time dedup | 1 hr |
| Add content quality filters (meta-pattern rejection) | 30 min |
| **Total** | **~6 hrs** (half day is tight but doable) |

---

## Phase 3: Tiered memory — ❌ Wrong approach for this system

### Why Letta-style tiers are a bad fit here:

Letta (MemGPT) uses tiered memory because it's simulating a **conversational agent with limited context windows**. It has:
- Core memory (always in context) — persona + user facts, ~2KB
- Archival memory (vector search) — unlimited, searched on demand
- Recall memory (conversation buffer) — recent messages

This makes sense when the agent needs to manage its own context window. **agenr is not that.** agenr is a knowledge store that gets queried by external agents. The querying agent (OpenClaw/Claude) manages its own context. agenr doesn't need to decide what fits in context — it just needs to return the best N results for a query.

Adding tiers with importance-gated promotion creates:
- Complexity (promotion logic, tier boundaries, when to search which tier)
- Latency (multi-tier search)
- A new tuning problem (what importance threshold promotes?)

For diminishing returns — because `buildSessionStartResults` already does category-based budgeting, which is a simpler version of the same idea.

### What to do instead of Phase 3:

**A. Consolidation that actually works.**

The current consolidation merged only 61 clusters from 11.5K entries because the cosine threshold is too tight. Instead of tiers, invest in better consolidation:

- Lower the "review" threshold from 0.92 to 0.85
- Group by subject+type, then consolidate within groups (cheaper, more targeted)
- Use LLM to merge N related entries into 1 summary entry (like the Generative Agents "reflection" mechanism from Park et al.)
- Run consolidation on a schedule (nightly) or after extraction batches

This is the Park et al. insight applied correctly: **reflection/compression beats tiering** for a knowledge store. The Generative Agents paper's memory system works because it periodically creates higher-level "reflections" that synthesize lower-level observations. That's consolidation, not tiering.

**B. Forgetting curve.**

Instead of promoting important entries up tiers, demote unimportant ones down to deletion:

```
if importance < 3 AND recall_count == 0 AND daysOld > 30:
  soft_delete (supersede with no replacement)

if importance < 5 AND recall_count == 0 AND daysOld > 90:
  soft_delete
```

This is what Mem0 does — it has an active pruning/forgetting mechanism that removes stale entries, not a promotion mechanism that elevates important ones. The result is the same (high signal-to-noise) with much less complexity.

**C. Synthetic recall queries.**

One thing nobody in your plan mentions: the session-start path has NO semantic signal because there's no query. You could generate one:

1. At session start, take the last 2-3 conversation turns (or the session label/topic if available)
2. Generate a synthetic embedding from that context
3. Use it as a lightweight vector query alongside the metadata-based session-start pipeline
4. Blend: 0.3 * vector_score + 0.7 * session_score

This would dramatically improve session-start relevance for continuing conversations. Mem0 does something similar — it generates "memory queries" from conversation context.

---

## Industry Comparison

| System | Relevant Technique | Applicable? |
|--------|-------------------|-------------|
| **Generative Agents (Park et al.)** | Importance scoring at creation (1-10, LLM-assigned) | ✅ Directly — do this in Phase 2 |
| **Generative Agents** | Reflection/synthesis of low-level observations into high-level insights | ✅ Better than tiering — enhance consolidation |
| **Generative Agents** | Recency × importance × relevance scoring | ✅ Your Phase 2 formula, but they multiply all three, with relevance from vector similarity |
| **Mem0** | Memory operations: ADD, UPDATE, DELETE, NOOP decided by LLM | ⚠️ Overkill for now, but the DELETE/NOOP idea is good — the extraction LLM should be able to say "not worth storing" |
| **Mem0** | Conflict resolution (contradicting facts update in place) | ✅ You have contradiction tracking but don't act on it |
| **LangMem** | Namespace/thread scoping | ⚠️ You have scope/expiry which is similar enough |
| **Letta/MemGPT** | Tiered memory with explicit management | ❌ Wrong fit — you're not managing an agent's context window |

### The one technique everyone uses that you're missing:

**NOOP/skip at extraction time.** Every modern memory system (Mem0, LangMem) lets the extraction step say "this isn't worth remembering." Your extraction LLM is forced to call `submit_knowledge` — it has no "skip" option. Add to the prompt:

> "If a conversation contains no knowledge worth extracting (pure task execution, debugging output, etc.), call submit_knowledge with an empty entries array. Not every conversation produces knowledge."

This alone could reduce extraction volume by 30-50%.

---

## Summary: Revised Plan

| Phase | What | When | Impact |
|-------|------|------|--------|
| **1** | Port CLI session-start pipeline to MCP (shared module) | Now, 30 min | Fixes broken MCP path |
| **2a** | Fix extraction prompt + add importance + add NOOP + subject blocklist + content filters | Next, 3 hrs | Stops generating garbage |
| **2b** | Rewrite scoring formula (importance-driven, decay recall_count) + backfill importance on existing entries | Same day, 3 hrs | Fixes ranking |
| **3** | Enhanced consolidation (lower thresholds, LLM-merge within subject groups, nightly schedule) + forgetting curve (auto-prune low-importance old entries) | Next week, 1 day | Keeps DB clean long-term |
| **4** | Synthetic recall queries for session-start context | When you feel ambitious | Best possible session-start quality |

Drop tiered memory. It's complexity for complexity's sake in this architecture.

---

## Specific Code Changes

### `src/extractor.ts` — SYSTEM_PROMPT changes:

```diff
- For the subject field, use the most specific identifier (name, project name, etc.)
+ For the subject field, use the TOPIC being discussed — a project name, tool name, 
+ concept, or specific thing. NEVER use speaker roles ('user', 'assistant', 'Human', 
+ 'AI') or generic person references as subjects. If the entry is biographical 
+ information ABOUT a specific person, use their name.
+ - Assign importance (1-10): 1 = trivial/ephemeral, 5 = moderately useful context, 
+   10 = critical decision, core preference, or key biographical fact
+ - Do NOT extract meta-commentary about what the assistant did. Extract the KNOWLEDGE, 
+   not the process.
+ - Do NOT extract session-specific instructions as todos. Only extract genuine 
+   persistent action items.
+ - If the conversation has no extractable knowledge, return an empty entries array.
```

### `src/db/recall.ts` — `recallStrength` fix:

```typescript
export function recallStrength(recallCount: number, daysSinceRecall: number, tier: string): number {
  if (tier === "core") return 1.0;
  if (recallCount <= 0) return 0;
  // Log scale, capped at 0.5 — recall can inform but never dominate
  const raw = Math.min(Math.log2(recallCount + 1) / 6, 0.5);
  return raw * recency(daysSinceRecall, tier);
}
```

### `src/mcp/server.ts` — `callRecallTool` session-start:

```typescript
if (context === "session-start") {
  // Mirror CLI: two-pass with category budgeting
  const coreResults = await resolvedDeps.recallFn(db, {
    text: undefined, context, limit: 5000, expiry: "core",
    scope: "private", noUpdate: true,
  }, apiKey);
  
  const nonCoreResults = await resolvedDeps.recallFn(db, {
    text: undefined, context, limit: 500, types, since,
    scope: "private", noUpdate: true,
  }, apiKey);
  
  const { results } = buildSessionStartResults(coreResults, nonCoreFiltered, budget, limit);
  
  // Update metadata only for final selection
  await updateRecallMetadata(db, results.map(r => r.entry.id), now);
  
  return formatRecallText("session-start", results);
}
```

---

## One More Thing

Your DB has 9,493 entries post-cleanup. Even after Phase 2 extraction improvements, you won't be extracting from new transcripts for a while — the backlog is already ingested. So the **highest immediate ROI** is:

1. Phase 1 (fix MCP) — 30 min
2. Backfill importance scores on existing 9.5K entries — 1 hr
3. Rewrite scoring formula — 1 hr  
4. Run aggressive prune (importance < 3 AND recall_count == 0) — 15 min

These four steps, totaling ~3 hours, will transform recall quality for the existing database. The extraction prompt improvements matter for *future* extractions but don't help the 9.5K entries already in the DB.

Prioritize the data you have. Fix the pipeline for data you'll get.
