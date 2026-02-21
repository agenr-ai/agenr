---
name: agenr
description: Use when storing new knowledge (decisions, preferences, lessons, todos) or recalling context mid-session. The agenr plugin auto-injects memory at session start - this skill covers proactive store and on-demand recall.
---

Use `agenr_store` proactively. Call it immediately after any decision, user preference, lesson learned, important event, or fact worth remembering. Do not ask first.

Required fields: `type`, `content`, `importance`.
Types: `fact | decision | preference | todo | lesson | event`.
Importance: `1-10` (default `7`), use `9` for critical items, use `10` sparingly.
Importance calibration: entries at importance 7 (the default) are saved to
memory but will NOT trigger mid-session signals to active sessions. Use
importance 8+ only for updates that other active sessions need to know about
NOW. Routine facts should stay at 7.

Do not store secrets/credentials, temporary state, or verbatim conversation.

Use `agenr_recall` mid-session when you need context you do not already have. Use a specific query so results stay relevant.

`agenr_recall` parameters:
- `query` (required): semantic search string
- `limit`: max results (default 10)
- `context`: `"default"` (semantic+vector) or `"session-start"` (fast bootstrap)
- `since`: lower date bound - only entries newer than this (ISO or relative, e.g. `"7d"`, `"2026-01-01"`)
- `until`: upper date bound - only entries older than this ceiling (ISO or relative, e.g. `"7d"` = entries created before 7 days ago). Use with `since` for a date window.
- `types`: comma-separated entry types to filter (`fact,decision,preference,todo,lesson,event`)
- `platform`: filter by platform (`openclaw`, `claude-code`, `codex`)
- `project`: filter by project scope (pass `*` for all projects)

Session-start recall is already handled automatically by the OpenClaw plugin. Do not call `agenr_recall` at turn 1 unless you need extra context beyond the injected summary.
