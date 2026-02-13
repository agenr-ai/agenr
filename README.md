<p align="center">
  <img src="brand/agenr-dark-rounded-512.png" alt="AGENR" width="120">
</p>

<h1 align="center">AGENR</h1>

<p align="center">
  <em>(AY-gen-er)</em><br><br>
  <strong>The trusted gateway between AI agents and the real world.</strong><br>
  One protocol. Three API calls. Any agent, any business.
</p>

<p align="center">
  <a href="https://agenr.ai">Website</a> ·
  <a href="docs/AGP-SPEC.md">Protocol Spec</a> ·
  <a href="https://console.agenr.ai">Console</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Your AI agent can write code, summarize documents, and answer questions. But can it order you lunch? Book a haircut? Process a payment?

AGENR is an open protocol and runtime that lets **any AI agent interact with any real-world business** — through three operations:

```
discover(business)  → What can this business do?
query(business)     → What's available right now?
execute(business)   → Take action — order, pay, book.
```

No per-platform integrations. No growing context windows. Constant cost whether your agent connects to 5 businesses or 500.

## Quick Start

### Try it now (no account needed)

```bash
npm install @agenr/sdk
```

```typescript
import { AgenrClient } from "@agenr/sdk";

const agenr = new AgenrClient({ apiKey: "ak_test_public_demo" });

// Discover what Echo Labs can do
const capabilities = await agenr.discover("echo");
console.log(capabilities.data.services);

// Query the product catalog
const products = await agenr.query("echo", { serviceId: "catalog" });
console.log(products.data.results);

// Prepare an order — returns a confirmation token and summary
const prepared = await agenr.prepare("echo", {
  serviceId: "order",
  items: [{ productId: "echo-widget-1", quantity: 2 }],
});
console.log(prepared.summary);           // order details for user review
console.log(prepared.confirmationToken); // pass back to execute after approval

// User approves → execute with the confirmation token
const order = await agenr.execute(
  "echo",
  { serviceId: "order", items: [{ productId: "echo-widget-1", quantity: 2 }] },
  { confirmationToken: prepared.confirmationToken },
);
console.log(order.data.status); // "completed"
```

Full AGP lifecycle with human-in-the-loop confirmation. Zero signup.

### Connect a real business

Requires Node.js >= 20. Works with pnpm, npm, yarn, or bun.

```bash
git clone https://github.com/agenr-ai/agenr.git
cd agenr && pnpm install && pnpm run dev:local
```

Open the console at `http://localhost:5173`, connect your Stripe test account,
and replace `"echo"` with your business ID.

### Hook up your AI agent

AGENR works with any framework. See the [SDK docs](packages/sdk/README.md)
for tool definitions compatible with OpenAI, Anthropic, LangChain, CrewAI,
and OpenClaw.

## Why AGENR?

**You could build 50 MCP servers for 50 businesses. Or install one Agenr MCP server and connect to all of them.**

MCP is plumbing. AGP is the intelligence layer — discovery hints teach your agent how each business works, without bloating your context window.

**MCP solved reading. AGENR solves doing.**

| | MCP | AGENR (AGP) |
|---|---|---|
| **Purpose** | Read data, call tools | Real-world actions & commerce |
| **Context cost** | Grows with each tool | Constant — always 3 operations |
| **New integration** | Write a server + tools | Generate an adapter |
| **Auth model** | Per-server config | Consumer-first credential vault |

## Zero-Trust Credential Isolation

**Your secrets never touch AI — or even the code AI writes.**

MCP keeps credentials away from the LLM, but the server code still has full access to raw tokens. That's fine when a human wrote the server. It's not fine when AI generates the integration code.

AGENR assumes adapter code is **untrusted by default** — because it is. Auth is injected at the runtime layer, outside the adapter's execution context:

<p align="center">
  <img src="brand/credential-flow.png" alt="Zero-trust credential flow: Agent → AGENR Runtime → Credential Vault → External API" width="800">
</p>

| | MCP Server | AGENR Adapter |
|---|---|---|
| LLM sees credentials | ❌ | ❌ |
| **Integration code** sees credentials | ✅ Yes | ❌ No |
| Code is sandboxed | ❌ Full process | ✅ V8 isolate |
| Network access | Unrestricted | Declared domains only |
| Credential storage | Env vars / config files | Encrypted vault (KMS) |
| Code origin | Hand-written, trusted | AI-generated, untrusted |

- **Adapters call `ctx.fetch()`** — auth headers are injected by the runtime, not the code
- **AI-generated adapter code runs in a V8 sandbox** — no network access except declared domains
- **Credentials are encrypted at rest** with AES-256-GCM, wrapped by AWS KMS hardware keys
- **Three independent systems** must be compromised to expose a single credential
- **Every credential access is audit-logged** with user, service, and timestamp

MCP trusts the server. AGENR trusts nobody.

## How It Works

**Adapters** translate between the universal AGP protocol and each platform's API. Write one manually, or generate one automatically:

