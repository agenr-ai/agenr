# Credential Security Architecture

> How Agenr protects user credentials from agents, adapters, and exposure.

## Overview

Agenr sits between AI agents and business services. When an agent executes an action (order food, process a payment), Agenr must authenticate with the target service on behalf of the user. This creates three credential exposure risks:

1. **Agent ↔ Agenr** — The LLM seeing user credentials in its context window
2. **Adapter code** — Adapter TypeScript having direct access to raw tokens
3. **Storage** — Credentials at rest in the database

All three are addressed. A single credential leak destroys trust permanently.

## Design Principles

1. **Credentials never pass through LLMs** — Agents send intent via AGP; Agenr resolves auth server-side
2. **Adapter code never sees raw credentials** — Auth is injected at the HTTP layer by the runtime
3. **Credential storage uses envelope encryption** — Per-user data encryption keys (DEKs) wrapped by AWS KMS
4. **OAuth is the preferred auth pattern** — Agenr is the OAuth client; the user authorizes Agenr
5. **Least privilege** — Adapters can only access auth for their own service, scoped to declared needs
6. **Audit trail** — Every credential access is logged with tamper-evident hash chaining

## Architecture

### System Overview

```
┌──────────┐    AGP     ┌──────────────┐              ┌──────────────────┐
│  Agent   │──────────▶│  Agenr API    │              │  Credential      │
│  (LLM)   │           │  Server       │              │  Vault           │
└──────────┘           └──────┬───────┘              │  (encrypted)     │
                              │                       └────────┬─────────┘
                              ▼                                │
                       ┌──────────────┐    reads vault    ┌────┴────────┐
                       │  Adapter     │◀──────────────────│  Adapter    │
                       │  (untrusted  │    injects auth   │  Runtime    │
                       │   code)      │───────────────────│  (trusted)  │
                       └──────────────┘  via ctx.fetch()  └─────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  External    │
                       │  Service API │
                       └──────────────┘
```

### Layer 1: Agent ↔ Agenr Boundary (AGP)

AGP is the security boundary. An agent sends structured intent:

```
POST /agp/execute
{ "platform": "stripe", "action": "create_payment", "params": { "amount": 1000 } }
```

The agent never handles tokens, keys, or auth headers. It sends structured intent; Agenr resolves everything else. This is Agenr's core value proposition.

### Layer 2: Adapter Context (Opaque Auth Injection)

Adapter code authenticates via a scoped context object rather than accessing credentials directly.

**Insecure pattern (eliminated):**
```typescript
async execute(action: string, params: Record<string, unknown>) {
  const token = this.tokenStore.get(this.userId, 'stripe');
  const res = await fetch('https://api.stripe.com/v1/charges', {
    headers: { Authorization: `Bearer ${token}` }
  });
}
```

**Secure pattern:**
```typescript
async execute(action: string, params: Record<string, unknown>, ctx: AdapterContext) {
  // ctx.fetch auto-injects auth headers — adapter never sees the token
  const res = await ctx.fetch('https://api.stripe.com/v1/charges', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}
```

#### AdapterContext Interface

```typescript
interface AdapterContext {
  /** Authenticated fetch — injects auth headers for this adapter's service */
  fetch(url: string, init?: RequestInit): Promise<Response>;

  /** User ID for this execution (for logging, not for auth) */
  userId: string;

  /** Adapter platform identifier */
  platform: string;

  /** Execution metadata */
  executionId: string;
}
```

**How it works:**
1. Before calling adapter code, the runtime reads the adapter's manifest to determine auth requirements
2. Runtime fetches the user's encrypted credential from the vault and decrypts it via the envelope encryption pipeline
3. Runtime constructs an `AdapterContext` with a `fetch` wrapper that auto-attaches auth headers
4. Adapter receives the context — it can make authenticated calls but never access raw tokens
5. The `fetch` wrapper enforces the domain allowlist (see Layer 5)

#### Auth Injection Strategies

The runtime supports multiple auth injection strategies based on the adapter manifest:

