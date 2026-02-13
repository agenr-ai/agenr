# AI-Generated Adapters

## Overview

Agenr can automatically generate AGP adapters for any platform using AI. Instead of manually writing TypeScript adapters for each business API, you provide a platform name and the system handles the rest — finding API documentation, understanding authentication patterns, generating code, and iterating until it type-checks.

The target experience:

> **"I need an adapter for Stripe"** → working adapter in minutes, not hours.

A human reviews and approves the final result before it goes live.

---

## How It Works

### CLI Generation

```bash
# Generate from platform name (AI discovers the API)
agenr generate "Toast"

# Provide docs URL directly
agenr generate "Toast" --docs-url https://doc.toasttab.com

# Override model or provider
agenr generate "Toast" --model claude-opus-4-6
agenr generate "Toast" --provider openai-api
```

### API Generation

Adapters can also be generated via the HTTP API:

```
POST /adapters/generate
Content-Type: application/json

{
  "platform": "toast",
  "docsUrl": "https://doc.toasttab.com",
  "provider": "codex",
  "model": "gpt-5.2-codex"
}
```

Returns `202 Accepted` with a job ID:

```json
{
  "jobId": "abc-123",
  "platform": "toast",
  "status": "queued",
  "poll": "/adapters/jobs/abc-123"
}
```

Poll `GET /adapters/jobs/:id` to check progress. Generation is rate-limited to **5 jobs per API key per 24 hours** (configurable via `AGENR_GENERATION_DAILY_LIMIT`).

---

## Generation Pipeline

### 1. Discovery Phase

The system runs an agentic discovery process to learn about the platform's API:

- **Web search** for API documentation
- **Fetch and parse** documentation pages
- **LLM analysis** to extract endpoints, auth patterns, request/response shapes, rate limits, and pagination

Discovery results are **cached** per platform. On subsequent runs, the CLI offers to reuse cached findings or rediscover. Use `--rediscover` to force fresh discovery, or `--skip-discovery` to require cached results.

If a `--docs-url` is provided, it's used as the starting point instead of web search.

### 2. Generation Phase

The LLM generates two artifacts from the discovery findings:

1. **Interaction profile** (JSON) — declares the platform's capabilities, endpoints, and auth requirements. Marked with `"method": "ai-generated"`.

2. **Adapter code** (TypeScript) — implements the `AgpAdapter` interface with `discover`, `query`, and `execute` methods. Uses `ctx.fetch()` for all HTTP calls (which handles auth injection automatically). Exports a manifest via `defineManifest()`.

The generation prompt includes:
- The `AgpAdapter` interface (from `adapter-api.ts`)
- A reference adapter as a few-shot example (Stripe)
- The interaction profile schema
- The discovery findings summary

### 3. Verification Phase

Generated code is automatically verified:

1. **Type-check** via `bun run typecheck` (only errors in the generated file are considered failures; pre-existing errors elsewhere are ignored)
2. On failure, errors are fed back to the LLM for self-correction
3. Up to **5 iterations** by default (configurable from 1–10 via `generation.maxIterations`)

If all iterations fail, the system reports the last error and asks for human help.

### 4. Output Phase

On success, the following are created:

- **Adapter file** — TypeScript source at the configured output path
- **Interaction profile** — JSON at `data/interaction-profiles/<platform>.json`
- **User profile update** — the platform is added to `data/user-profile.json` with inferred environment, API URLs, and credential requirements

For API-triggered generation, the adapter is persisted as a **sandbox adapter** (scoped to the requesting API key owner) and hot-loaded into the adapter registry. It can then be submitted for review, and promoted to public by an admin.

---

## Authentication Strategies

Generated adapters declare an auth strategy in their manifest. The generator selects the appropriate strategy based on the platform's API documentation:

| Strategy | When Used | Auth Handling |
|----------|-----------|---------------|
| `oauth2` | Platform uses OAuth 2.0 authorization code flow | Platform handles redirects/tokens; adapter uses `ctx.fetch()` with injected Bearer token |
| `bearer` | User provides an API key or token | `ctx.fetch()` injects Bearer header automatically |
| `api-key-header` | Platform uses a custom header (e.g., `X-Api-Key`) | `ctx.fetch()` injects the configured header |
| `basic` | HTTP Basic authentication | `ctx.fetch()` injects Basic auth |
| `cookie` | Cookie-based authentication | `ctx.fetch()` injects cookies |
| `client-credentials` | Client ID + secret exchanged for access token (e.g., Toast, Twilio) | Adapter manages token exchange via `ctx.getCredential()` and `ctx.fetch()` |
| `custom` | Non-standard auth header | `ctx.fetch()` injects custom header |
| `none` | No authentication required | No auth injection |

