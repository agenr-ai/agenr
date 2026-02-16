# Brain Audit: Recall & Scoring Analysis

## Executive Summary

Three distinct bugs cause stale/wrong results at session-start:

1. **MCP session-start is fundamentally broken** — passes raw results without the CLI's category/budget pipeline
2. **Scoring formula rewards recall popularity over recency** — old frequently-recalled entries dominate
3. **Session-start scoring ignores vector similarity entirely** — all entries scored on memory strength alone, so old "strong" entries always win

---

## Bug 1: MCP vs CLI Divergence (Critical)

### CLI Path (`src/commands/recall.ts`)
For `context=session-start`, the CLI does sophisticated multi-pass retrieval:
1. Fetches **core** entries separately (`expiry: "core"`, limit 5000)
2. Fetches **non-core** entries separately (limit 500)
3. Passes both to `buildSessionStartResults()` which:
   - Categorizes entries: core / active (todos) / preferences / recent
   - Allocates **budget quotas**: 30% active, 30% preferences, 40% recent
   - Sorts within categories
   - Returns a diverse, balanced result set
4. Then applies `noUpdate: true` initially, does its own `updateRecallMetadata` after final selection

### MCP Path (`src/mcp/server.ts` → `callRecallTool()`)
```typescript
const results = await resolvedDeps.recallFn(db, {
  text: query || undefined,  // undefined for session-start
  context,
  limit,                     // default 10
  types,
  since,
}, apiKey);
```

That's it. **No category grouping, no budget allocation, no core/non-core split.** The MCP path calls `recall()` once with `limit=10`, which:
- Calls `fetchSessionCandidates(db, 500)` (ORDER BY updated_at DESC)
- Scores with `scoreSessionOnly()` — just `(0.3 + 0.7 * recency) * max(confidence, recallStrength)`
- Returns top 10 by score

**Result:** MCP returns whatever 10 entries have highest memory strength, with no diversity guarantees. The CLI returns a balanced mix across categories.

### Fix
The MCP `callRecallTool` needs to replicate `buildSessionStartResults` logic when `context=session-start`. Extract the session-start pipeline from `runRecallCommand` into a shared function both can call.

---

## Bug 2: `scoreSessionOnly` Rewards Stale Popular Entries

### The Formula
```typescript
function scoreSessionOnly(entry, now) {
  const memoryStrength = Math.max(conf, recall);
  const score = (0.3 + 0.7 * rec) * memoryStrength;
}
```

Where:
- `conf = confidenceScore(...)` — Bayesian: `(1 + (prior-1)*decay + confirmations*decay) / (alpha + beta)`
- `recall = recallStrength(recallCount, daysSinceRecall, tier)`
- `rec = recency(daysOld, tier)`

### The Problem: `recallStrength` 

```typescript
function recallStrength(recallCount, daysSinceRecall, tier) {
  if (recallCount <= 0) return 0;
  return Math.min(Math.pow(recallCount, 0.7) / 5, 1.0) * recency(daysSinceRecall, tier);
}
```

An entry recalled 10 times: `Math.min(10^0.7 / 5, 1.0) = Math.min(1.003, 1.0) = 1.0`

An entry recalled 5 times: `5^0.7 / 5 = 0.69`

Once recall_count ≥ 10, recallStrength is maxed at 1.0. Combined with `memoryStrength = Math.max(conf, recall)`, this means:
- **Any entry recalled ≥10 times recently gets memoryStrength ≈ 1.0**
- Old todos that got recalled every session accumulate high recall_count
- New high-confidence entries with 0 recalls get `recallStrength = 0`, falling back to `conf` alone (typically 0.5-0.75)

### Concrete Example
- Old todo (90 days, recalled 15 times, last recall 2 days ago, temporary):
  - `rec = (1 + 0.234*90/30)^-0.5 = (1 + 0.703)^-0.5 = 0.765`
  - `recall = min(15^0.7/5, 1.0) * recency(2, "temporary") = 1.0 * 0.99 = 0.99`
  - `memoryStrength = max(conf, 0.99) = 0.99`
  - **score = (0.3 + 0.7*0.765) * 0.99 = 0.826**

