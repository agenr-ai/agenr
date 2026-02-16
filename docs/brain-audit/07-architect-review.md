# 07 — Architect Review: Fix Plan Assessment

**Date:** 2026-02-15  
**Reviewer:** Systems architect (subagent)  
**Input:** Audit reports 01–04, recall.ts, commands/recall.ts, mcp/server.ts, competitive research

---

## Executive Assessment

The proposed 3-phase plan is **directionally correct but mis-ordered**. The current phasing treats extraction quality as a background concern while prioritizing plumbing fixes. In a system where 73% of entries are noise, fixing recall scoring on garbage data is polishing a turd. Reorder.

---

## 1. Phasing: What's Wrong and How to Fix It

### Current Plan
1. Port CLI session-start to MCP
2. Importance scoring + recall reweight
3. Tiered memory

### Recommended Plan

**Phase 0 (prerequisite): Extraction quality — the actual root cause**
- Subject blocklist + normalization (report 03, §4.1–4.4)
- Anti-pattern content filters (meta-narration, assistant self-talk)
- Reduce extraction volume: 10–30 entries/session, not 50–150
- Add importance score (1–10) to extraction schema
- This is the "garbage in" problem. Everything downstream is wasted effort without this.

**Phase 1: Unified session-start**
- Extract `buildSessionStartResults` to `src/recall/session-start.ts`
- MCP calls same pipeline as CLI (the divergence is the most embarrassing bug — same tool, different results)
- Fix `noUpdate` in MCP path (feedback loop, report 02 §Bug 4)
- This is a 1-day fix. Do it first because it's broken and visible.

