# Adapter OAuth Specification

**Version:** 0.2.0  
**Date:** February 13, 2026  
**Status:** Draft  

---

## Overview

AGP uses OAuth 2.0 to connect businesses and consumers to third-party services. Adapters declare their OAuth requirements in their manifest, and the gateway handles the authorization code flow, token exchange, encrypted storage, and automatic refresh.

There are two OAuth patterns:

| | Business-Side OAuth | Consumer-Side OAuth |
|---|---|---|
| **Who authorizes** | Business owner | End user |
| **Credential belongs to** | The business | The user |
| **Example** | Restaurant connects Stripe to accept payments | User connects Stripe to check their balance |
| **Triggered via** | `POST /businesses/:id/connect/:service` | `GET /connect/:service` |

Both patterns use the same platform-level app credentials (client ID / client secret) and the same adapter manifest configuration.

---

## Adapter Manifest: OAuth Configuration

Adapters declare OAuth requirements in their manifest's `auth` block:

```typescript
auth: {
  type: "oauth2",
  strategy: "bearer",
  scopes: ["read_write"],
  oauth: {
    oauthService: "stripe",
    authorizationUrl: "https://connect.stripe.com/oauth/authorize",
    tokenUrl: "https://connect.stripe.com/oauth/token",
    tokenContentType: "form",
    extraAuthParams: {}       // optional additional query params
  },
}
```

### Manifest Fields

| Field | Type | Description |
|---|---|---|
| `auth.type` | `"oauth2"` | Indicates this adapter uses OAuth 2.0 |
| `auth.strategy` | `AuthStrategy` | How credentials are injected into requests (e.g., `"bearer"`) |
| `auth.scopes` | `string[]` | OAuth scopes to request during authorization |
| `auth.oauth.oauthService` | `string` | Groups adapters sharing one OAuth app. All Stripe adapters share one `"stripe"` app credential. Falls back to the adapter platform name if omitted. |
| `auth.oauth.authorizationUrl` | `string` | Provider's authorization endpoint |
| `auth.oauth.tokenUrl` | `string` | Provider's token exchange endpoint |
| `auth.oauth.tokenContentType` | `"form" \| "json"` | Content type for token requests. Defaults to `"form"` (URL-encoded). |
| `auth.oauth.extraAuthParams` | `Record<string, string>` | Additional query parameters appended to the authorization URL |

### Auth Strategies

Supported values for `auth.strategy`:

- `bearer` — Bearer token in `Authorization` header
- `api-key-header` — API key in a custom header
- `basic` — HTTP Basic authentication
- `cookie` — Cookie-based authentication
- `client-credentials` — OAuth 2.0 client credentials grant
- `custom` — Adapter handles auth injection itself
- `none` — No authentication required

---

## App Credentials (Platform-Level)

App credentials identify the AGP platform to an OAuth provider. They are registered once by a platform administrator and shared across all businesses and users connecting to that service.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/app-credentials` | Admin | List all configured app credentials (service name and timestamps only — secrets are never exposed) |
| `POST` | `/app-credentials/:service` | Admin | Create or update app credentials for a service |
| `DELETE` | `/app-credentials/:service` | Admin | Remove app credentials for a service |

### Storage

App credentials are stored in the same encrypted credential vault as user credentials, using the reserved user ID `__system__` and auth type `app_oauth`. This means they benefit from the same envelope encryption (AES-256-GCM with KMS-managed data encryption keys) as all other credentials.

### Example: Register Stripe App Credentials

```bash
curl -X POST https://gateway.example.com/app-credentials/stripe \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clientId": "ca_xxx", "clientSecret": "sk_xxx"}'
```

---

## Consumer OAuth Flow

A consumer connects their own account to a third-party service.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/connect/services` | API key | List available OAuth services (only those with configured app credentials) |
| `GET` | `/connect/:service` | API key | Initiate OAuth authorization redirect |
| `GET` | `/connect/:service/callback` | None | OAuth callback — exchanges code for tokens |

### Flow

1. Client calls `GET /connect/:service` with an API key.
2. The gateway looks up the adapter's OAuth manifest config and the platform's app credentials.
3. A CSRF state token is generated and stored (with expiration).
4. The user is redirected to the provider's authorization URL.
5. After the user authorizes, the provider redirects to `/connect/:service/callback` with an authorization code.
6. The gateway validates the state token, exchanges the code for tokens, and stores the encrypted credential.
7. The user sees a success page and can close the browser tab.

### Token Storage

Tokens are stored in the `credentials` table, keyed by `(user_id, service_id)` with auth type `oauth2`. The credential payload is encrypted with the user's data encryption key (DEK), which is itself wrapped by KMS.

Stored fields:
- `access_token` — The OAuth access token
- `refresh_token` — The OAuth refresh token (if provided)
- `token_type` — Token type (e.g., `"bearer"`)
- `expires_in` — Token lifetime in seconds (used to compute `expires_at`)

---

## Business OAuth Flow