---

## LLM Configuration

### Credential Resolution

The generator needs LLM access. Provider selection is explicit (no cross-provider fallback). Default provider is `codex`.

| Priority | Source | Provider | How It Works |
|----------|--------|----------|--------------|
| 1 | **Codex CLI** | OpenAI | Reads `~/.codex/auth.json` or macOS Keychain. OAuth tokens with auto-refresh. |
| 2 | **Claude Code CLI** | Anthropic | Reads `~/.claude/.credentials.json` or macOS Keychain. OAuth tokens with auto-refresh. |
| 3 | **Subscription Token** | Anthropic | `AGENR_LLM_SUBSCRIPTION_TOKEN` env var or `agenr config set subscription-token`. |
| 4 | **OpenAI API Key** | OpenAI | `AGENR_LLM_OPENAI_API_KEY` env var or `agenr config set api-key openai <key>`. |
| 5 | **Anthropic API Key** | Anthropic | `AGENR_LLM_ANTHROPIC_API_KEY` env var or `agenr config set api-key anthropic <key>`. |

For most users with Codex or Claude Code installed, `agenr generate` just works with no setup.

### CLI Configuration

```bash
# Show current LLM configuration
agenr config show

# Set provider
agenr config set provider codex          # Codex CLI OAuth (default)
agenr config set provider claude-code    # Claude Code OAuth
agenr config set provider openai-api     # OpenAI API key
agenr config set provider anthropic-api  # Anthropic API key

# Set model
agenr config set model claude-sonnet-4-5
agenr config set model gpt-4.1

# Set credentials
agenr config set subscription-token sk-ant-oat-...
agenr config set api-key anthropic sk-ant-...
agenr config set api-key openai sk-...

# Per-generation overrides
agenr generate "Toast" --model claude-opus-4-6
agenr generate "Toast" --provider openai-api
```

### Model Aliases

| Alias | Resolves To |
|-------|-------------|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-5` |
| `gpt4` | `gpt-4.1` |
| `codex` | `gpt-5.2-codex` |
| `o3` | `o3` |
| `o4-mini` | `o4-mini` |

### Default Models

When no model is specified:

| Provider | Default Model |
|----------|--------------|
| OpenAI (Codex CLI) | `gpt-5.2-codex` |
| Anthropic (Claude Code) | `claude-opus-4-6` |
| OpenAI (API key) | `gpt-4.1` |

### Configuration File

Stored in `data/agenr-config.json`:

```json
{
  "llm": {
    "provider": "codex",
    "model": null,
    "subscriptionToken": null,
    "apiKeys": {
      "anthropic": null,
      "openai": null
    }
  },
  "generation": {
    "maxIterations": 5,
    "autoVerify": true
  }
}
```

---

## Adapter Lifecycle (API)

Adapters generated via the API follow a lifecycle:

1. **Sandbox** — generated adapter is scoped to the owner, only visible to them
2. **Review** — owner submits for review (`POST /adapters/:platform/submit`)
3. **Public** — admin promotes (`POST /adapters/:platform/promote`), adapter becomes available to all users
4. **Rejected** — admin rejects with feedback (`POST /adapters/:platform/reject`), reverts to sandbox

Adapters can also be uploaded directly (`POST /adapters/:platform/upload`) with source code validation (manifest export, default export, no banned imports, TypeScript syntax check).

---

## Design Principles

1. **API-native only.** Generated adapters use discovered APIs, never browser automation. If an API doesn't exist for an operation, that operation is marked unsupported.

2. **Human-in-the-loop.** AI generates, human approves. No auto-deploying generated code.

3. **Iterate, don't guess.** If generated code doesn't type-check, feed errors back and retry. Don't ship broken code.

4. **Progressive discovery.** Start with web search and docs. Fall back to user-provided information. Always give the user a path forward.

5. **Protocol compliance.** Generated adapters follow the same patterns as hand-built ones — same interface, same auth lifecycle, same transaction tracking. The agent can't tell the difference.

---

## Future Work

- **HAR Import** — Generate adapters from captured browser network traffic for platforms without public APIs
- **Browser Extension** — One-click traffic recording for automatic API discovery
- **Adapter Updates** — Detect when generated adapters break and trigger regeneration
- **Dynamic Registration** — Currently adapters loaded via the registry; exploring plugin directory patterns for self-registration
