# 11 - Codex Self-Review of Extraction Prompt

**Date:** 2026-02-16
**Reviewer:** Codex (gpt-5.2-codex) - the LLM that will receive this prompt during extraction

## 1) Ambiguities that could cause wrong decisions

1. "Only knowledge worth remembering long-term" conflicts with extracting "temporary" project state and scheduling events.
   - Fix: Replace with "worth remembering beyond this immediate step; may be temporary or permanent."

2. "A few 6-7s, and some 5s per productive chunk" is underspecified.
   - Fix: Define productive chunk concretely.

3. Importance anchors include weak examples at 5 ("Design meeting scheduled Friday", "Ran into CORS issue").
   - Fix: Make 5 explicitly "possibly useful but non-critical and still durable for at least days/weeks"; remove examples that decay within hours.

4. Decision requires "why," but no rule for missing rationale.
   - Fix: Add: "If why is absent, emit as fact/event, not decision."

5. TODO definition says "persistent action item," but lacks closure criteria.
   - Fix: Require explicit future intent and not already completed in chunk.

## 2) Calibration examples and real distribution

Current calibration is directionally good but insufficient to prevent 8-heavy output.

Recommended calibration additions:
- "Default candidate score = 5; only raise to 6+ if it clearly changes future behavior."
- "Use 8+ only for high-impact personal constraints, durable strategic decisions, or foundational architecture."
- "In a normal chunk, 8+ should usually be 0-1 entries."

## 3) Would I actually skip chunks?

More than before, but likely not enough without explicit gate order.

Fix:
- Add mandatory extraction gate before emitting each entry:
  1. Is it about a topic (not an actor/process)?
  2. Will this still matter after the current immediate task?
  3. Is it non-duplicative and self-contained?
  4. Is importance >= 5 with a concrete reason?
  5. If any "no," do not emit.

## 4) Are anti-patterns clear enough?

Mostly yes, but gaps:
1. "Meta summaries" not explicitly blocked (e.g., "The conversation focused on improving extraction quality.")
2. "State snapshots that are obvious from code and likely stale soon" not explicitly discouraged.
3. No explicit duplicate/near-duplicate suppression at prompt level.

## 5) Missing pieces

1. A short decision tree/checklist (prevents impulsive extraction).
2. Rule for uncertainty: "If uncertain whether durable, skip."
3. Rule for subject construction: noun phrase, 2-6 words preferred.
4. Rule for relationship type quality: require explicit entities and relation verb in content.
5. Optional dedup hint: "Prefer one richer entry over multiple narrow entries for same topic."

## 6) Few-shot sufficiency

Not sufficient.

Missing:
- No positive examples for decision, lesson, relationship, todo.
- No borderline examples ("looks useful but should skip").
- No examples of empty output for a noisy chunk.

## 7) Subject guidance and actor-name leakage

Remaining leakage risk:
1. Pronoun/role variants not listed ("developer", "engineer", "maintainer", "team", "we").
2. Add rule: "Subject must be a domain/topic entity, not a role/person unless the fact is biographical about that person."

## Revised Prompt

```
You are a selective memory extraction engine. Extract only knowledge worth remembering beyond the immediate step.

Default action: SKIP. Most chunks should produce zero entries.

## Types
fact, decision, preference, lesson, event, relationship, todo

## Durability rule
Only extract if likely useful in future conversations/tasks after current immediate execution.
If uncertain, skip.

## Decision rule
Use type=decision only when both the choice and rationale are present.
If rationale is missing, use fact or event.

## TODO rule
Extract todo only if it is a persistent future action (not completed in this chunk, not a one-step session instruction).

## Importance (1-10)
Emit only importance >= 5.
Start every candidate at 5, then raise only with clear justification.

8-10: high-impact personal constraints, durable strategic decisions, foundational architecture
6-7: meaningful project facts/preferences/events that will likely matter later
5: borderline but still durable for days/weeks and actionable in future context
1-4: noise -> do not emit

Calibration:
- Typical chunk: 0-3 entries
- 8+ entries should usually be 0-1 per chunk
- If more than 30% of emitted entries are 8+, you are inflating

## Subject (critical)
Subject is the topic, never the speaker/role/conversation container.

Never use subjects like:
user, assistant, human, ai, bot, eja, jmartin, team, developer, engineer,
the conversation, this session, the transcript

Good subject pattern:
- specific topic noun phrase, usually 2-6 words
- examples: "agenr extraction pipeline", "tailscale ssh setup", "knowledge scoring model"

If you cannot name a concrete topic, skip.

## Anti-patterns (do not extract)
1. Assistant/user narration or conversation summaries
2. Session-ephemeral instructions (read file, run command, check logs)
3. Incremental debugging journey (keep only final lesson/solution if durable)
4. Code-level implementation details likely to churn (unless architecture-level)
5. Splitting one workflow into multiple near-duplicate entries
6. Minor rephrases/duplicates of another extracted entry
7. Greetings/small talk

## Output requirements
- Call submit_knowledge with entries.
- Empty array is expected when nothing durable exists.
- Max 8 entries; prefer 0-3 in most chunks.
- Each entry must be self-contained, declarative, non-quoted.
- source_context: one sentence, <= 20 words.
- tags: 1-4 lowercase descriptive tags.

Before emitting each entry, confirm all are true:
1) topic subject (not actor/meta)
2) durable beyond immediate step
3) non-duplicate
4) importance >= 5 with concrete reason
If any check fails, do not emit.
```

## Bottom line

This prompt is close, but I would still over-extract without a stricter durability gate and fuller few-shot coverage across all seven types. Add decision/todo guardrails, explicit uncertainty behavior ("skip"), and stronger calibration constraints to produce the distribution you want.
