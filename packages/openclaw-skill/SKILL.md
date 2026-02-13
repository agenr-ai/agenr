---
name: agenr
description: Connect your agent to real-world businesses through Agenr (order food, make payments, book appointments). Use when the user asks to interact with a business, place an order, or check a transaction.
metadata:
  openclaw:
    emoji: "\U0001F3EA"
    mcp:
      agenr:
        command: npx
        args: ["-y", "@agenr/mcp"]
        env:
          AGENR_API_KEY: "${AGENR_API_KEY}"
          AGENR_BASE_URL: "${AGENR_BASE_URL}"
---

# Agenr -- Agent Commerce

Agenr connects you to real-world businesses. You can discover what businesses
offer, browse their products, and place orders -- all through four MCP tools.

## Setup

Set your API key in the environment:

```bash
export AGENR_API_KEY=ak_your_key_here
```

For testing without an account, use the public demo key:

```bash
export AGENR_API_KEY=ak_test_public_demo
```

The demo key works with the "echo" test business only.

## Tools

You have four tools available via MCP:

| Tool | When to Use |
|---|---|
| `agenr_discover` | First contact with a business -- learn what it can do |
| `agenr_query` | Browse products, menus, availability, pricing |
| `agenr_execute` | Place an order, make a payment, book something |
| `agenr_status` | Check on a pending transaction |

## The Confirmation and Payment Flow (Important!)

When you call `agenr_execute`, most businesses will NOT complete the order
immediately. Instead you get back:

1. `status: "pending_confirmation"` with a `confirmationToken`, order summary,
   and payment details
2. **Present the order summary AND payment information to the user.** The
   response may include:
   - A `paymentUrl` (checkout link) the user must visit to enter payment
   - A `paymentMethods` list if the user has stored payment options
   - Payment instructions specific to the business
3. The order completes only after the user has **actually paid** through the
   business's checkout flow -- not just by saying "yes"
4. After the user confirms they have paid, call `agenr_execute` again with the
   `confirmationToken` to finalize the order. The business verifies payment
   was received before completing.

**Never skip the confirmation step. Never tell the user the order is confirmed
until the business has verified payment. Real money is involved.**

### Example Flow

```
User: "Order me 2 widgets from Echo Labs"

You: call agenr_discover("echo") --> learn available services
You: call agenr_query("echo", { serviceId: "catalog" }) --> see products
You: call agenr_execute("echo", { serviceId: "order", items: [...] })
  --> {
        status: "pending_confirmation",
        confirmationToken: "...",
        summary: { total: 21.63 },
        paymentUrl: "https://checkout.echolabs.com/pay/abc123"
      }

You: "Echo Labs has your order ready:
     - 2x Widget = $19.98
     - Tax = $1.65
     - Total: $21.63

     Complete payment here: https://checkout.echolabs.com/pay/abc123
     Let me know once you have paid and I will finalize the order."

User: "Done, just paid"

You: call agenr_execute("echo", { serviceId: "order", confirmationToken: "..." })
  --> { status: "completed", receipt: { ... } }

You: "All set! Order confirmed. Receipt: 2x Widget, $21.63."
```

Note: The echo test business simulates the payment step -- no real payment is
required. Real businesses will provide actual checkout links or payment flows.

## Tips

- Always `discover` a business before querying or executing. The discover
  response includes a `hints` object with example parameters, typical
  interaction flows, and confirmation details. **Read the hints** -- they
  teach you how to use that specific business well.
- When the user asks about a business you have not discovered yet, discover
  first.
- The `hints.confirmationFlow` field tells you what to expect during checkout
  (payment URL, stored methods, or other flows). Adapt your messaging to match.
- If an execute fails, check the error message. Common issues: expired
  confirmation token (start over), missing required fields, business
  temporarily unavailable.
- The `agenr_status` tool is for checking on transactions that returned a
  transactionId but have not yet resolved. Most transactions resolve
  immediately, so you will rarely need this.

## Available Test Business

- **echo** -- "Echo Labs" test business. Returns fake data for SDK testing.
  Supports the full discover/query/execute/confirm flow. Use with the
  public demo key `ak_test_public_demo`.
