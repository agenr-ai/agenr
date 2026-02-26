# AGENR Setup Scenarios

## Quick Start

```bash
pnpm install -g agenr
agenr init
```

The wizard walks you through auth setup, platform detection, project naming, session ingestion, and watcher daemon installation. One command, fully interactive.

**Non-interactive mode** (CI, scripting, or when you know what you want):

```bash
agenr setup                          # configure LLM provider + embeddings
cd ~/Code/my-project
agenr init --platform cursor --project my-project
```

CLI flags bypass the wizard entirely. The same `init` logic runs, just without prompts.

---

## How It Works

`agenr init` does three things, then optionally four more:

1. **Init** - Creates `.agenr/config.json` (per-repo platforms) or registers in the global projects map at `~/.agenr/config.json` (OpenClaw, Codex). Adds `.agenr/knowledge.db` to `.gitignore` where appropriate.

2. **Instruct** - Appends a system prompt block (wrapped in `<!-- agenr:start -->` / `<!-- agenr:end -->` markers) to your platform's instructions file. The block is idempotent - re-running `agenr init` updates it, never duplicates it.

3. **Connect** - Writes or merges an MCP server entry into your platform's config file so the agent can call `agenr_recall` and `agenr_store` as tools.

For **managed platforms** (OpenClaw, Codex), the wizard continues with:

4. **Ingest** - Scans for existing session transcripts, shows cost estimates, and bulk-ingests selected sessions.

5. **Consolidate** - Merges near-duplicate entries created during bulk ingestion.

6. **Watch** - Installs a launchd daemon (macOS) that monitors session transcripts and extracts knowledge automatically on a 120-second interval.

### Per-repo vs managed platforms

- **Per-repo platforms** (Claude Code, Cursor, Windsurf, Generic): Init + Instruct + Connect. Config lives in the project directory.
- **Managed platforms** (OpenClaw, Codex): Full wizard flow. Config is registered in the global projects map at `~/.agenr/config.json`, keyed by directory path.

### Platform file mapping

| Platform | Instructions file | Committed? | MCP config file |
|----------|------------------|------------|-----------------|
| Claude Code | `~/.claude/CLAUDE.md` | No (global user file) | `.mcp.json` |
| Cursor | `.cursor/rules/agenr.mdc` | No (gitignored by `agenr init`) | `.cursor/mcp.json` |
| Codex CLI | `~/.codex/AGENTS.md` | No (global user file) | `~/.codex/config.toml` |
| OpenClaw | Native plugin injection | N/A | Already configured via native plugin |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | No (global user file) | `.mcp.json` |
| Claude Desktop | N/A | N/A | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Generic | `AGENTS.md` | Project file (not auto-gitignored) | `.mcp.json` |

---

## Scenarios

### Getting Started

#### 1. First-time setup (wizard walkthrough)

You've never used agenr before. Run the wizard and it handles everything.

**Setup:**

```bash
pnpm install -g agenr
agenr init
```

**What the wizard does, step by step:**

1. **Auth setup** - Prompts for your LLM provider (OpenAI, Anthropic, etc.), API key, and model selection. Tests the connection before proceeding.
2. **Embeddings** - Checks for an embeddings API key (used for semantic search in recall).
3. **Platform detection** - Auto-detects OpenClaw and Codex installations on your system. If both are found, you choose which to configure.
4. **Directory confirmation** - For OpenClaw, confirms the config directory path (defaults to `~/.openclaw`). Custom paths supported.
5. **DB isolation** - For non-default OpenClaw paths, asks whether to use the shared database (`~/.agenr/knowledge.db`) or an isolated one.
6. **Project naming** - Derives a slug from the directory name and lets you edit it. Warns about slug collisions with existing projects using the same shared database.
7. **Plugin install** - For OpenClaw, installs the agenr plugin and restarts the gateway automatically.
8. **Session scan + cost estimate** - Finds existing session transcripts, shows file count, token estimate, and projected cost. Offers "last 7 days" (recommended), "full history", or "skip".
9. **Bulk ingest** - Runs multi-worker ingestion on selected sessions.
10. **Consolidation** - Merges near-duplicate entries from bulk ingestion.
11. **Watcher daemon** - Installs a launchd service (macOS) for continuous background extraction at 120-second intervals.
12. **Summary** - Shows everything that was configured, plus next steps for anything skipped or failed.

