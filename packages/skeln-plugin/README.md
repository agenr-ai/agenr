# @agenr/skeln-plugin

Plugin npm package for the agenr Skeln durable-memory integration.

Install it from npm once published, or link it locally from an agenr checkout:

```bash
pnpm link --global ./packages/skeln-plugin
skeln extension add @agenr/skeln-plugin
```

The Skeln extension id is `agenr`. It registers `agenr_store`, `agenr_recall`, `agenr_fetch`, `agenr_update`, `agenr_work`, `get_goal`, `create_goal`, and `update_goal`. Configure `dbPath` and `configPath` in Skeln config when you need non-default agenr storage locations.

Optional `memoryPolicy` accepts a JSON string with the same shape as the OpenClaw agenr plugin `memoryPolicy` block:

```json
{
  "beforeTurn": {
    "enabled": true,
    "procedureSuggestion": false
  },
  "sessionStart": {
    "enabled": false,
    "coreMemory": false,
    "relevantDurableMemory": true
  },
  "workingContext": {
    "enabled": false
  },
  "slotPolicies": {
    "attributeHeads": {
      "preference": "multivalued"
    }
  }
}
```

Set it under `extensions.settings.agenr.memoryPolicy` in Skeln config. Fresh installs via `skeln extension add @agenr/skeln-plugin` seed that default automatically when the setting is unset.

`skeln` is the host runtime for this extension but is not an install-time dependency because the bundled adapter does not import it at runtime. The package declares the non-Skeln runtime dependencies required by the copied agenr dist chunks.

For local development, the agenr repo builds the Skeln adapter against a minimal structural Skeln API contract, so a sibling `skeln` checkout is not required just to install, typecheck, or build agenr. To exercise the extension in Skeln itself, link `@agenr/skeln-plugin` from this checkout and enable it through `extensions.paths` or `skeln extension add` in a Skeln runtime.
