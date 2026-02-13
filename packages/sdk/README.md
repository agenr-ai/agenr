# @agenr/sdk

[![npm version](https://img.shields.io/npm/v/@agenr/sdk)](https://www.npmjs.com/package/@agenr/sdk)
[![license](https://img.shields.io/npm/l/@agenr/sdk)](https://github.com/agenr-ai/agenr/blob/master/LICENSE)

**Connect your AI agent to any business in 3 lines of code.**

The TypeScript SDK for [Agenr](https://agenr.ai) -- the trust and commerce layer for AI agents. Discover what businesses offer, query their data, and execute real transactions through a single unified protocol ([AGP](https://github.com/agenr-ai/agenr/blob/master/docs/AGP-SPEC.md)).

## Install

```bash
npm install @agenr/sdk
```

## Quick Start

No signup required. Use the public demo key with the built-in Echo adapter:

```ts
import { AgenrClient } from "@agenr/sdk";

const agenr = new AgenrClient({ apiKey: "ak_test_public_demo" });

// What can this business do?
const capabilities = await agenr.discover("echo");

// Browse their catalog
const catalog = await agenr.query("echo", { serviceId: "catalog" });

// Place an order
const order = await agenr.execute("echo", {
  serviceId: "order",
  items: [{ productId: "echo-widget-1", quantity: 2 }],
});
```

That's it. Same three methods work for any business connected to Agenr -- restaurants, retailers, SaaS platforms, anything with an adapter.

## Execute Confirmation

Agenr supports two levels of confirmation to keep humans in the loop before money moves.

### Simple (open policy)

When the server runs with `AGENR_EXECUTE_POLICY=open`, agents call `execute()` directly. If the adapter needs business-level confirmation (e.g. "confirm your payment"), it returns `pending_confirmation` with a token:

```ts
const result = await agenr.execute("echo", {
  serviceId: "order",
  items: [{ productId: "echo-widget-1", quantity: 2 }],
});

if (result.data?.status === "pending_confirmation") {
  const confirmed = await agenr.execute("echo", {
    serviceId: "order",
    items: [{ productId: "echo-widget-1", quantity: 2 }],
    confirmationToken: result.data.confirmationToken,
  });
}
```

<details>
<summary><strong>Full confirmation flow (confirm/strict policy)</strong></summary>

When the server requires API-level confirmation (`AGENR_EXECUTE_POLICY=confirm`), agents must call `prepare()` first to get a confirmation token:

```ts
const request = {
  serviceId: "order",
  items: [{ productId: "echo-widget-1", quantity: 2 }],
};

// 1. Prepare -- get API-level confirmation token
const prepared = await agenr.prepare("echo", request);

// 2. Execute with API confirmation token
const result = await agenr.execute("echo", request, {
  confirmationToken: prepared.confirmationToken,
  idempotencyKey: "order-echo-widget-1-x2",
});

// 3. If adapter also needs confirmation, call execute again
if (result.data?.status === "pending_confirmation") {
  const confirmed = await agenr.execute(
    "echo",
    { ...request, confirmationToken: result.data.confirmationToken },
    {
      confirmationToken: prepared.confirmationToken,
      idempotencyKey: "order-echo-widget-1-x2-confirm",
    },
  );
}
```

</details>

## Use with AI Agent Tools

Wire the SDK into any tool-calling framework:

```ts
const agenr = new AgenrClient({ apiKey: process.env.AGENR_API_KEY });

const tools = [
  {
    name: "discover_business",
    description: "Discover what a business can do",
    handler: ({ businessId }) => agenr.discover(businessId),
  },
  {
    name: "query_business",
    description: "Query business data (catalog, menu, availability)",
    handler: ({ businessId, request }) => agenr.query(businessId, request),
  },
  {
    name: "execute_action",
    description: "Execute a business action (order, book, pay)",
    handler: ({ businessId, request, confirmationToken, idempotencyKey }) =>
      agenr.execute(businessId, request, { confirmationToken, idempotencyKey }),
  },
];
```

Or skip the SDK and use the MCP server: [`@agenr/mcp`](https://www.npmjs.com/package/@agenr/mcp)

## Configuration

```ts
const agenr = new AgenrClient({
  apiKey: "ak_...",           // from agenr.ai (or ak_test_public_demo for testing)
  baseUrl: "https://api.agenr.ai",  // default; override for self-hosted
  headers: { "X-Custom": "value" }, // extra headers on every request
});
```

## API Reference

| Method | Description |
|---|---|
| `discover(businessId)` | What can this business do? |
| `query(businessId, request)` | Browse data (catalog, menu, availability) |
| `execute(businessId, request, options?)` | Take action (order, book, pay) |
| `prepare(businessId, request)` | Get API-level confirmation token |
| `status(transactionId)` | Check transaction status |

### ExecuteOptions

```ts
interface ExecuteOptions {
  confirmationToken?: string; // maps to x-confirmation-token header
  idempotencyKey?: string;    // maps to idempotency-key header
}
```

## Types

```ts
import type {
  AgenrConfig,
  AgpOperation,      // "discover" | "query" | "execute"
  AgpResponse,       // { id, operation, businessId, status, data, ... }
  AgpTransaction,    // same as AgpResponse
  ExecuteOptions,    // { confirmationToken?, idempotencyKey? }
  PrepareResponse,   // { confirmationToken, expiresAt, summary }
  TransactionStatus, // "pending" | "succeeded" | "failed"
} from "@agenr/sdk";
```

## Error Handling

```ts
import { AgenrError } from "@agenr/sdk";

try {
  await agenr.execute("echo", { serviceId: "order" });
} catch (err) {
  if (err instanceof AgenrError) {
    err.statusCode;    // HTTP status
    err.message;       // error message
    err.transactionId; // transaction ID (if available)
    err.response;      // raw response payload
  }
}
```

## Links

- [Agenr](https://agenr.ai) -- homepage
- [AGP Spec](https://github.com/agenr-ai/agenr/blob/master/docs/AGP-SPEC.md) -- protocol reference
- [MCP Server](https://www.npmjs.com/package/@agenr/mcp) -- plug into Claude, Cursor, or any MCP client
- [GitHub](https://github.com/agenr-ai/agenr)

## License

MIT