**Phase 2: Scoring reform**
- Kill the popularity feedback loop: decay effective recall_count, or cap recall influence at `0.6 * conf`
- Reweight session-start scoring: `(0.2 + 0.8 * rec) * (0.7 * conf + 0.3 * recall)` — recency dominates when there's no semantic signal
- Add importance to the scoring formula (from Phase 0's extraction changes)
- Target formula: `relevance × recency × importance × memory_strength` (multiplicative, à la Park et al.)

**Phase 3: Tiered memory (later, maybe never)**
- See §4 below. This might be the wrong abstraction entirely.

### Why This Order
Phase 0 is unglamorous but has the highest ROI. The audit shows 73% noise. Even a perfect scoring formula can't rescue a database where the best entries are buried under "The assistant decided to restart the gateway." Fix the source, then fix the ranking, then consider architecture changes.

Phase 1 is mechanically simple (extract shared function, wire both callers) and fixes a user-facing bug. Ship it in a day.

Phase 2 only makes sense after Phase 0 because importance scoring requires extraction changes. The scoring formula needs importance as an input signal.

---

## 2. Session-Start: Should It Be a Separate Retrieval Strategy?

**Yes. Emphatically.**

The current design treats session-start as "recall without a query." That's like designing a homepage by removing the search box from your search results page. Session-start has fundamentally different goals:

| Recall (query) | Session-start (wake-up) |
|----------------|------------------------|
| Answer a specific question | Orient the agent |
| Precision matters | Coverage matters |
| One topic | Multiple topics |
| Relevance = semantic similarity | Relevance = "what do I need right now?" |
| Single ranked list | Structured categories |

The CLI already half-recognizes this with `buildSessionStartResults` and its category/budget system. But it's still fundamentally fetching candidates the same way (`fetchSessionCandidates` → ORDER BY updated_at DESC) and then post-hoc categorizing.

### What a Production Session-Start Actually Needs

When an AI agent wakes up, it needs a **briefing**, not search results. Structure it like a military situation report:

```
SESSION BRIEFING
================

IDENTITY & PREFERENCES (always present, from core entries)
- Who am I? Who is the user? Key relationships.
- Communication preferences, workflow patterns.

ACTIVE TASKS (from todos + recent decisions, importance ≥ 7)
- What was I working on? What's pending?
- Sorted by importance × recency, not recall_count.

RECENT CONTEXT (last 48–72h, importance ≥ 5)
- What happened recently? Key events, decisions, lessons.
- This is the "yesterday's news" section.

LONG-TERM KNOWLEDGE (high importance, any age)
- Persistent facts the agent should always know.
- Only surfaces if importance ≥ 8 or expiry = permanent.
```

### Implementation Sketch

```typescript
// src/recall/session-start.ts

interface SessionBriefing {
  identity: RecallResult[];      // core entries, always included
  activeTasks: RecallResult[];   // todos + decisions, last 7d, importance ≥ 7
  recentContext: RecallResult[];  // last 72h, importance ≥ 5
  background: RecallResult[];    // permanent/high-importance, any age
}

async function buildSessionBriefing(db: Client, budget: number): SessionBriefing {
  // 4 SEPARATE queries, each with its own retrieval strategy
  // Not one big fetch + post-hoc bucketing
  
  const identity = await fetchByExpiry(db, "core", Infinity);
  const activeTasks = await fetchActiveTasks(db, { since: "7d", minImportance: 7 });
  const recentContext = await fetchRecent(db, { since: "72h", minImportance: 5 });
  const background = await fetchHighImportance(db, { minImportance: 8, excludeRecent: true });
  
  // Budget allocation: identity=unlimited, active=35%, recent=40%, background=25%
  return applyBudget({ identity, activeTasks, recentContext, background }, budget);
}
```

Key differences from current approach:
1. **Separate queries per section** — not one fetch + categorize
2. **Importance gating per section** — active tasks need importance ≥ 7, not just "is a todo"
3. **Time windows per section** — recent = 72h, active = 7d, background = any
4. **Identity is never budgeted** — core entries always appear

This is not "recall with different params." It's a different retrieval pipeline that happens to use the same database.

---

## 3. Does This Plan Move Toward "Memory-as-Cognition"?

### What "Memory-as-Cognition" Means
The vision is that memory isn't a database you query — it's a cognitive process with:
- **Decay**: unused memories fade
- **Strengthening**: recalled memories get stronger
- **Contradiction**: conflicting memories weaken each other
- **Consolidation**: related memories merge into higher-order understanding

### Current State
The codebase has the *scaffolding* for all four, but:
- **Decay**: `recency()` function exists but temporary entries have no TTL. Decay is cosmetic.
- **Strengthening**: `recall_count` exists but creates a feedback loop (report 02). Strengthening is actually a bug.
- **Contradiction**: `contradictions` field exists, penalty is a flat 0.8 multiplier at ≥2. No automated contradiction detection.
- **Consolidation**: Consolidation command exists but merged only 61 clusters from 11.5K entries (report 01). Thresholds too tight.

### Does the Plan Help?

**Phase 0 (extraction fix):** Neutral to cognition vision, but essential. You can't model cognition on garbage data.

**Phase 1 (session-start unification):** Neutral. Plumbing fix.

**Phase 2 (importance + scoring):** **Positive.** Importance scoring is the missing dimension that makes decay meaningful. Without importance, you can't distinguish between "this memory should decay" and "this memory should persist." Importance × recency × relevance is the Park et al. formula — proven to model human memory well.

**Phase 3 (tiered memory):** **Potentially negative.** See below.

### The Tiered Memory Question

Letta's core/archival/recall tiers model *computer storage hierarchies*, not human cognition. Humans don't have "archival memory" — they have memories that are harder to access but still influence behavior (priming, implicit memory).

A more cognitively accurate model:
- **Working memory** (session-start briefing): what's active right now
- **Episodic memory** (events, recent context): time-stamped experiences
- **Semantic memory** (facts, preferences, lessons): generalized knowledge extracted from episodes
- **Procedural memory** (workflows, patterns): how-to knowledge

The current type system (fact, event, todo, decision, preference, relationship, lesson) maps loosely onto this but doesn't enforce it. Before adding tiers, consider whether the existing types + importance + decay already give you what tiers would.

**My recommendation:** Skip Phase 3 as planned. Instead, invest in making decay and consolidation actually work. Real "memory-as-cognition" means entries naturally migrate from episodic to semantic through consolidation, and naturally fade through decay. That's more interesting (and more differentiated) than adding storage tiers.

---

## 4. Specific Technical Recommendations

### 4.1 The Recall Feedback Loop (Critical)

Report 02 nails this. The fix is straightforward:

```typescript
// Option: blend instead of max
const memoryStrength = 0.6 * conf + 0.4 * Math.min(recall, conf);
```

But I'd go further: **recall_count should not directly influence scoring at all.** It should influence *decay rate* instead. An entry recalled frequently decays slower (the memory is exercised), but its base score comes from importance × recency × relevance. This is closer to how human memory works — you don't remember things *because* you remembered them before; you remember them because they were important and you've kept them fresh.

```typescript
function adjustedRecency(daysOld: number, tier: string, recallCount: number): number {
  // Recalls slow the decay rate, not boost the score
  const effectiveAge = daysOld / (1 + 0.1 * Math.min(recallCount, 10));
  return recency(effectiveAge, tier);
}
```

### 4.2 Importance Score Design

Add to extraction schema:
```typescript
importance: number; // 1-10
// 1-3: ephemeral (session artifacts, intermediate steps)
// 4-6: contextual (project details, current work state)  
// 7-8: significant (decisions, lessons, key relationships)
// 9-10: core (identity, deep preferences, life events)
```

Include concrete examples in the extraction prompt for each level. The audit shows confidence was useless because the LLM over-assigned "high." Importance will suffer the same fate without calibration examples.

### 4.3 Consolidation Should Be Continuous, Not Batch

Current consolidation runs as a manual command. For "memory-as-cognition," consolidation should happen at store time:

1. When storing a new entry, check for semantically similar existing entries (cosine > 0.85)
2. If found, either: merge (update existing entry content), confirm (increment confirmations), or contradict (increment contradictions + flag for review)
3. This makes consolidation a natural byproduct of learning, not a maintenance task

### 4.4 Temporal Awareness

The research flagged Zep/Graphiti as the only system with temporal awareness. agenr should track:
- `valid_from` / `valid_until`: when a fact is true (e.g., "Jim's team uses React" → valid_from=2025-01, valid_until=null)
- This enables: "what was true at time X?" and auto-expiry of time-bounded facts

This is a Phase 3+ concern but worth designing the schema for now.

---

## 5. What Would I Do Differently Entirely?

If I were starting fresh, the biggest change: **don't extract knowledge as discrete entries. Extract knowledge as a graph.**

Entries like `{subject: "Jim", type: "preference", content: "prefers specs before coding"}` lose relational context. A graph would capture:
- Jim → prefers → specs-before-coding
- Jim → works-on → agenr
- agenr → has-component → extraction-pipeline
- extraction-pipeline → has-bug → subject-normalization

This is what Zep/Graphiti does, and it's why they have temporal awareness — edges have timestamps.

**But** — this is a massive rewrite and not what you should do now. The current entry-based system can work well if extraction quality improves and scoring gets fixed. The graph is a v2.0 consideration.

For now: fix extraction (Phase 0), unify session-start (Phase 1), reform scoring (Phase 2). Skip tiered memory. Invest the Phase 3 effort into making decay and consolidation actually work as cognitive processes.

---

## 6. Summary

| Question | Answer |
|----------|--------|
| Is the phasing right? | No — extraction quality must come first (Phase 0) |
| Should we do something different entirely? | No, but reorder and drop tiered memory |
| Does the plan move toward memory-as-cognition? | Phases 0–2 yes, Phase 3 no |
| Should session-start be separate? | Yes — it's a briefing pipeline, not a recall variant |
| What's the single highest-impact change? | Extraction quality (kills 73% noise at source) |
| What's the fastest win? | Unify MCP/CLI session-start (1-day fix) |

### Recommended Execution Order
1. **Day 1:** Port `buildSessionStartResults` to shared module, fix MCP `callRecallTool` (Phase 1)
2. **Week 1:** Extraction quality — subject blocklist, anti-patterns, importance scoring in schema (Phase 0)
3. **Week 2:** Scoring reform — kill feedback loop, add importance to formula (Phase 2)
4. **Week 3+:** Redesign session-start as structured briefing with separate queries per section
5. **Later:** Continuous consolidation, temporal awareness, graph exploration
