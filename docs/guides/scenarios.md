# AGENR Setup Scenarios

## Quick Start (30 seconds)

```bash
npm install -g agenr
agenr setup          # configure LLM provider + embeddings
cd your-project/
agenr init           # auto-detects platform, wires everything up
```

That's it. Your agent now has persistent memory. Next session, it remembers what happened in previous ones.

## How It Works

`agenr init` does three things:

1. **Init** -- Creates `.agenr/config.json` in your project with a project slug, platform, and path. Adds `.agenr/knowledge.db` to `.gitignore`.

2. **Instruct** -- Appends a system prompt block (wrapped in `<!-- agenr:start -->` / `<!-- agenr:end -->` markers) to your platform's instructions file. This tells the agent *when* to recall and *when* to store. The block is idempotent -- re-running `agenr init` updates it, never duplicates it.

3. **Connect** -- Writes or merges an MCP server entry into your platform's config file (`.mcp.json`, `.cursor/mcp.json`, etc.) so the agent can call `agenr_recall` and `agenr_store` as tools.

The **watcher daemon** (`agenr daemon install`) monitors session transcript files in the background. It extracts structured knowledge automatically -- facts, decisions, preferences, todos, lessons, events -- and stores them with semantic dedup. You don't need the watcher for basic use, but it means memory accumulates even when the agent forgets to call `agenr_store`.

### Platform file mapping

| Platform | Instructions file | MCP config file |
|----------|------------------|-----------------|
| Claude Code | `CLAUDE.md` | `.mcp.json` |
| Cursor | `.cursor/rules` (or `.cursorrules` if it exists) | `.cursor/mcp.json` |
| Codex CLI | `AGENTS.md` | `.mcp.json` |
| OpenClaw | `AGENTS.md` | `.mcp.json` |
| Windsurf | `.windsurfrules` | `.mcp.json` |
| Generic | `AGENTS.md` | `.mcp.json` |

---

## Scenarios

### Scenario 1: Solo developer, one project

The default case. One person, one repo, one agent platform.

**Setup:**

```bash
cd ~/Code/my-project
agenr init
```

`agenr init` auto-detects your platform from what's in the directory (`.claude/` means Claude Code, `.cursor/` means Cursor, etc.). Override with `--platform` if detection is wrong:

```bash
agenr init --platform cursor
```

**What happens:**

- `.agenr/config.json` created with `"project": "my-project"` (derived from directory name)
- System prompt block appended to your instructions file
- MCP config written so the agent can call agenr tools
- `.agenr/knowledge.db` added to `.gitignore`

**Watch out for:**

- `agenr` must be in your PATH **as seen by your editor**. GUI clients use a restricted PATH — if MCP tools don't appear, run `which agenr` and use the full absolute path in `.mcp.json` instead of just `"agenr"`. See Gotcha #1 below.
- The project slug is derived from your directory name. `My Cool Project` becomes `my-cool-project`. You can override: `agenr init --project my-slug`.

---

### Scenario 2: OpenClaw only (no Codex)

OpenClaw uses the same `agenr init` flow as other platforms.

**Setup:**

```bash
cd ~/your-workspace
agenr init --platform openclaw
```

Or if your `AGENTS.md` already has OpenClaw markers, auto-detection handles it.

**What happens:**

- System prompt block appended to `AGENTS.md`
- MCP config written to `.mcp.json`

**Watch out for:**

- OpenClaw loads `AGENTS.md` as project context automatically. The system prompt block in `AGENTS.md` is how the agent learns about agenr -- there's no separate config.
- The OpenClaw plugin also injects recall context at session start via `before_agent_start`. This means the agent gets memory even before it reads AGENTS.md. The two mechanisms are complementary, not redundant.

---

### Scenario 3: OpenClaw + Codex (hybrid)

You use OpenClaw as your daily assistant and Codex CLI for coding tasks on the same project. Both should read from and write to the same memory.

**Setup:**

```bash
cd ~/Code/my-project
agenr init --platform openclaw
```

The `AGENTS.md` file is shared -- both OpenClaw and Codex read it.

**How they share memory:**

Both platforms connect to the same agenr MCP server, which reads the same `.agenr/config.json` and the same `~/.agenr/knowledge.db`. The `project` field in config scopes recall and default store operations to the same project slug.

**Watch out for:**

- Concurrent writes are safe. SQLite handles locking. But if OpenClaw and Codex store the same fact independently, you get two entries until consolidation merges them.

---

### Scenario 4: Codex only (no OpenClaw)

Codex CLI reads `AGENTS.md` and uses project `.mcp.json`.

