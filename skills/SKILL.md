---
name: agenr
description: Use when storing new knowledge (decisions, preferences, lessons, todos) or recalling context mid-session. The agenr plugin auto-injects memory at session start - this skill covers proactive store and on-demand recall.
---

## agenr_store

Use proactively. Call immediately after any decision, user preference, lesson learned, important event, or fact worth remembering. Do not ask first.

Required: `type`, `content`, `importance`.
Optional: `subject` (short label), `tags` (array), `scope` (`private`|`personal`|`public`), `project`, `platform`, `source`.

Types: `fact | decision | preference | todo | lesson | event | relationship`
Do not store secrets/credentials, temporary state, or verbatim conversation.

### Importance calibration

- **10**: Once-per-project permanent constraints. At most 1-2 per project lifetime.
- **9**: Critical breaking changes or immediate cross-session decisions. At most 1 per significant session, often 0.
- **8**: Things an active parallel session would act on right now. Fires a cross-session signal. Use conservatively.
- **7**: Default. Project facts, decisions, preferences, milestones. No signal fired.
- **6**: Routine dev observations (verified X, tests passing). Cap here unless the result is surprising.
- **5**: Borderline. Only store if clearly durable beyond today.

Entries at 7 are saved silently. Use 8+ only if other active sessions need to know NOW.

### Confidence-aware extraction (OpenClaw transcripts)

OpenClaw transcripts include `[user]` / `[assistant]` role labels. The extractor uses this signal:
- Hedged or unverified assistant factual claims are tagged `unverified` and hard-capped at importance 5.
- Tool-verified assistant claims follow normal importance rules.
- User messages are never capped.

This means: if you say something unverified, it will be stored at max importance 5. To store a fact at higher importance, verify it with a tool call first.

## agenr_recall

Use mid-session when you need context you don't already have. Session-start recall is handled automatically - do not call at turn 1 unless you need extra context beyond the injected summary.

Parameters:
- `query` (required): semantic search string
- `limit`: max results (default 10)
- `context`: `"default"` (semantic+vector) or `"session-start"` (fast bootstrap)
- `since`: lower date bound - only entries newer than this (ISO or relative, e.g. `"7d"`, `"2026-01-01"`)
- `until`: upper date bound - only entries older than this ceiling (e.g. `"7d"` = entries created before 7 days ago). Use with `since` for a date window.
- `types`: comma-separated entry types (`fact,decision,preference,todo,lesson,event`)
- `platform`: filter by platform (`openclaw`, `claude-code`, `codex`)
- `project`: filter by project scope (pass `*` for all projects)

## agenr_retire

Soft-deletes an entry. Use when something is outdated, wrong, or superseded. Pass `entry_id` (from recall results) and optionally `reason` and `persist: true` to write to the retirements ledger.

## agenr_extract

Extracts structured knowledge entries from raw text without storing them. Useful for previewing what would be stored from a block of text before committing.
