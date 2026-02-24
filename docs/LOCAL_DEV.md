# Local Development Setup

This guide covers how to develop and test the agenr OpenClaw plugin locally without publishing to npm.

## Overview

The setup uses a **sandbox OpenClaw instance** running on your machine, completely isolated from any production gateway. It loads the agenr plugin directly from your local build output, so the dev loop is:

1. Edit source code
2. `pnpm build`
3. Restart sandbox
4. Test via webchat at `http://localhost:18790`

No npm publish required.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai) installed globally (`pnpm add -g openclaw`)
- An Anthropic API key (or any supported provider)
- Node.js 24+
- pnpm

## Directory Layout

```
~/Code/agenr/                  # Repo root
  sandbox.sh                   # Convenience launcher script
  dist/                        # Build output (plugin loaded from here)
  src/openclaw-plugin/index.ts # Plugin entrypoint source

~/.openclaw-sandbox/           # Sandbox home (OPENCLAW_HOME)
  .openclaw/
    openclaw.json              # Sandbox gateway config
    agents/main/agent/
      auth-profiles.json       # API key credentials
    agents/main/sessions/      # Session JSONL files (isolated)
  workspace/
    SOUL.md                    # Minimal workspace files
  agenr-data/
    knowledge.db               # Isolated test knowledge DB
```

## First-Time Setup

### 1. Create the sandbox directory structure

```bash
mkdir -p ~/.openclaw-sandbox/.openclaw/agents/main/agent
mkdir -p ~/.openclaw-sandbox/workspace
mkdir -p ~/.openclaw-sandbox/agenr-data
```

### 2. Create the sandbox OpenClaw config

Create `~/.openclaw-sandbox/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6"
      },
      "workspace": "<ABSOLUTE_PATH>/.openclaw-sandbox/workspace",
      "contextTokens": 200000
    }
  },
  "gateway": {
    "port": 18790,
    "mode": "local",
    "bind": "loopback",
    "controlUi": {
      "enabled": true,
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "plugins": {
    "allow": ["agenr"],
    "load": {
      "paths": ["<ABSOLUTE_PATH>/Code/agenr"]
    },
    "entries": {
      "agenr": {
        "enabled": true,
        "config": {
          "dbPath": "<ABSOLUTE_PATH>/.openclaw-sandbox/agenr-data/knowledge.db",
          "sessionsDir": "<ABSOLUTE_PATH>/.openclaw-sandbox/.openclaw/agents/main/sessions"
        }
      }
    }
  }
}
```

Replace `<ABSOLUTE_PATH>` with your actual home directory (e.g. `/Users/yourname`).

**Important:** The `workspace` and `dbPath` values must be absolute paths. Tilde (`~`) expansion can cause double-nesting issues.

### 3. Configure API credentials

Create `~/.openclaw-sandbox/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "token",
      "provider": "anthropic",
      "token": "sk-ant-..."
    }
  },
  "order": {},
  "lastGood": {
    "anthropic": "anthropic:manual"
  }
}
```

### 4. Create a minimal workspace

```bash
echo '# Sandbox Test Agent' > ~/.openclaw-sandbox/workspace/SOUL.md
```

### 5. Add the shell alias

Add this to your `~/.zshrc` (or `~/.bashrc`):

```bash
# agenr sandbox OpenClaw
alias sandbox-openclaw="OPENCLAW_HOME=~/.openclaw-sandbox AGENR_DB_PATH=~/.openclaw-sandbox/agenr-data/knowledge.db openclaw"
```

Then reload: `source ~/.zshrc`

This gives you a `sandbox-openclaw` command that works exactly like `openclaw` but targets the sandbox. Every `openclaw` subcommand works:

```bash
sandbox-openclaw gateway run      # start in foreground
sandbox-openclaw gateway start    # start as service
sandbox-openclaw gateway stop     # stop
sandbox-openclaw gateway restart  # restart
sandbox-openclaw status           # check status
sandbox-openclaw plugins list     # list plugins
sandbox-openclaw doctor           # diagnose issues
sandbox-openclaw logs --follow    # tail logs
```

## Development Workflow

### Build and test

```bash
# 1. Make your changes in src/
# 2. Build
pnpm build

# 3. Start the sandbox in foreground (see logs live)
sandbox-openclaw gateway run

# 4. Open http://localhost:18790 in your browser
# 5. Test your changes via webchat
# 6. Ctrl-C to stop
```