**What you get:**
- A fully wired setup: auth, platform, MCP config, plugin, ingested history, and background watcher - all from one command.

---

#### 2. Solo developer, one project

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

**What you get:**
- Auto-detected platform config and system prompt injection in a single command.
- Agent recalls project-scoped entries at session start and stores new ones automatically.

**Watch out for:**

- `agenr` must be in your PATH **as seen by your editor**. GUI clients use a restricted PATH - if MCP tools don't appear, run `which agenr` and use the full absolute path in `.mcp.json` instead of just `"agenr"`. See Gotcha #1 below.
- The project slug is derived from your directory name. `My Cool Project` becomes `my-cool-project`. You can override: `agenr init --project my-slug`.

---

#### 3. Reconfigure existing setup

You already ran `agenr init` but want to change your model, API key, platform, or project slug.

**Setup:**

```bash
agenr init
```

That's it - same command. The wizard detects your existing configuration and shows it:

```
┌ Current config
│ Provider: openai
│ Model: openai/gpt-4.1-mini
│ Platform: OpenClaw
│ Project: assistant
└
? Reconfigure? No / Yes
```

Each step offers "Keep current" or "Change..." so you only modify what you need. The wizard tracks what changed and shows a summary at the end.

**Re-ingest after model change:**

If you change your auth or model, the wizard offers to re-ingest:

1. Stops the watcher daemon (if running)
2. Resets the knowledge database
3. Re-ingests all sessions with the new model
4. Optionally restarts the watcher

This is useful when upgrading to a better extraction model - the quality difference can be significant.

---

### OpenClaw

#### 4. OpenClaw as a general personal assistant

OpenClaw is used as a daily AI assistant (not scoped to any single codebase). You want agenr as a general memory layer - preferences, facts, decisions - across everything you do.

**Setup:**

```bash
agenr init
```

The wizard detects OpenClaw and walks you through the full flow: auth, project naming, plugin installation, session ingestion, and watcher setup.

For non-interactive setup:

```bash
agenr init --platform openclaw --project assistant
```

Use any slug you like in place of `assistant` (e.g., `personal`, `eja`, your name).

**What happens:**

- The global projects map in `~/.agenr/config.json` gets an entry for your OpenClaw directory.
- The agenr plugin is installed and the gateway is restarted automatically.
- No instructions file is written - the OpenClaw native plugin injects agent instructions at runtime.

**How it works:**

The agent recalls and stores under the `assistant` project scope. Since you're not tied to any codebase, this is a broad, personal brain. Preferences from one conversation surface in the next. Facts you mention today appear in tomorrow's session recall.

**Watch out for:**

- The OpenClaw native plugin handles agent instruction injection automatically. You do not need to add anything to `AGENTS.md`.
- The OpenClaw plugin filters session-start recall signals by importance. Only entries with importance >= 8 (the default signalMinImportance) appear as proactive signals. Entries at importance 5-7 exist in the database but won't surface proactively. Raise importance to 8+ for entries you want the plugin to surface, or lower signalMinImportance in the plugin config.
- This is separate from the coached store default in Gotcha #18. Importance 7 is a reasonable store default; the signal threshold is a separate filter applied only by the OpenClaw plugin at recall time.

---

#### 5. OpenClaw scoped to a specific project

You use OpenClaw as your AI pair while working on a specific codebase (e.g., `my-app`), and you want memory scoped to that project.

**Setup:**

```bash
agenr init --platform openclaw --project my-app
```

Or run `agenr init` interactively and enter `my-app` as the project name when prompted.

**What happens:**

- The global projects map registers this OpenClaw instance with project slug `my-app`.
- The agenr plugin is configured with project scoping. `agenr_store` calls are tagged `project="my-app"` and `agenr_recall` filters to that project automatically.
- If you already have a general assistant setup (Scenario 4), the wizard detects the existing entry and warns about slug collisions if applicable.