**Setup:**

```bash
cd ~/Code/my-project
agenr init --platform codex
```

**What happens:**

- System prompt block appended to `AGENTS.md`
- MCP config written to `.mcp.json`

**Watch out for:**

- For watcher mode, use `agenr watch --platform codex` if auto-detection picks a different platform.

---

### Scenario 5: Multiple repos (polyrepo)

Multiple independent repos, each with its own project memory. A web app and a mobile app that don't share context.

**Setup:**

```bash
cd ~/Code/web-app
agenr init

cd ~/Code/mobile-app
agenr init
```

Each gets its own `.agenr/config.json` with a different project slug (`web-app`, `mobile-app`). Each scopes recall and store to its own slug.

**How scoping works:**

When an agent in `web-app` calls `agenr_recall`, results are filtered to `project = 'web-app'`. It never sees `mobile-app` entries. Same in reverse.

All entries live in the same `~/.agenr/knowledge.db` file. Project scoping is a filter, not a separate database.

**Watch out for:**

- If you want to search across all projects, the agent can pass `project="*"` to `agenr_recall`. But the system prompt instructs project-scoped recall by default.
- Project slugs are derived from directory names. If two repos have the same directory name on different paths, they'll collide. Use `--project` to set explicit slugs.

---

### Scenario 6: Dependent repos

Your frontend depends on your api-service. When working in frontend, you want the agent to also recall decisions from api-service (API contracts, auth flows, etc.).

**Setup:**

```bash
# Initialize api-service first
cd ~/Code/api-service
agenr init

# Initialize frontend with a dependency
cd ~/Code/frontend
agenr init --depends-on api-service
```

**What happens:**

`frontend/.agenr/config.json`:

```json
{
  "project": "frontend",
  "platform": "claude-code",
  "projectDir": "/Users/you/Code/frontend",
  "dependencies": ["api-service"]
}
```

When the agent in `frontend` calls `agenr_recall`, it searches entries where `project IN ('frontend', 'api-service')`.

When it calls `agenr_store`, entries are tagged `project = 'frontend'` only. Dependencies are read-only -- you recall from them but don't write to them.

**Watch out for:**

- Dependencies are **not transitive**. If `api-service` depends on `shared-lib`, and `frontend` depends on `api-service`, the frontend agent does NOT see `shared-lib` entries. You must add it explicitly: `--depends-on api-service,shared-lib`.
- The dependency slug must match the other project's slug exactly. If `api-service` was initialized with `--project api`, use `--depends-on api`.
- Adding dependencies later is safe: `agenr init --depends-on api-service,shared-lib`. It merges into the existing config without touching other fields.

---

### Scenario 7: Monorepo

One repo, one `agenr init` at the root. All agents working in the monorepo share a single project scope.

**Setup:**

```bash
cd ~/Code/monorepo
agenr init
```

**That's it.** Everything under the monorepo root shares one project slug.

**Watch out for:**

- There's no sub-project scoping within a monorepo in v0.7.1. If your monorepo has `packages/frontend` and `packages/api`, both agents see all entries. This is usually fine -- monorepo teams share context.
- If you need isolation between packages, treat them as a polyrepo setup (Scenario 5 or 6) by running `agenr init` in each package directory separately. But then MCP configs and instructions files need to exist per-package, which may not match your workflow.

---

### Scenario 8: Multiple agents, same project

Two Codex sessions running simultaneously on the same repo. Or Claude Code and Cursor both open.

**How it works:**

All agents connect to the same `~/.agenr/knowledge.db` via separate MCP server processes. SQLite handles concurrent reads safely. Writes use WAL mode and are serialized by SQLite's locking.

**Setup:**

No extra setup. Run `agenr init` once. Each agent session spawns its own MCP server process, but they all read the same config and database.

**Watch out for:**

- Two agents may store the same fact independently. This is fine -- consolidation (`agenr consolidate`) merges near-duplicates.
- Recall results are eventually consistent. If Agent A stores a decision, Agent B sees it on its next `agenr_recall` call (no caching in the MCP server).
- High-frequency concurrent writes (dozens per second) could hit SQLite lock contention. In practice, agents store a few entries per session, so this is not a real issue.

---

## What Works, What Doesn't (Honest Limitations)