| Strategy | Header Injected | Use Case |
|----------|----------------|----------|
| `bearer` | `Authorization: Bearer <token>` | OAuth2 APIs (Stripe, Square) |
| `api-key-header` | `X-Api-Key: <key>` | API key services |
| `basic` | `Authorization: Basic <base64>` | Basic auth APIs |
| `cookie` | `Cookie: <name>=<value>` | Cookie-auth services |
| `custom` | Configured per-adapter | Non-standard auth |

### Layer 3: Credential Vault

A dedicated, encrypted credential store using envelope encryption with AWS KMS.

#### Encryption Architecture

Agenr uses **envelope encryption** to protect credentials:

1. **AWS KMS** (or a local mock for development) generates and wraps per-user **Data Encryption Keys (DEKs)**
2. Each user's DEK is stored encrypted in the `user_keys` table
3. When a credential is needed, the encrypted DEK is unwrapped via KMS, used to decrypt the credential, then zeroed from memory
4. In development (when `AGENR_KMS_KEY_ID` is not set), a local mock KMS wraps DEKs using a derived key from `AGENR_KMS_MOCK_SECRET`

```
┌─────────┐     GenerateDataKey     ┌───────────┐
│ AWS KMS │ ◀──────────────────────│  Agenr    │
│         │ ──────────────────────▶│  Vault    │
└─────────┘  plaintext DEK +       └───────────┘
             encrypted DEK
                                    encrypted DEK → user_keys table
                                    plaintext DEK → encrypt credential → zero DEK
```

- **Algorithm:** AES-256-GCM
- **DEK size:** 32 bytes (256-bit)
- **IV:** Random 12 bytes per encryption operation
- **Auth tag:** 16 bytes (GCM standard)
- **Memory safety:** Plaintext DEKs and credential buffers are zeroed after use via `zeroFill()`

#### Database Schema

```sql
-- Per-user data encryption keys (wrapped by KMS)
CREATE TABLE user_keys (
  user_id TEXT PRIMARY KEY,
  encrypted_dek BLOB NOT NULL,        -- DEK encrypted by KMS
  kms_key_id TEXT NOT NULL,            -- KMS key ARN used for wrapping
  created_at TEXT NOT NULL,
  rotated_at TEXT                      -- NULL until key rotation
);

-- Encrypted credentials
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,                 -- UUID v4
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,            -- e.g., 'stripe', 'square'
  auth_type TEXT NOT NULL,             -- see Supported Auth Types
  encrypted_payload BLOB NOT NULL,     -- AES-256-GCM ciphertext
  iv BLOB NOT NULL,                    -- 12-byte initialization vector
  auth_tag BLOB NOT NULL,              -- 16-byte GCM authentication tag
  scopes TEXT,                         -- JSON array of OAuth scopes
  expires_at TEXT,                     -- ISO 8601 token expiry (nullable)
  last_used_at TEXT,                   -- updated on each retrieval
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, service_id)
);
```

#### Supported Auth Types

| Auth Type | Description | Credential Payload Fields |
|-----------|-------------|--------------------------|
| `oauth2` | OAuth 2.0 tokens | `access_token`, `refresh_token`, `token_type`, `expires_in` |
| `api_key` | Static API key | `api_key` |
| `cookie` | Session cookie | `cookie_name`, `cookie_value` |
| `basic` | HTTP Basic Auth | `username`, `password` |
| `client_credentials` | OAuth client credentials | `client_id`, `client_secret` |
| `app_oauth` | Platform-level OAuth app credentials (system use) | `client_id`, `client_secret` |

The `app_oauth` type stores Agenr's own OAuth client credentials (client ID and secret) for services like Stripe and Square. These are stored under a reserved system user (`__system__`) and used during OAuth flows and token refresh.

#### Credential Payload (TypeScript)

```typescript
interface CredentialPayload {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  client_id?: string;
  client_secret?: string;
  api_key?: string;
  cookie_name?: string;
  cookie_value?: string;
  username?: string;
  password?: string;
}
```

#### Access Rules

- Only the **Adapter Runtime** reads from the vault (not adapter code, not API responses)
- Vault contents are **never returned in API responses** — endpoints expose connection status only
- Credential writes happen through:
  - **OAuth callback handler** — automatic token storage after user authorization
  - **Manual credential submission** — user provides API key, cookie, or other credentials via the API
- All vault reads update `last_used_at` and are logged to the audit trail

