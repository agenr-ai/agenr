# Stripe Quickstart — Spec

The first thing someone runs after cloning the repo. Must be real, not a toy.

## Location

`examples/stripe-quickstart/`

## User Experience

```bash
git clone https://github.com/agenr-ai/agenr
cd agenr
STRIPE_TEST_KEY=sk_test_xxx bun run example
```

That's it. One env var, one command.

## What It Does

1. **Starts local server** — spins up Agenr on `localhost:8787` (mock KMS, SQLite)
2. **Seeds Stripe adapter** — registers the Stripe adapter and creates a local business record
3. **Stores credential** — puts the user's test key in the local vault
4. **Discover** — calls `POST /agp/discover` for the Stripe business, prints available services
5. **Query** — calls `POST /agp/query` to list active products and prices from the user's Stripe account
6. **Execute** — calls `POST /agp/execute` to create a Checkout Session in test mode
7. **Prints results** — clean, readable output showing the full three-operation flow

## Output Should Look Like

```
🏛️  AGENR Stripe Quickstart
━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/4] Starting local server...
  ✓ Server running at http://localhost:8787

[2/4] Discover — what services does Stripe offer?
  ✓ Found 2 services:
    • products — Query the product catalog with prices
    • checkout — Create a checkout session for a product

[3/4] Query — what products are available?
  ✓ Found 3 products:
    • prod_xxx — "Premium Plan" — $29.99
    • prod_yyy — "Starter Plan" — $9.99
    • prod_zzz — "Enterprise" — $99.99

[4/4] Execute — create a checkout session
  ✓ Checkout Session created!
    • Session ID: cs_test_xxx
    • Checkout URL: https://checkout.stripe.com/c/pay/cs_test_xxx

━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Done! Three AGP operations. Real Stripe. Real agent commerce.

Learn more: https://agenr.ai
```

## Requirements

- Stripe account (free) with a test-mode secret key
- No Docker, no external DB, no AWS — everything runs locally
- Mock KMS for local vault (no cloud credentials needed)
- Should work on macOS and Linux
- Bun runtime (already a project dependency)

## Files

- `examples/stripe-quickstart/index.ts` — the main script
- `examples/stripe-quickstart/README.md` — setup instructions (get Stripe test key, run)
- Root `package.json` gets an `"example"` script pointing here

## SDK Usage

The quickstart should use `@agenr/sdk` to make the three AGP calls:

```ts
import { AgenrClient } from "@agenr/sdk";

const agenr = new AgenrClient({
  apiKey: "ak_local_xxx",
  baseUrl: "http://localhost:8787",
});

// 1. Discover services
const discover = await agenr.discover(businessId);
console.log(discover.data.services);

// 2. Query products
const catalog = await agenr.query(businessId, { serviceId: "products" });
console.log(catalog.data.results);

// 3. Execute checkout
const checkout = await agenr.execute(businessId, {
  serviceId: "checkout",
  productId: priceId,
});
console.log(checkout.data);
```

## Key Principles

- **Under 2 minutes** from clone to working demo
- **Real API, real data** — not mocked responses
- **Zero config beyond the Stripe key** — server, DB, vault all handled automatically
- **Clean output** — someone should be able to screenshot this for a tweet
- **The landing page promise, delivered** — discover, query, execute

## Stripe Adapter Details

The Stripe adapter (`data/adapters/stripe.ts`) exposes two services:

| Service ID | Name | Description | Confirmation Required |
|-----------|------|-------------|----------------------|
| `products` | Products | Query the product catalog with prices | No |
| `checkout` | Checkout | Create a checkout session for a product | Yes |

**Query (products):** Fetches active products from `GET /v1/products` and active prices from `GET /v1/prices`, then merges them into a combined result with formatted pricing.

**Execute (checkout):** Creates a Stripe Checkout Session via `POST /v1/checkout/sessions` with a single line item. Returns a `sessionId` and `checkoutUrl`.

> **Note:** The adapter uses OAuth2 bearer auth in production. For the quickstart, the local server injects the test key as a bearer token so the same adapter code works without requiring a full OAuth flow.

## Edge Cases

- If no `STRIPE_TEST_KEY`, print a friendly error with a link to the Stripe dashboard
- If the Stripe account has no products, create a test product and price automatically
- Graceful cleanup — kill server on exit
- If port 8787 is taken, fail fast with a clear message

## Notes

- This is the README's "Quick Start" section come to life
- Demo video should just be a screen recording of running this
- The Stripe adapter is the same one used in production — not a special demo version