### Quick restart after changes

```bash
pnpm build
# If running in foreground: Ctrl-C, then sandbox-openclaw gateway run
# If running as service: sandbox-openclaw gateway restart
```

### Check sandbox status

```bash
sandbox-openclaw status
```

### View logs

```bash
sandbox-openclaw logs --follow
# or check /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

### Reset sandbox state

To start completely fresh (clear all sessions and memory):

```bash
rm -f ~/.openclaw-sandbox/.openclaw/agents/main/sessions/*.jsonl
rm -f ~/.openclaw-sandbox/agenr-data/knowledge.db*
```

### Inspect the sandbox knowledge DB

```bash
agenr recall --browse --limit 10 --db ~/.openclaw-sandbox/agenr-data/knowledge.db
agenr db stats --db ~/.openclaw-sandbox/agenr-data/knowledge.db
```

## How It Works

### Plugin loading

OpenClaw scans `plugins.load.paths` for plugin entrypoints. Pointing this at the repo root lets OpenClaw discover the plugin via the `openclaw.extensions` field in `package.json`, which resolves to `dist/openclaw-plugin/index.js`.

### Isolation

The sandbox is fully isolated from any production OpenClaw instance:

| Component | Production | Sandbox |
|-----------|-----------|---------|
| Config | `~/.openclaw/openclaw.json` | `~/.openclaw-sandbox/.openclaw/openclaw.json` |
| Sessions | `~/.openclaw/agents/main/sessions/` | `~/.openclaw-sandbox/.openclaw/agents/main/sessions/` |
| Knowledge DB | `~/.agenr/knowledge.db` | `~/.openclaw-sandbox/agenr-data/knowledge.db` |
| Gateway port | 18789 | 18790 |
| Workspace | Your production workspace | `~/.openclaw-sandbox/workspace/` |

### Environment variables

- `OPENCLAW_HOME` - Tells OpenClaw to use the sandbox directory instead of `~`
- `AGENR_DB_PATH` - Fallback DB path (the plugin also reads `dbPath` from its config)

## Global vs Local agenr CLI

If you have agenr installed globally (`pnpm add -g agenr`), running `agenr <command>` in the terminal uses the **global** version, not your local dev build. The sandbox gateway loads the local build via `plugins.load.paths`, but the CLI is a separate codepath.

To test the local CLI:

```bash
# From the repo root (~/Code/agenr)
pnpm exec agenr <command>       # uses local version
node dist/cli.js <command>      # also uses local version
```

To point either at the sandbox DB:

```bash
pnpm exec agenr recall --browse --db ~/.openclaw-sandbox/agenr-data/knowledge.db
```

No conflict - global and local coexist fine. They use different entry points and (with proper `--db` flags) different databases.

## Gotchas

- **Always use absolute paths** in the config for `workspace`, `dbPath`, and `sessionsDir`. Tilde paths can double-nest (`~/.openclaw-sandbox/.openclaw-sandbox/...`).
- **Auth uses `auth-profiles.json`**, not `auth.json`. OpenClaw looks for the profiles format.
- **Session JSONL carries context forward.** If you test with a dirty DB and then switch to a clean one, old context may persist in session files. Delete `*.jsonl` to fully reset.
- **Port conflicts.** If the sandbox won't start, check for zombie processes: `lsof -i :18790` and `kill <pid>`. You can also force-kill with `sandbox-openclaw gateway stop` or just `kill <pid>`.
- **The plugin reads the built `dist/` output.** Always run `pnpm build` before testing. Stale dist is the number one source of "but I changed it" confusion.
- **`sessionsDir` must be set in plugin config.** The plugin defaults to `~/.openclaw/agents/main/sessions` (the production path), not the sandbox home. Without `sessionsDir` in the config, the handoff hooks will fail to find session files and silently skip.
- **Sandbox shares the log file** at `/tmp/openclaw/openclaw-YYYY-MM-DD.log` with any other local OpenClaw instance. Filter by port or timestamps if needed.

## Running Tests (Unit)

Unit tests don't need the sandbox:

```bash
pnpm test        # single run
pnpm test:watch  # watch mode
```

The sandbox is for **integration testing** the full plugin lifecycle against a real OpenClaw gateway.