**What you get:**
- Project-scoped memory without manual discipline. The global projects map resolves the correct project based on the OpenClaw directory, and the MCP server applies the scope automatically.

**Watch out for:**

- If you use multiple OpenClaw instances (e.g., one for `my-app` and one as a general assistant), use different project slugs and consider DB isolation (see Scenario 6).

---

#### 6. Multi-instance OpenClaw with DB isolation

You run multiple OpenClaw instances - maybe one as a personal assistant and another for a specific project - and want their knowledge databases completely separate.

**Setup:**

```bash
# First instance: general assistant (default path, shared DB)
agenr init --platform openclaw --project assistant

# Second instance: project-specific (custom path, isolated DB)
agenr init --platform openclaw --project my-app
```

During the wizard, when the OpenClaw directory is non-default, you're asked:

```
? Database: use shared brain (~/.agenr/knowledge.db) or isolated?
  > Isolated (separate database for this instance)
    Shared (all instances use the same knowledge)
```

Choosing "Isolated" creates a dedicated database at `<openclaw-dir>/agenr-data/knowledge.db`. The wizard writes this path to the OpenClaw plugin config automatically.

**What you get:**
- Complete data isolation between instances. The personal assistant never sees project entries and vice versa.
- Each instance's DB path is tracked in the global projects map, visible via `agenr init` reconfigure summary.

**Shared vs isolated tradeoffs:**

- **Shared**: All instances can see each other's knowledge (filtered by project tag in recall). Cross-project insights are possible. Simpler to manage.
- **Isolated**: Zero cross-contamination. Each instance has its own database. Better when projects are unrelated or when you want strict separation.

**Watch out for:**

- The wizard warns if two instances share the same project slug AND the same database - entries would be indistinguishable. Either rename one or isolate the DB.
- Isolated databases need their own watcher daemon pointing at the correct sessions directory and `--db` path.

---

#### 7. Re-ingest after model change

You've been using `gpt-4.1-mini` but want to switch to a better model for extraction. Or you changed API providers.

**Setup:**

```bash
agenr init
```

Change your auth or model when prompted. The wizard detects the change and offers:

```
? WARNING: Re-ingest will permanently delete all existing entries.
  > Re-ingest (reset DB + ingest with new model)  recommended
    Keep existing data (new sessions use new model going forward)
```

Choosing re-ingest:

1. Stops the watcher daemon
2. Resets the knowledge database (retirements are preserved via `retirements.json` ledger)
3. Re-runs bulk ingestion with the new model
4. Offers consolidation and watcher restart

**When to do this:**

- Upgrading from a weaker to stronger extraction model (quality improvement can be significant)
- Switching providers (e.g., OpenAI to Anthropic)
- After fixing extraction prompts or calibration

**When NOT to do this:**

- Minor model version bumps (e.g., `gpt-4.1-mini` patch updates) - not worth the cost
- If you have manually curated entries you don't want to lose (they'll be deleted in the reset)

---

### Multi-Platform

#### 8. OpenClaw + Codex (hybrid)

You use OpenClaw as your daily assistant and Codex CLI for coding tasks on the same project. Both should read from and write to the same memory.

**Setup:**

```bash
agenr init
```

The wizard detects both platforms if installed. Choose one to configure first, then run `agenr init` again to add the other. Both register in the global projects map.

For non-interactive setup:

```bash
agenr init --platform openclaw --project my-project
agenr init --platform codex --project my-project
```

**How they share memory:**

Both platforms connect to the same agenr MCP server, which reads the global projects map and resolves to the same database. The `project` field scopes their recall and store operations to the same project slug.

**What you get:**
- Both OpenClaw and Codex read from and write to the same `knowledge.db`, so decisions made in one agent surface in the other.
- The global projects map tracks both registrations with their respective directories.

**Watch out for:**

- Concurrent writes are safe. SQLite handles locking. But if OpenClaw and Codex store the same fact independently, you get two entries until consolidation merges them.
- Each platform needs its own `agenr init` run. The wizard handles one platform at a time.

---

#### 9. Codex only

Codex CLI reads `~/.codex/AGENTS.md` and supports MCP via `~/.codex/config.toml`.