| Setup | Status | Notes |
|-------|--------|-------|
| Single project, Claude Code | Works | Fully auto-detected and configured |
| Single project, Cursor | Works | Auto-detected, uses `.cursor/mcp.json` |
| Single project, Windsurf | Works | Auto-detected |
| Single project, OpenClaw | Works | Uses `AGENTS.md` + `.mcp.json` |
| Single project, Codex CLI | Works | Uses `AGENTS.md` + `.mcp.json` |
| Polyrepo, independent | Works | Each project scoped separately |
| Polyrepo, with dependencies | Works | `--depends-on` flag, non-transitive |
| Monorepo | Works | Single init at root, shared scope |
| Multi-agent concurrent | Works | SQLite handles concurrency |
| Watcher auto-tagging by project | Not yet | Watcher extracts globally; agents tag via `agenr_store` project field |
| Transitive dependencies | Not yet | A depends on B depends on C: A sees B but not C |
| Sub-project scoping in monorepo | Not yet | All packages share one scope |
| Codex session transcript extraction | Works | Watcher supports Codex platform mode |

---

## Gotchas and Common Mistakes

**1. `agenr` binary not in GUI client PATH**

The MCP config uses `"command": "agenr"`. GUI clients like Cursor, Claude Desktop, and Claude Code launch MCP server processes with a restricted PATH that does not inherit from your shell config (`~/.zshrc`, `~/.bashrc`, etc.). If `agenr` is installed under Homebrew, `nvm`, or a local `node_modules/.bin`, the client cannot find it. The server silently fails to start — tools just aren't available, with no error shown. This is the most common first-run failure.

Two forms of the MCP entry:

```json
// Simple — works when agenr is in the client's PATH:
{
  "agenr": {
    "command": "agenr",
    "args": ["mcp"],
    "env": { "AGENR_PROJECT_DIR": "/path/to/project" }
  }
}
```

```json
// Safe — works always (use the full absolute path):
{
  "agenr": {
    "command": "/usr/local/bin/agenr",
    "args": ["mcp"],
    "env": { "AGENR_PROJECT_DIR": "/path/to/project" }
  }
}
```

Find your path:

```bash
which agenr
```

`agenr init` writes the simple form by default. If your config already uses a `mcpServers` wrapper, `agenr init` merges into that shape instead. If MCP tools don't appear after setup, edit `.mcp.json` and replace `"agenr"` with the full absolute path from `which agenr`.

**2. Forgetting `AGENR_PROJECT_DIR` in MCP config**

Without this env var, the MCP server has no way to find `.agenr/config.json`. Project scoping silently falls back to global (all projects). The `agenr init` command sets this automatically in `.mcp.json`.

**3. Dependency slug mismatch**

`--depends-on frontend` only works if the other project was initialized with slug `frontend`. Check with `cat other-project/.agenr/config.json | grep project`.

**4. Running `agenr init` from the wrong directory**

The project slug and `projectDir` come from where you run the command. Running from `~` gives you project slug `jmartin` and a home-directory-scoped project. Always `cd` into the project root first.

**5. Cursor uses a different MCP path**

Cursor reads `.cursor/mcp.json`, not `.mcp.json` at the project root. `agenr init` handles this, but if you're configuring manually, write to the right file.

**6. `.mcp.json` vs `.claude/settings.local.json`**

`.mcp.json` is the current standard for Claude Code MCP config. The old path (`.claude/settings.local.json`) still works but is deprecated. `agenr init` uses `.mcp.json`.

**7. Re-running init is safe, but check the output**

`agenr init` is idempotent. It detects existing markers and config entries. But if you change `--platform` on a re-run, you may end up with agenr blocks in two different instructions files. Clean up the old one manually.

**8. The watcher does not tag entries by project**

Entries extracted by the watcher daemon have no `project` field. Only entries stored directly via `agenr_store` (when the agent follows the system prompt instructions) get project-tagged. This means watcher-extracted entries appear in global recall but not in project-scoped recall.

**9. Dev clone in a differently-named directory gets the wrong project slug**

If you clone the repo to a name other than the intended slug (e.g., `agenr-local` instead of `agenr`), `agenr init` derives the slug from the directory name:

```bash
cd ~/Code/agenr-local
agenr init
# Creates project slug "agenr-local" -- wrong
```

Always pass `--project` explicitly when the directory name doesn't match the intended slug:

```bash
agenr init --project agenr
```

This applies to any project where the directory name and desired slug differ.

**10. Platform auto-detection can misfire — use `--platform` when there's any ambiguity**

Auto-detection checks for marker files in this order: `.claude/` directory → `.cursor/` directory → `AGENTS.md` → `.windsurfrules`. A repo with multiple platform markers (for example both `.cursor/` and `AGENTS.md`) may trigger a different platform than you expect.

```bash
agenr init --platform cursor    # or: claude-code, openclaw, windsurf, codex, generic
```

