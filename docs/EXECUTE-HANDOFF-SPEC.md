# Execute Handoff Pattern — Human-in-the-Loop for Commerce

**Status:** Specification  
**Date:** February 13, 2026  
**See also:** [AGP Specification, Section 8 — Execute Confirmation Flow](AGP-SPEC.md#8-execute-confirmation-flow)

---

## Core Principle

Agents handle everything up to the money. Humans confirm the payment.

AGP never touches credit cards, payment credentials, or sensitive financial data. When an execute operation involves money or irreversible actions, the flow ensures human confirmation before anything is committed.

---

## The Pattern

```
Agent: POST /agp/discover { businessId: "joes-pizza" }
  → Menu items, hours, delivery info

Agent: POST /agp/query { businessId: "joes-pizza", request: { serviceId: "menu" } }
  → Pepperoni Pizza $14.99, Margherita $12.99, ...

Agent: POST /agp/execute/prepare { businessId: "joes-pizza", request: { action: "order", items: [...] } }
  → { confirmationToken: "uuid", expiresAt: "...", summary: "Execute request for business 'joes-pizza' (requested amount: 2998 cents)" }

Agent → Human: "Your order from Joe's Pizza is ready. 2 Pepperoni Pizzas, $29.98. Confirm?"

Human approves → Agent: POST /agp/execute
  Headers: X-Confirmation-Token: <uuid>
  Body: { businessId: "joes-pizza", request: { action: "order", items: [...] } }
  → Transaction result
```

---

## Two Confirmation Layers

AGP supports confirmation at two independent layers. They can be used separately or together.

### 1. Gateway-Level Confirmation (Policy Middleware)

Controlled by the `AGENR_EXECUTE_POLICY` environment variable, this is enforced by the gateway before the request reaches any adapter.

| Policy | Behavior |
|--------|----------|
| `open` (default) | No confirmation required. `X-Confirmation-Token` is ignored. |
| `confirm` | A valid `X-Confirmation-Token` MUST be present. |
| `strict` | Same as `confirm`, plus an amount ceiling check against `AGENR_MAX_EXECUTE_AMOUNT`. |

**Flow:**

```
1. POST /agp/execute/prepare  →  { confirmationToken, expiresAt, summary }
2. Present summary to user for approval
3. POST /agp/execute with X-Confirmation-Token header  →  Transaction result
```

**Token rules:**
- Tokens expire after **5 minutes**
- Tokens are **single-use** — consumed on successful validation
- The token's `businessId` and a SHA-256 hash of the `request` body MUST match the execute payload
- Expired tokens return `403`: *"Confirmation token expired. Prepare a new token."*
- Mismatched tokens return `403`: *"Confirmation token does not match this execute request."*
- Missing tokens (when required by policy) return `403`

**Strict policy amount check:** When policy is `strict`, the middleware reads `amount_cents` or `amount` from the execute request. If the value exceeds `AGENR_MAX_EXECUTE_AMOUNT` (default: 100 cents), the request is rejected with `403`.

### 2. Adapter-Level Confirmation (Handoff Pattern)

Adapters MAY implement their own confirmation flow within the execute response. This is independent of the gateway policy and allows adapters to return action URLs (e.g., hosted payment pages) or their own confirmation tokens.

**Adapter returns a pending confirmation:**

```json
{
  "status": "pending_confirmation",
  "confirmationToken": "adapter-generated-token",
  "summary": { "items": [...], "total": 29.98 },
  "message": "Please confirm this order."
}
```

**Agent re-calls execute with the adapter's token:**

```json
{
  "businessId": "joes-pizza",
  "request": {
    "action": "order",
    "confirmationToken": "adapter-generated-token",
    "items": [...]
  }
}
```

**Adapter returns completed result:**

```json
{
  "status": "completed",
  "orderId": "order-123",
  "receipt": { "total": 29.98, "paidAt": "2026-02-13T19:30:00Z" }
}
```

This pattern is demonstrated by the Echo adapter (see [Echo Adapter Example](#echo-adapter-example) below).

---

## Execute Response Types

### 1. Immediate Success

Read-only or free actions that need no human approval.

```json
{
  "status": "succeeded",
  "data": { ... }
}
```

Examples: bookmark a restaurant, add to wishlist, RSVP to a free event.

### 2. Pending Confirmation (Adapter-Level)

Actions involving money, irreversible changes, or sensitive operations where the adapter requests human approval.

```json
{
  "status": "pending_confirmation",
  "confirmationToken": "string",
  "confirmationUrl": "https://...",
  "summary": "Human-readable description of what will happen",
  "expiresIn": "5 minutes"
}
```

Fields are adapter-defined. Adapters MAY return a `confirmationUrl` (e.g., a Stripe Checkout Session URL) or a `confirmationToken` for a two-step execute flow, or both.

### 3. Error

```json
{
  "status": "error",
  "message": "Restaurant is closed"
}
```

---

## Payment Handoff with Hosted Checkout

When an adapter integrates with a payment processor that supports hosted checkout (Stripe, Square, etc.), it can return a `confirmationUrl` pointing to the provider's payment page:

```typescript
async execute(params, options, ctx) {
  if (params.action === "order") {
    // Create Stripe Checkout Session via the business owner's Stripe account
    const res = await ctx.fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][product_data][name]": "2x Pepperoni Pizza",
        "line_items[0][price_data][unit_amount]": "2998",
        "line_items[0][quantity]": "1",
        success_url: "https://joespizza.com/order-confirmed",
        cancel_url: "https://joespizza.com/order-cancelled",
      }),
    });

    const session = await res.json();
    return {
      status: "pending_confirmation",
      confirmationType: "payment",
      confirmationUrl: session.url,
      summary: "2x Pepperoni Pizza — $29.98",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }
}
```

Key points:
- `ctx.fetch` injects the business owner's credentials (resolved from the vault via the adapter manifest)
- The consumer's card details go to Stripe, never to the gateway or the adapter
- The business gets paid through their own payment processor account
- No PCI scope for the gateway — payment pages are hosted by the processor

---

## Echo Adapter Example

The Echo adapter demonstrates the two-step adapter-level confirmation pattern without any external payment processor:

```
# Step 1: Execute without confirmation token → pending_confirmation
POST /agp/execute
{ "businessId": "echo", "request": { "serviceId": "order", "items": [{ "productId": "echo-widget-1", "quantity": 2 }] } }
→ {
    "status": "pending_confirmation",
    "confirmationToken": "echo-confirm-1707836400000",
    "summary": { "items": [...], "subtotal": 19.98, "tax": 1.65, "total": 21.63 },
    "message": "Please confirm this order."
  }

# Step 2: Execute with confirmation token → completed
POST /agp/execute
{ "businessId": "echo", "request": { "serviceId": "order", "confirmationToken": "echo-confirm-1707836400000", "items": [...] } }
→ {
    "status": "completed",
    "orderId": "echo-order-1707836405000",
    "receipt": { "subtotal": 19.98, "tax": 1.65, "total": 21.63, "paidAt": "..." }
  }
```

The Echo adapter also supports simulation modes for testing:
- `simulate: "failure"` — returns a failed status
- `simulate: "expired"` — returns an expired-token error

---

## Confirmation Types

| Type | When | Example |
|------|------|---------|
| `payment` | Money is involved | Order food, buy tickets, subscribe |
| `approval` | Irreversible action | Cancel subscription, delete account |
| `verification` | Identity/ownership check | Change email, transfer ownership |

These are conventions for adapters. The gateway policy layer treats all execute requests uniformly.

---

## Agent UX Patterns

Agents SHOULD present confirmations naturally:

**Payment (with hosted checkout URL):**
> "I found 2 Pepperoni Pizzas at Joe's for $29.98 + $3.99 delivery. Here's the checkout link when you're ready: [Pay $33.97]"

**Payment (with adapter confirmation token):**
> "Your order from Echo Labs: 2 Widgets for $21.63 including tax. Shall I confirm?"

**Approval:**
> "I can cancel your CloudMetrics subscription. This will take effect immediately and you'll lose access to your dashboards. Confirm here: [Cancel Subscription]"

**Verification:**
> "To change your email, click this verification link: [Verify New Email]"

---

## Why This Matters

### Trust
- The gateway never sees credit card details
- Agents cannot accidentally (or maliciously) charge consumers
- Every payment requires explicit human action

### Compliance
- No PCI scope — payment pages are hosted by Stripe, Square, etc.
- Clear audit trail: agent requested the action, human confirmed
- Clean liability boundary between agent, gateway, and payment processor

### Agent Ecosystem
- Agents fully automate discovery and decision-making
- The only human step is confirming payment — one click or one message
- Works with any payment processor that supports checkout sessions or payment links

---

## SDK Usage

The `@agenr/sdk` maps the gateway-level confirmation flow to two method calls:

```typescript
import { Agenr } from '@agenr/sdk';

const client = new Agenr({ apiKey: 'agenr_paid_...' });

// 1. Prepare: get a confirmation token
const { confirmationToken, expiresAt, summary } = await client.prepare('joes-pizza', {
  action: 'order',
  items: [{ productId: 'pepperoni', quantity: 2 }],
  amount_cents: 2998,
});

// 2. Present summary to user, then execute with the token
const result = await client.execute('joes-pizza', {
  action: 'order',
  items: [{ productId: 'pepperoni', quantity: 2 }],
  amount_cents: 2998,
}, {
  confirmationToken,
  idempotencyKey: 'order-pepperoni-abc123',
});
```

`ExecuteOptions.confirmationToken` is sent as the `X-Confirmation-Token` HTTP header. `ExecuteOptions.idempotencyKey` is sent as the `Idempotency-Key` header. See the [AGP Specification, Section 22](AGP-SPEC.md#22-sdk-reference) for full SDK details.
