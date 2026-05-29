# @agenr/skeln-plugin

Plugin npm package for the agenr Skeln durable-memory integration.

Install it from npm once published, or link it locally from an agenr checkout:

```bash
pnpm link --global ./packages/skeln-plugin
skeln extension add @agenr/skeln-plugin
```

The Skeln extension id is `agenr`. Configure `dbPath` and `configPath` in Skeln config when you need non-default agenr storage locations.

`skeln` is a peer dependency (`>=0.1.0`). The host Skeln runtime resolves `skeln`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `typebox` at extension load time.

For local development across the agenr and skeln repos, keep a sibling `skeln` checkout at `../skeln` (relative to the agenr repo root) so the workspace file links resolve, then link `@agenr/skeln-plugin` from this checkout and enable it through `extensions.paths` or `skeln extension add`.
