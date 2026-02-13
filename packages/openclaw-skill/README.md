# agenr -- OpenClaw Skill

Connect your [OpenClaw](https://openclaw.ai) agent to real-world businesses
through [Agenr](https://agenr.ai).

## Install

```bash
openclaw skills add agenr
```

## Configure

Set your Agenr API key:

```bash
# In your OpenClaw config or environment
AGENR_API_KEY=ak_test_public_demo  # demo key for testing
```

## What Your Agent Can Do

- Discover businesses and their capabilities
- Browse product catalogs, menus, and availability
- Place orders with human-in-the-loop confirmation and payment
- Track transaction status

## Example

> **You:** "Order me a pizza from Joe's"
>
> **Agent:** *discovers Joe's Pizza, queries the menu, starts an order*
> "Joe's Pizza: 1x Large Pepperoni, $18.95 + tax = $20.51.
> Pay here: https://joes.pizza/checkout/abc123
> Let me know once you have paid!"
>
> **You:** "Paid!"
>
> **Agent:** *confirms the order with the business*
> "Order placed! Pickup in 25 minutes."

## How It Works

This skill wraps the [`@agenr/mcp`](https://www.npmjs.com/package/@agenr/mcp)
server, which speaks the MCP protocol to expose Agenr's four AGP operations
as tools your agent can call.

One skill. Any business. No per-integration setup.
