# Model Config Auth Boundary

## Two execution contexts, two config files

agenr tasks run in two distinct execution contexts with different auth systems:

### CLI context (agenr config)

- **Config:** `~/.agenr/config.json` (`AgenrConfig`)
- **Model fields:** `model`, `extractionModel`, `dedupModel`, `episodeModel`, `claimExtraction.model`, `surgeon.model`
- **Auth:** agenr's own credentials - API keys in config, env vars, or external CLI OAuth tokens
- **Code path:** `resolveModel()` -> `createLlmClient()` -> pi-ai direct

### OpenClaw context (plugin config)

- **Config:** `openclaw.json` (`AgenrOpenClawPluginConfig`)
- **Model fields:** `episodeModel`, `continuityModel`, `claimExtractionModel`
- **Auth:** OpenClaw's configured model providers and auth profiles
- **Code path:** `createOpenClawLlmClient()` -> `modelAuth.resolveApiKeyForProvider()` -> pi-ai `completeSimple()`

Note: continuity and episode summaries currently still use the heavier
`resolveOpenClawEmbeddedAgentExecution()` -> `runEmbeddedPiAgent()` path.
Prompt 008 migrates them to `createOpenClawLlmClient`. Claim extraction
already uses the lightweight path.

### Why episodeModel exists in both

Episodes can be generated in either context:

- CLI: `agenr ingest-episodes` - uses agenr auth
- OpenClaw: session-start predecessor processing - uses OpenClaw auth

Each context needs its own model override because the auth is different.

### The rule

If a task runs inside the OpenClaw process, its model override belongs in plugin config.
If a task runs via the CLI, its model override belongs in agenr config.
If a task can run in both contexts, it needs a model override in both configs.