- New fact (2 days old, high confidence, 0 recalls, temporary):
  - `rec = (1 + 0.234*2/30)^-0.5 = 0.992`
  - `recall = 0` (never recalled)
  - `conf ≈ 0.75` (high prior, no confirmations)
  - `memoryStrength = max(0.75, 0) = 0.75`
  - **score = (0.3 + 0.7*0.992) * 0.75 = 0.746**

The 90-day-old todo outranks the 2-day-old high-confidence entry.

### Fix Options

**Option A: Decay recall_count over time (recommended)**
```typescript
function recallStrength(recallCount, daysSinceRecall, tier) {
  if (recallCount <= 0) return 0;
  // Effective count decays — old recalls matter less
  const effectiveCount = recallCount * recency(daysSinceRecall, tier);
  return Math.min(Math.pow(effectiveCount, 0.7) / 5, 1.0) * recency(daysSinceRecall, tier);
}
```

**Option B: Cap recall influence in session-start scoring**
```typescript
function scoreSessionOnly(entry, now) {
  const memoryStrength = 0.6 * conf + 0.4 * Math.min(recall, conf);
  // recall can boost confidence but not dominate it
  const score = (0.3 + 0.7 * rec) * memoryStrength;
}
```

**Option C: Add recency boost for session-start specifically**
```typescript
function scoreSessionOnly(entry, now) {
  const memoryStrength = Math.max(conf, recall);
  const recencyBoost = daysOld < 7 ? 1.2 : 1.0; // recent entries get 20% boost
  const score = (0.3 + 0.7 * rec) * memoryStrength * recencyBoost;
}
```

---

## Bug 3: Session-Start Has No Vector Similarity

When `text` is empty (session-start), `fetchSessionCandidates` returns entries ordered by `updated_at DESC` with `vectorSim: 0`. The `scoreSessionOnly` function doesn't use vector similarity at all.

This means session-start ranking is purely based on memory metadata — there's no semantic relevance signal. All 500 candidates compete on recency × strength alone.

This is somewhat by design (no query = no embedding = no vector search), but it means the scoring must be much more careful about balancing recency vs. historical recall count.

### Fix
Not a bug per se, but the session-start scoring formula must be rebalanced to weight `recency` much more heavily since there's no relevance signal to disambiguate. Consider:
```typescript
// Session-start: recency is king since we have no semantic signal
const score = (0.2 + 0.8 * rec) * (0.7 * conf + 0.3 * recall);
```

---

## Bug 4: Recall Metadata Inflation (Feedback Loop)

Every session-start call runs `updateRecallMetadata`, incrementing `recall_count` for returned entries. Entries that appear in session-start get recalled → higher recall_count → higher score → appear again → higher recall_count...

The CLI sets `noUpdate: true` on the initial `recall()` call but then does its own update after final selection. The MCP path does NOT set `noUpdate: true`, so `recall()` itself updates metadata for potentially different entries than what's finally returned.

### Fix
MCP should pass `noUpdate: true` and handle metadata updates after final filtering (matching CLI behavior). Or better: add a `dryRun` mode to recall that never updates metadata, and have both CLI and MCP manage updates explicitly.

---

## Summary of Recommended Changes

| Priority | Bug | Fix |
|----------|-----|-----|
| P0 | MCP missing session-start pipeline | Extract `buildSessionStartResults` to shared module, call from both CLI and MCP |
| P0 | recall_count feedback loop in MCP | Pass `noUpdate: true` in MCP recall, manage updates after threshold filter |
| P1 | recallStrength dominates scoring | Decay effective recall_count, or cap recall's influence relative to confidence |
| P2 | Session-start recency weighting | Increase recency weight in `scoreSessionOnly` since no vector signal exists |

### Files to Change
- `src/db/recall.ts` — Fix `recallStrength()`, adjust `scoreSessionOnly()` weights
- `src/commands/recall.ts` — Extract `buildSessionStartResults` to shared module
- `src/mcp/server.ts` — `callRecallTool()`: use shared session-start pipeline, add `noUpdate: true`
- New: `src/recall/session-start.ts` — Shared session-start logic for CLI + MCP