```bash
# Point AGENR at any platform — it builds the adapter
agenr generate Chipotle
```

The generator discovers docs, probes endpoints, parses OpenAPI specs, and writes a complete TypeScript adapter. No templates, no boilerplate.

Adapters follow a lifecycle: `sandbox → review → public → archived`. Generate or upload to sandbox, submit for review, promote to public, or archive when retired.

**Safety rails** are built in: spend caps, confirmation tokens, idempotency keys, execution timeouts, and policy enforcement. Your agent can't accidentally spend $10,000.

## Use the SDK

```bash
npm install @agenr/sdk
```

```ts
import { AgenrClient } from "@agenr/sdk";

const agenr = new AgenrClient({ apiKey: process.env.AGENR_KEY });
// baseUrl defaults to https://api.agenr.ai

const capabilities = await agenr.discover("stripe");
const products = await agenr.query("stripe", { action: "list_products" });

// Prepare a payment — get confirmation details for the user
const prepared = await agenr.prepare("stripe", {
  action: "create_payment",
  amount_cents: 2500,
});
// prepared.summary → human-readable description
// prepared.confirmationToken → pass back after user approves

// User approves → execute with confirmation
const payment = await agenr.execute(
  "stripe",
  { action: "create_payment", amount_cents: 2500 },
  { confirmationToken: prepared.confirmationToken },
);
```

Works with any agent framework — OpenAI, Anthropic, LangChain, CrewAI, OpenClaw, or your own.

## Run the Server

```bash
# One command — starts API server + developer console
pnpm run dev:local
```

- **API** at `http://localhost:3001`
- **Console** at `http://localhost:5173`
- Local SQLite, mock KMS — zero external dependencies for dev

See [Environment Variables](#environment-variables) for production configuration.

## The Protocol (AGP)

The **Agent Gateway Protocol** is a simple REST interface. Full spec: [`docs/AGP-SPEC.md`](docs/AGP-SPEC.md)

Every response is wrapped in a transaction envelope:

```json
{
  "transactionId": "uuid",
  "status": "succeeded",
  "data": { ... }
}
```

Core endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/agp/discover` | Business capabilities |
| `POST` | `/agp/query` | Available inventory/catalog |
| `POST` | `/agp/execute/prepare` | Get confirmation token |
| `POST` | `/agp/execute` | Take action |
| `GET` | `/agp/status/:id` | Transaction status |

See the [full API reference](docs/AGP-SPEC.md) for credential, adapter lifecycle, OAuth, API key, audit, and business management endpoints.

## Architecture

```
src/
├── adapters/       # AGP adapter interface & types
├── connections/    # OAuth base URL + state management
├── core/           # AGP service + adapter registry
├── db/             # libSQL client + migrations
├── vault/          # Credential vault (AES-256-GCM + KMS)
├── middleware/     # Auth, CORS, rate limiting, logging
├── routes/         # HTTP handlers
└── index.ts        # Hono server

console/            # Developer console (React + Vite + Tailwind)
packages/sdk/       # @agenr/sdk TypeScript client
packages/mcp/       # @agenr/mcp MCP server package (stdio transport)
packages/openclaw-skill/ # @agenr/openclaw-skill metadata package
site/               # Landing page
docs/               # Protocol spec + guides
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `AGENR_API_KEY` | — | Admin API key |
| `AGENR_DB_URL` | `file:data/agenr.db` | Database URL (SQLite or Turso) |
| `AGENR_KMS_KEY_ID` | — | AWS KMS key for credential encryption (unset = mock) |
| `AGENR_BASE_URL` | `http://localhost:${PORT}` | Public API URL (for OAuth callbacks) |
| `AGENR_ADAPTERS_DIR` | `data/adapters` | Runtime adapter directory |
| `AGENR_BUNDLED_ADAPTERS_DIR` | `data/adapters` | Bundled adapter source directory seeded on startup |
| `AGENR_EXECUTE_POLICY` | `confirm` | `open` · `confirm` · `strict` |
| `AGENR_CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `CONSOLE_ORIGIN` | `http://localhost:5173` | Console URL for auth redirects |

See [`.env.example`](.env.example) for the full list.

## Deployment

AGENR runs on [Fly.io](https://fly.io) with [Turso](https://turso.tech) for the database and [AWS KMS](https://aws.amazon.com/kms/) for credential encryption.

```bash
bun run deploy:staging      # Deploy to staging
bun run deploy:production   # Deploy to production (requires clean git)
```

## Contributing

We'd love your help.

- **Add an adapter** — `agenr generate <platform>`, refine, submit a PR
- **Improve the protocol** — Open an issue with your use case
- **Build on the SDK** — Tell us what's missing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details. Security issues → [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

The AGP specification is open and free to implement.

---

<p align="center">
  <a href="https://agenr.ai">agenr.ai</a> · <a href="https://x.com/agenr_ai">@agenr_ai</a>
</p>
