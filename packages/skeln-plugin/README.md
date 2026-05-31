# @agenr/skeln-plugin

Plugin npm package for the agenr Skeln durable-memory integration.

Install it from npm once published, or link it locally from an agenr checkout:

```bash
pnpm link --global ./packages/skeln-plugin
skeln extension add @agenr/skeln-plugin
```

The Skeln extension id is `agenr`. It registers the `agenr_store`, `agenr_recall`, and `agenr_update` tools. Configure `dbPath` and `configPath` in Skeln config when you need non-default agenr storage locations.

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

Set it under `extensions.settings.agenr.memoryPolicy` in Skeln config.

`skeln` is a peer dependency (`>=0.1.0`). The package declares the non-Skeln runtime dependencies required by the copied agenr dist chunks.

For local development across the agenr and skeln repos, keep a sibling `skeln` checkout at `../skeln` (relative to the agenr repo root) so the workspace file links resolve, then link `@agenr/skeln-plugin` from this checkout and enable it through `extensions.paths` or `skeln extension add`.