**Setup:**

```bash
agenr init --platform codex
```

Or run the wizard interactively - it detects Codex if the config directory exists.

**What happens:**

- System prompt block appended to `~/.codex/AGENTS.md`
- MCP entry written to `~/.codex/config.toml` with the resolved agenr binary path and `AGENR_PROJECT_DIR`
- Project registered in the global projects map

**What you get:**
- System prompt and MCP config written automatically. Codex stores and recalls project-scoped entries like any other supported platform.

**Watch out for:**

- The watcher daemon does not know where Codex stores session transcripts, so automatic knowledge extraction from Codex sessions does not work yet.
- Codex config is global (`~/.codex/config.toml`). The global projects map tracks which project each directory maps to, but `AGENR_PROJECT_DIR` in the TOML still needs to match your working directory.

---

### Multi-Project

#### 10. Multiple repos (polyrepo)

Multiple independent repos, each with its own project memory. A web app and a mobile app that don't share context.

**Setup:**

```bash
cd ~/Code/web-app
agenr init

cd ~/Code/mobile-app
agenr init
```

Each gets its own `.agenr/config.json` (per-repo platforms) or its own entry in the global projects map (OpenClaw, Codex) with a different project slug (`web-app`, `mobile-app`).

**How scoping works:**

When an agent in `web-app` calls `agenr_recall`, results are filtered to `project = 'web-app'`. It never sees `mobile-app` entries. Same in reverse.