### Layer 4: User Connection Flows

How users connect their service accounts to Agenr.

#### OAuth Services (Stripe, Square, etc.)

```
User clicks "Connect Stripe" in Console
        │
        ▼
GET /connect/stripe?user_id=...
        │
        ▼
Redirect to Stripe OAuth consent screen
        │
        ▼
User authorizes → Stripe redirects to /connect/stripe/callback
        │
        ▼
Agenr exchanges code for tokens → encrypts → stores in vault
        │
        ▼
Console shows "Stripe: Connected ✓"
```

**Implementation details:**
- `GET /connect/:service` — Initiates OAuth flow (generates state, redirects)
- `GET /connect/:service/callback` — Handles OAuth callback (exchanges code, stores tokens); validated via the OAuth state parameter, not user auth
- OAuth state parameter is bound to user session for CSRF protection
- Redirect URIs are derived from `AGENR_BASE_URL`
- Token refresh is handled automatically by the runtime before adapter execution

#### Manual Credential Submission (API Key, Cookie, Basic, Client Credentials)

```
User submits credential via Console or API
        │
        ▼
POST /credentials/:service { auth_type: "api_key", api_key: "..." }
        │
        ▼
Server validates payload → encrypts → stores in vault
        │
        ▼
Response: { "status": "connected", "service": "toast" }
(credential is NEVER returned)
```

The request body is validated per auth type:
- `api_key` requires `api_key`
- `cookie` requires `cookie_name` and `cookie_value`
- `basic` requires `username` and `password`
- `client_credentials` requires `client_id` and `client_secret`

### Layer 5: Execution Scoping & Domain Allowlist

Each adapter declares its requirements in a manifest:

```typescript
interface AdapterManifest {
  platform: string;
  auth: {
    type: 'oauth2' | 'api_key' | 'cookie' | 'basic';
    strategy: 'bearer' | 'api-key-header' | 'basic' | 'cookie' | 'custom';
    scopes?: string[];
    headerName?: string;          // for api-key-header or custom strategy
  };
  allowedDomains: string[];       // e.g., ['api.stripe.com', '*.stripe.com']
}
```

**Enforcement in `ctx.fetch`:**
- Before making any request, the runtime checks the URL against `allowedDomains`
- Requests to non-allowed domains are rejected with an error (not silently dropped)
- This prevents adapter code from exfiltrating credentials to attacker-controlled domains

```typescript
// Runtime enforcement (simplified)
function createScopedFetch(manifest: AdapterManifest, credential: DecryptedCredential) {
  return async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);

    if (!matchesDomain(parsed.hostname, manifest.allowedDomains)) {
      throw new AdapterSecurityError(
        `Domain ${parsed.hostname} not in allowlist for ${manifest.platform}`
      );
    }

    const headers = new Headers(init?.headers);
    injectAuth(headers, manifest.auth, credential);

    return fetch(url, { ...init, headers });
  };
}
```

### Layer 6: Audit Logging

Every credential operation produces a structured, tamper-evident audit log entry.

#### Audit Events

| Action | Trigger |
|--------|---------|
| `credential_stored` | Credential created or updated |
| `credential_retrieved` | Credential decrypted for use |
| `credential_deleted` | User disconnects a service |
| `credential_rotated` | OAuth token refreshed |
| `credential_revoked_by_admin` | Admin revokes a user's credential |
| `dek_generated` | New per-user encryption key created |
| `dek_unwrapped` | User's DEK decrypted via KMS |
| `connection_initiated` | OAuth flow started |
| `connection_completed` | OAuth flow succeeded |
| `connection_failed` | OAuth flow or credential storage failed |

#### Hash Chain Integrity

Audit entries include a `prev_hash` field containing a SHA-256 hash of the previous entry's `id` and `timestamp`. This creates a tamper-evident chain — any insertion, deletion, or modification of log entries breaks the chain and is detectable via the verification endpoint.

```sql
CREATE TABLE credential_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  action TEXT NOT NULL,
  execution_id TEXT,
  ip_address TEXT,
  metadata TEXT,                     -- JSON, with sensitive fields stripped
  timestamp TEXT NOT NULL,
  prev_hash TEXT                     -- SHA-256 chain link
);
```