A business owner connects a third-party service to their registered business.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` or `POST` | `/businesses/:id/connect/:service` | API key | Initiate OAuth for a business |
| `GET` | `/businesses/:id/connection-status` | API key | Check if the business has a connected service |
| `GET` | `/businesses/:id/connections` | Admin | List connected services for a business |
| `DELETE` | `/businesses/:id/connections/:service` | Admin | Disconnect a service from a business |

### Flow

1. Business owner calls `GET /businesses/:id/connect/:service`.
2. The gateway verifies the caller owns the business (or is an admin).
3. It resolves the business's platform to an adapter manifest and extracts the OAuth config.
4. The OAuth redirect proceeds identically to the consumer flow.
5. The resulting credential is stored under the **business owner's user ID**, associated with the OAuth service.

### Credential Routing

When an agent queries a business through AGP:

1. The AGP service looks up the business from the database.
2. It determines the business's platform (which adapter to use).
3. It loads the business owner's credentials for that service.
4. The adapter's `ctx.fetch()` injects the business owner's access token into outbound API calls.

> **Note:** Business credentials are currently stored under the business owner's `user_id` in the `credentials` table, not under a separate `business_id`. This means the credential is shared across all businesses owned by the same user on the same platform.

---

## Business Registration

Businesses are registered through the management API before they can connect services.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/businesses` | API key | Register a new business |
| `GET` | `/businesses` | API key | List the caller's businesses (admin can pass `?all=true`) |
| `GET` | `/businesses/:id` | API key | Get business details |
| `PUT` | `/businesses/:id` | API key | Update business (platform cannot be changed) |
| `DELETE` | `/businesses/:id` | API key | Soft-delete a business |

### Data Model

```sql
CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,           -- slug derived from name
  owner_id    TEXT NOT NULL,              -- user who registered this business
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,              -- which adapter this business uses
  location    TEXT,
  description TEXT,
  category    TEXT,
  preferences TEXT,                       -- JSON blob
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK(status IN ('active','suspended','deleted')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

Business IDs are generated as URL-friendly slugs from the name (e.g., `"joes-pizza"`), with a random suffix appended on collision.

### Business Activity

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/businesses/:id/activity` | API key | Paginated audit log of credential events for the business |

Supports `?limit=N` (default 20, max 200) and `?before=<ISO timestamp>` for cursor-based pagination.

---

## Credential Vault

All credentials (user tokens, business tokens, and app credentials) are stored in a single `credentials` table with envelope encryption:

1. **Data Encryption Key (DEK):** A per-user AES-256 key generated via KMS (or a local mock in development). Stored encrypted in the `user_keys` table.
2. **Credential Encryption:** Each credential payload is encrypted with the user's DEK using AES-256-GCM. The IV, ciphertext, and auth tag are stored as BLOBs.
3. **At-Rest Protection:** DEKs are wrapped by KMS. Decrypting a credential requires a KMS call to unwrap the DEK first.

### Credential Table Schema

```sql
CREATE TABLE credentials (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  service_id        TEXT NOT NULL,
  auth_type         TEXT NOT NULL,        -- oauth2, api_key, app_oauth, etc.
  encrypted_payload BLOB NOT NULL,
  iv                BLOB NOT NULL,
  auth_tag          BLOB NOT NULL,
  scopes            TEXT,                 -- JSON array
  expires_at        TEXT,
  last_used_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(user_id, service_id)
);
```

### Token Refresh

OAuth tokens are automatically refreshed when they are within 5 minutes of expiration. The refresh flow:

1. Check `expires_at` against the current time plus a 5-minute window.
2. Decrypt the stored credential to retrieve the `refresh_token`.
3. Call the provider's token endpoint with `grant_type=refresh_token`.
4. Store the new access token (and updated refresh token if rotated).
5. Log a `credential_rotated` audit event.

Refresh requires both the app credentials and an `OAuthRefreshConfig` (token URL and content type) from the adapter manifest.

---

## Audit Trail

Every credential operation is logged to the `credential_audit_log` table with a hash chain for tamper detection.

### Audited Actions

| Action | Trigger |
|---|---|
| `connection_initiated` | User starts an OAuth flow |
| `connection_completed` | OAuth callback succeeds |
| `connection_failed` | OAuth callback fails (user denied, token exchange error, state mismatch) |
| `credential_stored` | Token saved to vault |
| `credential_retrieved` | Token decrypted for use |
| `credential_deleted` | Token removed |
| `credential_rotated` | Token refreshed |
| `credential_revoked_by_admin` | Admin disconnects a business's service |
| `dek_generated` | New data encryption key created |
| `dek_unwrapped` | DEK decrypted via KMS |

Each entry includes: user ID, service ID, timestamp, optional IP address, optional execution ID, and sanitized metadata (sensitive fields like tokens are automatically stripped).

### Hash Chain Verification

Audit entries form a hash chain: each entry stores `prev_hash = SHA-256(previous_id + previous_timestamp)`. The chain can be verified to detect tampering:

```
GET /audit/verify          -- verify entire chain (admin)
GET /audit/verify/:userId  -- verify a user's entries (admin)
```

---

## Security Considerations

- **Credential isolation:** Each user's credentials are encrypted with their own DEK. One compromised DEK cannot decrypt another user's credentials.
- **App credential access:** Only admin-scoped API keys can manage app credentials.
- **Business access control:** Business owners can only manage their own businesses. Admins can manage any business.
- **State token validation:** OAuth state tokens expire and are single-use to prevent CSRF attacks.
- **Sensitive metadata redaction:** Audit log metadata automatically strips fields matching token/secret patterns.
- **Service mismatch detection:** The callback validates that the service in the URL matches the service in the state token.