All entries live in the same `~/.agenr/knowledge.db` file (unless you've configured isolated databases). Project scoping is a filter, not a separate database.

For managed platforms (OpenClaw, Codex), the global projects map provides O(1) lookup by directory path using `resolveProjectFromGlobalConfig()`. Multiple instances can share the same project slug if desired.

**What you get:**
- Each repo has its own isolated brain - no cross-contamination between projects.
- Running `agenr init` again in any repo is safe; markers prevent duplication.

**Watch out for:**

- If you want to search across all projects, the agent can pass `project="*"` to `agenr_recall`. But the system prompt instructs project-scoped recall by default.
- Project slugs are derived from directory names. If two repos have the same directory name on different paths, they'll collide. Use `--project` to set explicit slugs.

---

#### 11. Dependent repos

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

When it calls `agenr_store`, entries are tagged `project = 'frontend'` only. Dependencies are read-only - you recall from them but don't write to them.

**What you get:**
- The frontend agent automatically recalls both frontend and api-service entries on every `agenr_recall` call, with no extra steps per session.
- Writes from the frontend agent are tagged to `frontend` only; api-service memory is read-only from the frontend's perspective.

**Watch out for:**

- Dependencies are **not transitive**. If `api-service` depends on `shared-lib`, and `frontend` depends on `api-service`, the frontend agent does NOT see `shared-lib` entries. You must add it explicitly: `--depends-on api-service,shared-lib`.
- The dependency slug must match the other project's slug exactly. If `api-service` was initialized with `--project api`, use `--depends-on api`.
- Adding dependencies later is safe: `agenr init --depends-on api-service,shared-lib`. It merges into the existing config without touching other fields.

---

#### 12. Monorepo

One repo, one `agenr init` at the root. All agents working in the monorepo share a single project scope.

**Setup:**

```bash
cd ~/Code/monorepo
agenr init
```

**That's it.** Everything under the monorepo root shares one project slug.

**What you get:**
- One `agenr init` at the root covers all packages; there is nothing to configure per-package.
- All agents working anywhere in the monorepo see the same stored knowledge - decisions made in one package are visible when working in another.

**What you can't do yet:**
- There is no sub-project scoping within a monorepo; `packages/frontend` and `packages/api` share a single scope with no isolation between them.

**Watch out for:**

- If you need isolation between packages, treat them as a polyrepo setup (Scenario 10 or 11) by running `agenr init` in each package directory separately. But then MCP configs and instructions files need to exist per-package, which may not match your workflow.

---

### Advanced

#### 13. Multiple concurrent agents

Two Codex sessions running simultaneously on the same repo. Or Claude Code and Cursor both open.

**How it works:**

All agents connect to the same `~/.agenr/knowledge.db` via separate MCP server processes. SQLite handles concurrent reads safely. Writes use WAL mode and are serialized by SQLite's locking.

**Setup:**

No extra setup. Run `agenr init` once. Each agent session spawns its own MCP server process, but they all read the same config and database.

**What you get:**
- Multiple concurrent agent sessions read from and write to the same database safely via SQLite WAL mode.
- No extra setup required; each session spawns its own MCP server process automatically and they share state transparently.

**Watch out for:**

- Two agents may store the same fact independently. This is fine - consolidation (`agenr consolidate`) merges near-duplicates.
- Recall results are eventually consistent. If Agent A stores a decision, Agent B sees it on its next `agenr_recall` call (no caching in the MCP server).
- High-frequency concurrent writes (dozens per second) could hit SQLite lock contention. In practice, agents store a few entries per session, so this is not a real issue.

---

#### 14. Cost estimation and selective ingest

Before ingesting a large session history, you want to know what it'll cost.

**How it works:**

The wizard's session scanner counts files and calculates total size. The cost estimator uses per-model token pricing (via `@mariozechner/pi-ai`) to project input token count and dollar cost.

During `agenr init`, you see something like:

```
Found 847 sessions (42 from last 7 days)

Estimated cost with openai/gpt-4.1-mini:
  Last 7 days:  ~180K tokens  ~$0.04
  Full history: ~3.2M tokens  ~$0.72

? Choose ingest scope:
  > Ingest last 7 days ($0.04)  recommended
    Ingest everything ($0.72)   may take a while
    Skip for now
```

**Manual cost check:**

Outside the wizard, you can run ingestion selectively:

```bash
# Ingest only recent sessions
agenr ingest ~/path/to/sessions --bulk --workers 10 --whole-file --platform openclaw --project my-project

# Or specific files
agenr ingest session1.jsonl session2.jsonl --whole-file --platform openclaw
```

**What you get:**
- Transparency on extraction costs before committing.
- Ability to start cheap with recent sessions, then expand later.

---

#### 15. Watcher daemon setup

The watcher monitors session transcript files in the background and extracts knowledge automatically - facts, decisions, preferences, todos, lessons, events - with semantic dedup.

**Setup via wizard:**

During `agenr init`, the wizard offers to install the watcher as a launchd service (macOS):

```
? Set up automatic ingestion? Watches for new sessions and extracts
  knowledge continuously.
  > Yes / No
```

**Manual setup:**

```bash
# Install as launchd daemon (macOS)
agenr watcher install --dir ~/path/to/sessions --platform openclaw --interval 120

# Or run in foreground
agenr watch --dir ~/path/to/sessions --platform openclaw

# Check status
agenr watcher status

# Stop
agenr watcher stop
```

**What you get:**
- Memory accumulates even when the agent forgets to call `agenr_store`.
- 120-second polling interval balances freshness with resource usage.

**Platform support:**
- **macOS**: Full launchd integration via `agenr watcher install`.
- **Linux/Windows**: Not yet supported for daemon install. Run `agenr watch` manually or via your own service manager.

---

## What Works, What Doesn't

| Setup | Status | Notes |
|-------|--------|-------|
| Single project, Claude Code | Works | Fully auto-detected and configured |
| Single project, Cursor | Works | Auto-detected, uses `.cursor/mcp.json` |
| Single project, Windsurf | Works | Auto-detected |
| Single project, OpenClaw | Works | Full wizard flow with plugin install + gateway restart |
| Single project, Codex CLI | Works | Full wizard flow, instructions + MCP config auto-written |
| Single project, Claude Desktop | Partial | MCP config auto, but no instructions file (no project-level prompt) |
| OpenClaw project scoping | Works | Global projects map resolves project by directory |
| Multi-instance DB isolation | Works | Wizard prompts for shared vs isolated on non-default paths |
| Re-ingest on model change | Works | Wizard detects auth/model changes and offers re-ingest |
| Cost estimation before ingest | Works | Token count + dollar estimate shown before ingestion |
| Watcher daemon (macOS) | Works | launchd service with configurable interval |
| Polyrepo, independent | Works | Each project scoped separately |
| Polyrepo, with dependencies | Works | `--depends-on` flag, non-transitive |
| Monorepo | Works | Single init at root, shared scope |
| Multi-agent concurrent | Works | SQLite handles concurrency |
| Watcher daemon (Linux/Windows) | Not yet | Use `agenr watch` manually |
| Transitive dependencies | Not yet | A depends on B depends on C: A sees B but not C |
| Sub-project scoping in monorepo | Not yet | All packages share one scope |
| Codex session transcript extraction | Not yet | Watcher only knows OpenClaw transcript paths |

---

## Gotchas and Common Mistakes

**1. `agenr` binary not in GUI client PATH**

The MCP config uses `"command": "agenr"`. GUI clients like Cursor, Claude Desktop, and Claude Code launch MCP server processes with a restricted PATH that does not inherit from your shell config (`~/.zshrc`, `~/.bashrc`, etc.). If `agenr` is installed under Homebrew, `nvm`, or a local `node_modules/.bin`, the client cannot find it. The server silently fails to start - tools just aren't available, with no error shown. This is the most common first-run failure.

Two forms of the MCP entry:

```json
// Simple - works when agenr is in the client's PATH:
{
  "mcpServers": {
    "agenr": {
      "command": "agenr",
      "args": ["mcp"],
      "env": { "AGENR_PROJECT_DIR": "/path/to/project" }
    }
  }
}
```

```json
// Safe - works always (use the full absolute path):
{
  "mcpServers": {
    "agenr": {
      "command": "/usr/local/bin/agenr",
      "args": ["mcp"],
      "env": { "AGENR_PROJECT_DIR": "/path/to/project" }
    }
  }
}
```

Find your path:

```bash
which agenr
```

`agenr init` resolves the binary path at init time via `process.execPath` and `process.argv[1]`, so the generated MCP entry should work even in restricted-PATH environments. If MCP tools still don't appear, check the generated config and verify the path.

**2. Forgetting `AGENR_PROJECT_DIR` in MCP config**

Without this env var, the MCP server has no way to find `.agenr/config.json`. Project scoping silently falls back to global (all projects). The `agenr init` command sets this automatically in `.mcp.json`, but for manual configs (Codex TOML), you must add it yourself.

**3. Dependency slug mismatch**

`--depends-on frontend` only works if the other project was initialized with slug `frontend`. Check with `cat other-project/.agenr/config.json | grep project`.

**4. Running `agenr init` from the wrong directory**

`agenr init` refuses to run from your home directory and throws:

`Cannot initialize agenr in your home directory. cd into a project directory first, or pass --path <project-dir>.`

**5. Claude Desktop has no instructions file**

`agenr init --platform claude-desktop` writes the MCP config but cannot inject a system prompt. The agent won't know to call `agenr_recall` at session start unless you tell it manually or configure a project-level prompt through another mechanism.

**6. Cursor uses a different MCP path**

Cursor reads `.cursor/mcp.json`, not `.mcp.json` at the project root. `agenr init` handles this, but if you're configuring manually, write to the right file.

**7. `.mcp.json` vs `.claude/settings.local.json`**

`.mcp.json` is the current standard for Claude Code MCP config. The old path (`.claude/settings.local.json`) still works but is deprecated. `agenr init` uses `.mcp.json`.

**8. Re-running init is safe, but check the output**

`agenr init` is idempotent. It detects existing markers and config entries. But if you change `--platform` on a re-run, you may end up with agenr blocks in two different instructions files. Clean up the old one manually.

**9. The watcher does not tag entries by project**

Watcher-extracted entries can be project-tagged when `labelProjectMap` maps the resolved session label to a project. If no mapping is present, entries remain untagged and show up only in global recall. Entries stored directly via `agenr_store` (when the agent follows system prompt instructions) are always project-tagged.

**10. Codex MCP config is global**

Unlike other platforms where MCP config is per-project (`.mcp.json`), Codex uses `~/.codex/config.toml`. The global projects map tracks which directory maps to which project, but the `AGENR_PROJECT_DIR` in the TOML still needs to match your working directory. `agenr init --platform codex` writes the `config.toml` entry automatically using the resolved binary path. When switching between projects, re-run `agenr init --platform codex` from the new project directory to update the TOML.

**11. Dev clone in a differently-named directory gets the wrong project slug**

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

**12. Platform auto-detection can misfire - use `--platform` when there's any ambiguity**

Auto-detection checks for marker files in this order: `.claude/` directory, `.cursor/` directory, `AGENTS.md`, `.windsurfrules`. A repo with multiple platform markers may trigger the wrong detector. The `AGENTS.md` check is existence-only - if an `AGENTS.md` file is present, `openclaw` is returned regardless of file content.

```bash
agenr init --platform cursor    # or: claude-code, openclaw, windsurf, codex, generic
```

Note: `codex` is never auto-detected. You must specify it explicitly.

**13. `agenr init` without `--depends-on` does not clear existing dependencies**

Re-running `agenr init` without `--depends-on` leaves the existing `dependencies` array untouched. Omitting the flag means "don't touch deps," not "set deps to empty."

To remove a dependency, edit `.agenr/config.json` directly and remove the entry from the `dependencies` array.

**14. Explicit `project=` on `agenr_recall` silently drops dependency expansion**

If an agent passes `project="frontend"` explicitly to `agenr_recall`, dependency expansion is bypassed entirely. Only `frontend` entries are returned - configured dependencies like `api-service` are ignored. This is by design for targeted queries but is a footgun when used for session-start recall.

For general recall: do NOT pass an explicit `project=` to `agenr_recall`. Let the MCP server read `AGENR_PROJECT_DIR` and auto-include dependencies. Pass `project=` only on `agenr_store` calls to tag writes correctly.

**15. Dependency changes take effect immediately - no restart needed**

The MCP server reads `.agenr/config.json` on every call, not once at startup. Running `agenr init --depends-on new-dep` takes effect on the next tool call with no editor reload required. This is intentional - the server is long-lived and per-call reads are sub-millisecond.

**16. OpenClaw plugin session-start recall is global**

The OpenClaw plugin's session-start recall returns entries from all projects, not just the configured project scope. Mid-session `agenr_recall` calls respect project scoping via the global projects map, but the initial session-start injection is broader. For now, name entry subjects clearly to distinguish projects, or narrow recall mid-session with a specific `query=`.

**17. Passive system prompt phrasing means the agent never actually stores anything**

If the system prompt says "you can use `agenr_store`" or "you have access to persistent memory," most agents will acknowledge and then never call it. Passive "you can" language is treated as optional.

The system prompt injected by `agenr init` includes this exact phrase - keep it verbatim:

> After any decision, user preference, lesson learned, or important event, immediately call `agenr_store`. Do not ask - just store it.

**"Do not ask - just store it"** is the load-bearing phrase. Without it, agents wait to be told. If you customize the system prompt block, do not soften this into a suggestion.

**18. Importance default is aligned at 7 across schema, coaching, and runtime**

The `agenr_store` MCP schema now declares `importance: { default: 7 }`. The system prompt block coaches agents to use 7 as the normal default; 8 for things an active parallel session would act on right now (8+ fires cross-session signals in OpenClaw - use conservatively); 9 for critical breaking changes or immediate cross-session decisions only (major reversals, breaking API changes, critical blockers discovered - not generically "important things"); and 10 for once-per-project permanent constraints only (core identity rules, never-do-this constraints - at most 1-2 per project lifetime). No more than 20% of stored entries should be 8 or higher.

Runtime behavior now matches that guidance: when MCP clients omit `importance`, `normalizeImportance` also defaults to 7.

For OpenClaw transcript ingestion, extractor prompting is also confidence-aware:
hedged assistant factual claims (for example, "I think", "probably") that are
not tool-verified are tagged `unverified` and capped at importance 5. Verified
assistant claims and all user statements keep normal scoring rules.

Whole-file extraction calibration (from `src/extractor.ts`, used when the extractor sees the full session):
- Typical session: 5-15 entries. Dense sessions may warrant 30-50.
- You are seeing the complete conversation. Extract complete, coherent entries that
  capture multi-part discussions as single entries, not fragments.
- Score 9 or 10: very rare, at most 1 per session, often 0
- Score 8: at most 2-3 per session; ask the cross-session-alert question before assigning
- Score 7: this is your workhorse; most emitted entries should be 7
- Score 6: routine dev observations worth storing
- TODO completion: if a TODO is raised AND completed within this session, emit only
  the completion event - not the original todo.
- If more than 30% of your emitted entries are score 8 or higher, you are inflating.
- Do NOT extract the same fact multiple times even if stated differently in the session.

**19. Gateway restart after plugin config changes**

After `agenr init` modifies the OpenClaw plugin config (e.g., setting an isolated DB path or updating `plugins.allow`), the gateway must be restarted for changes to take effect. The wizard does this automatically, but if you edit plugin config manually, run:

```bash
openclaw gateway restart
```

If `openclaw` is not in PATH (common when running via SSH or cron), use the full path:

```bash
~/Library/pnpm/openclaw gateway restart
```

---

## What Agents Should (and Should Not) Store

The system prompt block injected by `agenr init` includes these instructions, but here's the full rationale.

### Store

- **Decisions and reasoning** - "We chose PostgreSQL over MySQL because of JSONB support." The *why* matters as much as the *what*.
- **User preferences** - "User prefers tabs over spaces." "User wants terse commit messages."
- **Lessons learned** - "Caching broke when we added multi-tenancy. Need per-tenant cache keys."
- **Important events** - "Deployed v2.0 to production on Feb 15." "Migrated from AWS to GCP."
- **Todos and action items** - "Need to add rate limiting before launch."
- **Facts about the project** - "Auth uses JWTs with 24h expiry." "The API is versioned via URL prefix."

### Do NOT store

- **Secrets or credentials** - API keys, tokens, passwords. The database is local and unencrypted.
- **Temporary state** - "Currently debugging a race condition." This is stale in an hour.
- **Verbatim conversation** - The watcher already captures transcripts. Storing quotes wastes space and creates duplicates.
- **Information already in files** - If it's in README.md or the codebase, don't duplicate it in memory. Memory is for things that live in conversations, not code.
- **Speculative plans** - "We might switch to Rust someday." Store decisions, not maybes.

### Importance scale

| Score | When to use |
|-------|-------------|
| 5     | Borderline. Only store if clearly durable beyond today and actionable in a future session. |
| 6     | Routine dev observations: "verified X", "confirmed Y runs", test passes. Cap at 6 unless the result is surprising or breaks something. |
| 7     | Default. Most entries. Project facts, decisions, preferences, completed milestones. No signal fires. |
| 8     | Things an active parallel session would act on right now. Fires a real-time cross-session signal. Ask: "Does another session need this NOW?" If no, use 7. |
| 9     | Critical breaking changes or immediate cross-session decisions only. Major architecture reversals, breaking API changes, critical blockers. At most 1 per significant session. |
| 10    | Once-per-project permanent constraints. "This project must never use GPL-licensed dependencies." At most 1-2 per project lifetime. |

Note: the 1-4 suppression applies to extractor output (`src/extractor.ts`) via the emit floor. Direct `agenr_store` MCP calls accept explicit importance values from 1 to 10.

Platform-aware extractor note: the extractor injects a platform-specific addendum based on the --platform flag:
- openclaw / codex / claude-code: hedged, unverified assistant factual claims are capped at 5 and tagged `unverified`.
- codex / claude-code additionally: confirmed bugs with file/line evidence are stored at importance 8+ with permanent expiry; navigation noise is filtered.
- plaud (meeting transcripts): action items extracted from speaker-labeled lines; higher entry density target (3-8 per chunk); `unverified` tag prohibited.

The system prompt sets the default to 7. In OpenClaw, 8+ fires real-time cross-session signals, so use it conservatively. Reserve 9 for critical breaking changes and immediate decisions only, not for generally important facts. Keep 10 for once-per-project permanent constraints.

Chunked extraction calibration keeps the 20% guardrail for score 8+. Whole-file extraction calibration uses a 30% guardrail. Use the calibration block above for whole-file sessions.
