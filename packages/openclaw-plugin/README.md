# @agenr/openclaw-plugin

Plugin-only npm package for the agenr OpenClaw memory integration.
This package owns the OpenClaw SDK runtime dependency. The root `agenr` CLI package does not depend on OpenClaw at runtime.

Install it with:

```bash
openclaw plugins install @agenr/openclaw-plugin
openclaw gateway restart
```

The OpenClaw plugin id remains `agenr`, so existing plugin config keys and memory-slot settings stay the same.