Sensitive metadata keys (tokens, secrets, passwords) are automatically stripped before storage.

#### Token Refresh

OAuth token refresh is handled automatically when a token is within 5 minutes of expiry:

1. Runtime checks `expires_at` on the credential record
2. If within the refresh window, retrieves the current credential and the service's app OAuth credentials from the vault
3. Sends a `refresh_token` grant to the service's token endpoint
4. Stores the new tokens, replacing the old credential
5. Logs a `credential_rotated` audit event

The token endpoint URL and content type are configured per-service in the adapter manifest's OAuth configuration.

## API Surface

### Credential Endpoints

All credential endpoints require authentication (API key, admin key, or session cookie).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/credentials` | List connected services (status only, no secrets) |
| `POST` | `/credentials/:service` | Submit a credential (API key, cookie, basic, or client credentials) |
| `DELETE` | `/credentials/:service` | Disconnect a service (delete credential) |
| `GET` | `/credentials/:service/activity` | Paginated audit log for a service connection |

### OAuth Connection Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/connect/:service` | Initiate OAuth flow (redirects to provider) |
| `GET` | `/connect/:service/callback` | Handle OAuth callback (validated via state param) |

### Response Formats

**List connections** (`GET /credentials`):
```json
[
  {
    "service": "stripe",
    "auth_type": "oauth2",
    "connected_at": "2026-02-11T13:00:00Z",
    "last_used_at": "2026-02-13T09:30:00Z",
    "expires_at": "2026-02-11T14:00:00Z",
    "status": "connected"
  }
]
```

**Submit credential** (`POST /credentials/:service`):
```json
{ "status": "connected", "service": "toast" }
```

**Activity log** (`GET /credentials/:service/activity`):
```json
{
  "service": "stripe",
  "entries": [
    {
      "id": "...",
      "timestamp": "2026-02-11T13:00:00Z",
      "action": "credential_stored",
      "execution_id": null,
      "metadata": null
    }
  ],
  "has_more": false
}
```

The activity endpoint supports `limit` (max 200) and `before` (ISO 8601 timestamp cursor) query parameters for pagination.

## Authentication

Agenr supports three authentication methods:

1. **Admin API key** — Set via `AGENR_API_KEY` environment variable. Grants full access with `admin` tier and wildcard scopes.
2. **User API keys** — Stored in the `api_keys` table. Scoped to a user with a specific tier and scope set.
3. **Session cookies** — The `agenr_session` cookie (or a session token in the `Authorization` header or `session_token` query parameter) is validated against the `sessions` table. Admin status is determined by email match against `AGENR_ADMIN_EMAILS`.

All three methods are handled by a unified auth middleware. API key authentication checks the `Authorization: Bearer <key>` header or `X-Api-Key` header. A bootstrap mode (`AGENR_ALLOW_UNAUTH_BOOTSTRAP=1`) permits unauthenticated admin access when no API keys exist yet.

## Security Considerations

- **KMS key management:** `AGENR_KMS_KEY_ID` must be set in production (e.g., Fly.io secrets). Without it, the vault falls back to a local mock suitable only for development.
- **Memory hygiene:** All plaintext DEKs and credential buffers are zeroed after use to minimize exposure in memory dumps.
- **Key rotation:** The `user_keys` table includes a `rotated_at` column to support future DEK rotation (re-wrap all user DEKs with a new KMS key).
- **Token refresh concurrency:** The `UNIQUE(user_id, service_id)` constraint on credentials combined with `ON CONFLICT ... DO UPDATE` provides idempotent upserts during concurrent refresh attempts.
- **Audit integrity:** The hash-chain on audit logs enables detection of tampering. The verification endpoint can validate chain integrity globally or per-user.
- **Adapter code review:** Even with `ctx.fetch`, adapters could leak data via `params` or response bodies logged to console — structured logging should redact sensitive fields.
- **Rate limiting:** OAuth flow endpoints are covered by the existing rate limiter.
- **Metadata sanitization:** Audit metadata is automatically scrubbed of keys matching sensitive patterns (tokens, secrets, passwords, API keys) before storage.

---

*Version: 1.0*
*Last updated: February 2026*