Note: `codex` is never auto-detected. You must specify it explicitly.

**11. `agenr init` without `--depends-on` does not clear existing dependencies**

Re-running `agenr init` without `--depends-on` leaves the existing `dependencies` array untouched. There is no implicit "clear deps" behavior — omitting the flag means "don't touch deps," not "set deps to empty."

To remove a dependency, edit `.agenr/config.json` directly and remove the entry from the `dependencies` array.

**12. Explicit `project=` on `agenr_recall` silently drops dependency expansion**

If an agent passes `project="frontend"` explicitly to `agenr_recall`, dependency expansion is bypassed entirely. Only `frontend` entries are returned — configured dependencies like `api-service` are ignored. This is by design for targeted queries but is a footgun when used for session-start recall.

For general recall: do NOT pass an explicit `project=` to `agenr_recall`. Let the MCP server read `AGENR_PROJECT_DIR` and auto-include dependencies. Pass `project=` only on `agenr_store` calls to tag writes correctly.

**13. Dependency changes take effect immediately — no restart needed**

The MCP server reads `.agenr/config.json` on every call, not once at startup. Running `agenr init --depends-on new-dep` takes effect on the next tool call with no editor reload required. This is intentional - the server is long-lived and per-call reads are sub-millisecond.

**14. OpenClaw plugin always recalls globally — project scoping does not apply**

The OpenClaw plugin's session-start recall ignores `AGENR_PROJECT_DIR` and always returns entries from all projects. Running `agenr init --platform openclaw` does not scope the plugin's recall to that project. This is a known open gap (tracked post-v0.7.1).

For now: OpenClaw users should accept the global brain model and name entry subjects clearly to distinguish projects. Or narrow recall mid-session with a specific `query=`.

**15. Passive system prompt phrasing means the agent never actually stores anything**

If the system prompt says "you can use `agenr_store`" or "you have access to persistent memory," most agents will acknowledge and then never call it. Passive "you can" language is treated as optional.

The system prompt injected by `agenr init` includes this exact phrase — keep it verbatim:

> After any decision, user preference, lesson learned, or important event, immediately call `agenr_store`. Do not ask — just store it.

**"Do not ask — just store it"** is the load-bearing phrase. Without it, agents wait to be told. If you customize the system prompt block, do not soften this into a suggestion.

**16. Importance defaults differ: schema says 5, coached default is 7 — both are correct**

The `agenr_store` MCP schema declares `importance: { default: 5 }`. The system prompt block coaches agents to use `7` as the normal default, `9` for critical items, `10` sparingly. These are intentionally different numbers serving different purposes:

- Schema default (5): fallback value at the schema validation layer
- Coached default (7): the practical agent default for most entries

Do not change either number to match the other. If agents are storing lots of 5s, the system prompt instructions are not being followed — check that the agenr block was injected correctly by `agenr init`.

---

## What Agents Should (and Should Not) Store

The system prompt block injected by `agenr init` includes these instructions, but here's the full rationale.

### Store

- **Decisions and reasoning** -- "We chose PostgreSQL over MySQL because of JSONB support." The *why* matters as much as the *what*.
- **User preferences** -- "User prefers tabs over spaces." "User wants terse commit messages."
- **Lessons learned** -- "Caching broke when we added multi-tenancy. Need per-tenant cache keys."
- **Important events** -- "Deployed v2.0 to production on Feb 15." "Migrated from AWS to GCP."
- **Todos and action items** -- "Need to add rate limiting before launch."
- **Facts about the project** -- "Auth uses JWTs with 24h expiry." "The API is versioned via URL prefix."

### Do NOT store

- **Secrets or credentials** -- API keys, tokens, passwords. The database is local and unencrypted.
- **Temporary state** -- "Currently debugging a race condition." This is stale in an hour.
- **Verbatim conversation** -- The watcher already captures transcripts. Storing quotes wastes space and creates duplicates.
- **Information already in files** -- If it's in README.md or the codebase, don't duplicate it in memory. Memory is for things that live in conversations, not code.
- **Speculative plans** -- "We might switch to Rust someday." Store decisions, not maybes.

### Importance scale

| Score | When to use |
|-------|------------|
| 1-5 | Rarely. Minor observations, low-value context. |
| 6-7 | Default. Normal decisions, preferences, project facts. |
| 8-9 | Critical decisions, architectural choices, hard-won lessons. |
| 10 | Almost never. "The production database password was reset" level. |

The system prompt sets the default to 7 and tells agents to use 9 for critical items and 10 sparingly. This calibration prevents importance inflation -- if everything is a 10, nothing is.
