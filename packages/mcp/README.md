# @agenr/mcp

[![npm version](https://img.shields.io/npm/v/@agenr/mcp)](https://www.npmjs.com/package/@agenr/mcp)
[![license](https://img.shields.io/npm/l/@agenr/mcp)](https://github.com/agenr-ai/agenr/blob/master/LICENSE)

**One MCP server. Any business. No per-integration servers needed.**

An [MCP](https://modelcontextprotocol.io) server that connects any AI agent to real-world businesses through [Agenr](https://agenr.ai). Install once, and your agent can discover, query, and transact with any business on the Agenr network.

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agenr": {
      "command": "npx",
      "args": ["-y", "@agenr/mcp"],
      "env": {
        "AGENR_API_KEY": "ak_test_public_demo"
      }
    }
  }
}
```

Restart Claude Desktop. Ask: *"Discover what Echo Labs can do."*

### Cursor / Windsurf

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agenr": {
      "command": "npx",
      "args": ["-y", "@agenr/mcp"],
      "env": {
        "AGENR_API_KEY": "ak_test_public_demo"
      }
    }
  }
}
```

### OpenClaw

```yaml
mcp:
  agenr:
    command: npx
    args: ["-y", "@agenr/mcp"]
    env:
      AGENR_API_KEY: ak_test_public_demo
```

### Any MCP Client

```bash
AGENR_API_KEY=ak_test_public_demo npx @agenr/mcp
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENR_API_KEY` | -- | Your Agenr API key (`ak_test_public_demo` for testing) |
| `AGENR_BASE_URL` | `https://api.agenr.ai` | API endpoint (override for self-hosted) |

## Tools

| Tool | Description |
|---|---|
| `agenr_discover` | Find out what a business can do |
| `agenr_query` | Browse products, menus, availability |
| `agenr_execute` | Place orders, make payments, book appointments |
| `agenr_status` | Check transaction status |

## How It Works

```
Your Agent  -->  MCP (stdio)  -->  @agenr/mcp  -->  api.agenr.ai  -->  Business APIs
                                    (4 tools)        (AGP protocol)      (via adapters)
```

Traditional approach: build a new MCP server for every business API.

With Agenr: one MCP server, unlimited businesses. Agenr handles credential vaulting, adapter sandboxing, audit logging, and human-in-the-loop confirmation.

## Example Conversation

> **You:** "What can Echo Labs do?"
>
> **Agent** calls `agenr_discover("echo")`
> *"Echo Labs offers a product catalog, ordering, and a ping service."*
>
> **You:** "Show me their products"
>
> **Agent** calls `agenr_query("echo", { serviceId: "catalog" })`
> *"They have Widget ($9.99), Gadget ($24.99), and Pro Plan ($49.99/mo)."*
>
> **You:** "Order 2 widgets"
>
> **Agent** calls `agenr_execute("echo", { serviceId: "order", items: [...] })`
> *"Order confirmed! 2x Widget, $21.63 including tax."*

The Echo adapter is a built-in test business -- no real charges. Real businesses provide actual payment flows.

## Links

- [Agenr](https://agenr.ai) -- homepage
- [TypeScript SDK](https://www.npmjs.com/package/@agenr/sdk) -- use programmatically
- [AGP Spec](https://github.com/agenr-ai/agenr/blob/master/docs/AGP-SPEC.md) -- protocol reference
- [GitHub](https://github.com/agenr-ai/agenr)

## License

MIT
