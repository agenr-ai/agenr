---
name: agenr
description: Use when storing new knowledge (decisions, preferences, lessons, todos) or recalling context mid-session. The agenr plugin auto-injects memory at session start - this skill covers proactive store and on-demand recall.
---

Use `agenr_store` proactively. Call it immediately after any decision, user preference, lesson learned, important event, or fact worth remembering. Do not ask first.

Required fields: `type`, `content`, `importance`.
Types: `fact | decision | preference | todo | lesson | event`.
Importance: `1-10` (default `7`), use `9` for critical items, use `10` sparingly.

Do not store secrets/credentials, temporary state, or verbatim conversation.

Use `agenr_recall` mid-session when you need context you do not already have. Use a specific query so results stay relevant.

Session-start recall is already handled automatically by the OpenClaw plugin. Do not call `agenr_recall` at turn 1 unless you need extra context beyond the injected summary.
