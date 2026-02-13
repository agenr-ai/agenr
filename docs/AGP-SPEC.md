# Agent Gateway Protocol (AGP) Specification

**Version:** 0.1.0-draft  
**Date:** February 13, 2026  
**Author:** Jim Martin  
**Status:** Draft  

---

## Abstract

The Agent Gateway Protocol (AGP) defines a standard HTTP interface for AI agents to discover, query, and execute commercial transactions with real-world businesses. AGP provides constant context cost regardless of how many businesses an agent connects to, and serves as the trust and authorization layer between AI agents and commerce platforms.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [Authentication](#4-authentication)
5. [Common Response Structures](#5-common-response-structures)
6. [AGP Endpoints](#6-agp-endpoints)
7. [Business Directory](#7-business-directory)
8. [Execute Confirmation Flow](#8-execute-confirmation-flow)
9. [Idempotency](#9-idempotency)
10. [Business Management Endpoints](#10-business-management-endpoints)
11. [Credential Management Endpoints](#11-credential-management-endpoints)
12. [OAuth Connection Endpoints](#12-oauth-connection-endpoints)
13. [Adapter Marketplace Endpoints](#13-adapter-marketplace-endpoints)
14. [API Key Management Endpoints](#14-api-key-management-endpoints)
15. [Console Authentication Endpoints](#15-console-authentication-endpoints)
16. [Audit Endpoints](#16-audit-endpoints)
17. [Utility Endpoints](#17-utility-endpoints)
18. [Adapters](#18-adapters)
19. [Error Handling](#19-error-handling)
20. [Security Considerations](#20-security-considerations)
21. [Examples](#21-examples)
22. [SDK Reference](#22-sdk-reference)
23. [Related Specifications](#23-related-specifications)

---

## 1. Introduction

### 1.1 Problem

Every AI agent platform that wants to interact with real-world businesses faces the same challenge: there is no standardized way for an agent to say *"I am acting on behalf of this consumer — let me browse, select, and order."*

Today, each integration is bespoke. Agents scrape websites, reverse-engineer APIs, or rely on brittle browser automation. This does not scale, breaks constantly, and creates adversarial relationships between agents and businesses.

### 1.2 Solution

AGP defines three core operations — **discover**, **query**, and **execute** — that work the same way regardless of the underlying business, platform, or domain. An agent that can speak AGP can interact with a meal delivery service, a hair salon, a restaurant POS, or any other commerce platform through the same interface.

### 1.3 Design Principles

- **Constant context cost.** Whether an agent connects to 5 businesses or 500, the protocol surface is identical.
- **Consumer-first.** Users connect their own business relationships. No merchant onboarding required.
- **Agent-agnostic.** Works with any agent platform — OpenAI, Anthropic, open-source, custom.
- **Graceful degradation.** Not every adapter MUST support all three operations. Partial capability is valid and declared upfront.
- **API-native.** Adapters use official APIs, not browser automation.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Agent** | An AI system making AGP requests on behalf of a consumer. |
| **Business** | A registered entity in Agenr that maps to a real-world business or service. |
| **Platform** | The underlying service provider (e.g., Stripe, Square). |
| **Adapter** | A module that translates AGP operations into platform-specific API calls. |
| **Manifest** | A metadata document declaring an adapter's auth requirements, allowed domains, and capabilities. |
| **Interaction Profile** | A JSON document describing which AGP operations a platform supports. |
| **Transaction** | A recorded AGP operation with a unique ID, status, and result. |
| **Credential** | Authentication material (OAuth token, API key, etc.) stored in the vault for a user–service pair. |
| **Owner** | The user who owns a business record and whose credentials are used for API calls. |
| **Caller** | The authenticated identity making the AGP request (may differ from the owner). |

---

## 3. Protocol Overview

AGP consists of four core endpoints and a public business directory:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/agp/discover` | Required | What can this business do? |
| `POST` | `/agp/query` | Required | What is available right now? |
| `POST` | `/agp/execute/prepare` | Required | Get a confirmation token for an execute |
| `POST` | `/agp/execute` | Required | Perform a transaction |
| `GET` | `/agp/status/:id` | Required | Check transaction status |
| `GET` | `/agp/businesses` | None | Browse the public business directory |

The typical agent workflow is:

```
discover → query → execute/prepare → execute (with confirmation) → status
```

Every AGP operation creates a **Transaction** record that can be retrieved via the status endpoint.

---

## 4. Authentication

Agenr supports multiple authentication methods. All AGP endpoints (except `/agp/businesses` and `/health`) MUST include authentication.

### 4.1 API Key Authentication

Clients MAY authenticate using either header:

- `Authorization: Bearer <key>`
- `X-Api-Key: <key>`

API keys are created via the `/keys` endpoint and have:
- A **tier** (`free` or `paid`) controlling available scopes
- A set of **scopes** controlling which operations are permitted
- An optional link to a **user** for credential resolution

### 4.2 Session Authentication

Browser-based clients MAY authenticate via:
- The `agenr_session` cookie (set during OAuth login)
- `Authorization: Bearer <session_token>`
- Query parameter `?session_token=<token>` (GET requests only)

Session users receive scopes: `discover`, `query`, `execute`, `generate`.
Admin emails (configured via `AGENR_ADMIN_EMAILS`) receive the wildcard scope `*`.

### 4.3 Admin Key

If `AGENR_API_KEY` is set in the environment, presenting that exact value grants admin access with scope `*`.

### 4.4 Bootstrap Mode

When `AGENR_ALLOW_UNAUTH_BOOTSTRAP=1` is set and no API keys exist in the database, unauthenticated requests are granted admin access. This is intended for initial setup only.

### 4.5 Required Scopes

| Endpoint | Required Scope |
|----------|---------------|
| `POST /agp/discover` | `discover` |
| `POST /agp/query` | `query` |
| `POST /agp/execute/prepare` | `execute` |
| `POST /agp/execute` | `execute` |
| `GET /agp/status/:id` | *(any authenticated)* |
| `POST /adapters/generate` | `generate` |
| Admin endpoints | `admin` (or `*`) |

The wildcard scope `*` grants access to all operations.

### 4.6 Identity Resolution for Credentials

When an AGP operation requires platform credentials (e.g., a Stripe access token), the system resolves identity as follows:

1. If the business has a **database owner** (`ownerId`), credentials are resolved from that owner's vault.
2. Otherwise, credentials are resolved from the **caller's** vault (the authenticated user or API key identity).

This means the business owner's credentials are always used, even when a different agent (caller) initiates the request. Cross-user credential isolation is enforced — callers MUST NOT access another user's credentials.

---

## 5. Common Response Structures

### 5.1 Transaction Envelope

All AGP operation responses (`discover`, `query`, `execute`) return a transaction envelope:

```json
{
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "succeeded",
  "data": { ... }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transactionId` | `string` (UUID) | MUST | Unique identifier for this transaction. |
| `status` | `"pending" \| "succeeded" \| "failed"` | MUST | Current transaction status. |
| `data` | `object` | MUST on success | Operation-specific response payload. |

### 5.2 Error Response

Error responses use a structured format:

```json
{
  "error": "Short error description",
  "message": "Detailed human-readable explanation.",
  "code": "ERROR_CODE",
  "requestId": "req-uuid"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error` | `string` | MUST | Brief error description. |
| `message` | `string` | SHOULD | Detailed explanation for developers. |
| `code` | `string` | SHOULD | Machine-readable error code. |
| `requestId` | `string` | SHOULD | Request identifier for debugging. |
| `details` | `object` | MAY | Validation error tree (for `VALIDATION_ERROR`). |

### 5.3 Request ID

Every request is assigned a unique `requestId` (UUID) via the `X-Request-Id` response header. This ID is included in error responses for tracing.

---

## 6. AGP Endpoints

### 6.1 Discover

Retrieves a business's identity, capabilities, consumer preferences, and adapter-provided metadata.

**Request:**

```http
POST /agp/discover
Content-Type: application/json
Authorization: Bearer <key>

{
  "businessId": "string"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `businessId` | `string` | MUST | Business identifier. Min length: 1. |

**Success Response:** `200 OK`

```json
{
  "transactionId": "uuid",
  "status": "succeeded",
  "data": {
    "business": {
      "id": "my-restaurant",
      "name": "Downtown Grill",
      "platform": "square",
      "location": "Austin, TX"
    },
    "preferences": {
      "diet": "keto"
    },
    "capabilities": {
      "discover": {
        "operation": "discover",
        "method": "GET",
        "endpoint": "/v2/locations + /v2/catalog/list",
        "authRequired": true,
        "description": "Fetch locations and catalog overview."
      },
      "query": {
        "operation": "query",
        "method": "POST",
        "endpoint": "/v2/catalog/search",
        "authRequired": true,
        "description": "Search catalog items with filtering."
      },
      "execute": {
        "operation": "execute",
        "method": "POST",
        "endpoint": "/v2/orders",
        "authRequired": true,
        "description": "Create an order draft with line items."
      }
    }
  }
}
```

The `data` object is composed of:
- **`business`** — always present. Contains `id`, `name`, `platform`, and optionally `location`.
- **`preferences`** — present if the business has consumer preferences configured.
- **`capabilities`** — present only if an Interaction Profile exists for the business's platform. Each capability has the shape `{ operation, method, endpoint, authRequired, description }` as defined by the `InteractionCapability` type.
- Additional fields merged from the adapter's `discover()` return value.

**Business Resolution Order:**

1. Database business (by `id`, status MUST be `active`)
2. Profile store (legacy JSON file)
3. Adapter registry (for dynamically generated adapters, matched by platform name as business ID)

### 6.2 Query

Retrieves available items, services, or options from a business. The `request` object is adapter-specific.

**Request:**

```http
POST /agp/query
Content-Type: application/json
Authorization: Bearer <key>

{
  "businessId": "string",
  "request": { ... }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `businessId` | `string` | MUST | Business identifier. |
| `request` | `object` | MUST | Adapter-specific query parameters. |

**Success Response:** `200 OK`

```json
{
  "transactionId": "uuid",
  "status": "succeeded",
  "data": { ... }
}
```

The `data` payload is entirely determined by the adapter. See [Section 21](#21-examples) for domain-specific examples.

### 6.3 Execute Prepare

Creates a confirmation token for a pending execute operation. See [Section 8](#8-execute-confirmation-flow).

**Request:**

```http
POST /agp/execute/prepare
Content-Type: application/json
Authorization: Bearer <key>

{
  "businessId": "string",
  "request": { ... }
}
```

**Success Response:** `200 OK`

```json
{
  "confirmationToken": "uuid",
  "expiresAt": "2026-02-13T19:12:00.000Z",
  "summary": "Execute request for business 'my-restaurant' (requested amount: 1395 cents)"
}
```

### 6.4 Execute

Performs a transaction — places an order, books an appointment, or confirms a selection.

**Request:**

```http
POST /agp/execute
Content-Type: application/json
Authorization: Bearer <key>
Idempotency-Key: optional-unique-key
X-Confirmation-Token: optional-token

{
  "businessId": "string",
  "request": { ... }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `businessId` | `string` | MUST | Business identifier. |
| `request` | `object` | MUST | Adapter-specific execute parameters. |

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Idempotency-Key` | Conditional | Client-supplied idempotency key. The server reads this header and injects the value into `request.idempotencyKey` before passing the request to the adapter. Clients SHOULD use this header (not the request body) to supply idempotency keys. See [Section 9](#9-idempotency). |
| `X-Confirmation-Token` | Conditional | Required when execute policy is `confirm` or `strict`. Ignored when policy is `open`. |

> **Open policy note:** When `AGENR_EXECUTE_POLICY` is `open` (the default), the `X-Confirmation-Token` header is ignored and execute proceeds directly without requiring a prepare step. Agents targeting an open-policy gateway MAY skip the `POST /agp/execute/prepare` step entirely and call `POST /agp/execute` directly.

**Success Response:** `200 OK`

```json
{
  "transactionId": "uuid",
  "status": "succeeded",
  "data": { ... }
}
```

### 6.5 Status

Retrieves the full transaction record for a previously initiated operation.

**Request:**

```http
GET /agp/status/:transactionId
Authorization: Bearer <key>
```

**Success Response:** `200 OK`

Returns the raw stored **transaction record**, which has a different shape from the operation response envelope used by `discover`, `query`, and `execute`:

```json
{
  "id": "uuid",
  "operation": "query",
  "businessId": "my-restaurant",
  "status": "succeeded",
  "createdAt": "2026-02-13T14:00:00.000Z",
  "updatedAt": "2026-02-13T14:00:01.000Z",
  "input": { ... },
  "result": { ... },
  "error": null
}
```

> **Note:** The transaction record uses `id`, `input`, `result`, and `error` fields. This differs from the operation response envelope (returned by `/agp/discover`, `/agp/query`, `/agp/execute`) which uses `transactionId`, `status`, and `data`. Callers should handle both shapes appropriately:
>
> | Field | Operation Envelope | Transaction Record (Status) |
> |-------|-------------------|---------------------------|
> | Transaction ID | `transactionId` | `id` |
> | Payload | `data` | `result` |
> | Error | *(HTTP error response)* | `error` |
> | Request input | *(not included)* | `input` |
> | Timestamps | *(not included)* | `createdAt`, `updatedAt` |

**Ownership:** A caller MUST only retrieve transactions they created. Transactions created by other callers return `404 Transaction not found`.

**Error Response:** `404 Not Found`

```json
{
  "error": "Transaction not found",
  "message": "No transaction exists for the provided ID.",
  "code": "TRANSACTION_NOT_FOUND",
  "requestId": "uuid"
}
```

---

## 7. Business Directory

### 7.1 List Businesses

A public endpoint (no authentication required) that lists active businesses.

**Request:**

```http
GET /agp/businesses?category=restaurant&platform=stripe&q=pizza
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | `string` | MAY | Filter by category (case-insensitive). |
| `platform` | `string` | MAY | Filter by platform (case-insensitive). |
| `q` | `string` | MAY | Search by business name (case-insensitive substring match). |

**Success Response:** `200 OK`

```json
{
  "businesses": [
    {
      "id": "joes-pizza",
      "name": "Joe's Pizza",
      "platform": "square",
      "location": "Austin, TX",
      "category": "restaurant",
      "description": "Best pizza in town"
    }
  ]
}
```

Only businesses with status `active` are returned. Suspended and deleted businesses are excluded.

---

## 8. Execute Confirmation Flow

Agenr supports a confirmation flow to prevent unauthorized or accidental transactions. The behavior is controlled by the `AGENR_EXECUTE_POLICY` environment variable.

### 8.1 Policies

| Policy | Behavior |
|--------|----------|
| `open` (default) | No confirmation required. Execute proceeds directly. `X-Confirmation-Token` is ignored. |
| `confirm` | A valid `X-Confirmation-Token` header MUST be present. |
| `strict` | Same as `confirm`, plus an amount ceiling check. |

### 8.2 Flow

```
1. Agent: POST /agp/execute/prepare
   → { confirmationToken, expiresAt, summary }

2. Agent/UI presents summary to user for approval

3. Agent: POST /agp/execute
   Headers: X-Confirmation-Token: <token>
   Body: { businessId, request }  (must match prepare payload)
   → Transaction result
```

### 8.3 Token Rules

- Confirmation tokens expire after **5 minutes**.
- Tokens are **single-use** — consumed after successful policy validation.
- The token's `businessId` and a SHA-256 hash of the `request` MUST match the execute payload.
- Expired tokens return `403` with message `"Confirmation token expired. Prepare a new token."`
- Mismatched tokens return `403` with message `"Confirmation token does not match this execute request."`
- Missing tokens (when policy requires them) return `403`.

### 8.4 Strict Policy Amount Check

When policy is `strict`, the middleware reads `amount_cents` or `amount` from the execute request. If the value exceeds `AGENR_MAX_EXECUTE_AMOUNT` (default: 100 cents), the request is rejected with `403`.

### 8.5 Adapter-Level Confirmation (Echo Pattern)

Adapters MAY implement their own confirmation flow independent of the policy middleware. The Echo adapter demonstrates this pattern:

1. First `execute` call (no `confirmationToken` in request body) → returns `status: "pending_confirmation"` with a `confirmationToken` and `summary`
2. Second `execute` call (with `confirmationToken` in request body) → returns `status: "completed"` with the order receipt

This is an adapter-level convention, not a protocol requirement. See the [Execute Handoff Spec](EXECUTE-HANDOFF-SPEC.md) for details.

### 8.6 SDK Usage

The `@agenr/sdk` maps the confirmation flow to two method calls:

```typescript
// 1. prepare() → POST /agp/execute/prepare
const { confirmationToken, expiresAt, summary } = await client.prepare(businessId, request);

// 2. Present summary to user, then execute with the token
// execute(options) → POST /agp/execute with X-Confirmation-Token header
const result = await client.execute(businessId, request, { confirmationToken });
```

`ExecuteOptions.confirmationToken` is sent as the `X-Confirmation-Token` HTTP header. See [Section 22](#22-sdk-reference) for full SDK details.

---

## 9. Idempotency

The `/agp/execute` endpoint supports idempotent requests via the `Idempotency-Key` HTTP header.

### 9.1 Behavior

- The `Idempotency-Key` **HTTP header** is the canonical way for clients to supply an idempotency key. Clients SHOULD use the header, not the request body.
- When the header is present, the server reads the value and injects it into `request.idempotencyKey` before passing the request to the adapter. The `request.idempotencyKey` field is **server-injected** — clients SHOULD NOT set it directly in the request body.
- The middleware checks for a cached response using the principal + key combination.
- If a cached response exists for the same principal + key combination, it is returned immediately without re-executing the operation.
- If no cache exists, the operation executes normally and the response is cached.
- Only **successful responses** (2xx) are cached.
- Cache entries expire after **1 hour**.
- The idempotency key is scoped per principal (`{principalId}:{key}`), so different callers MAY reuse the same key without collision.

> **SDK note:** The `@agenr/sdk` handles idempotency via `ExecuteOptions.idempotencyKey`, which is sent as the `Idempotency-Key` HTTP header automatically.

---

## 10. Business Management Endpoints

All business endpoints require authentication. Business access is scoped by ownership — non-admin callers can only access businesses they own.

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/businesses` | *(authenticated)* | Create a business |
| `GET` | `/businesses` | *(authenticated)* | List own businesses (admin: `?all=true` for all) |
| `GET` | `/businesses/:id` | *(authenticated)* | Get business details |
| `PUT` | `/businesses/:id` | *(authenticated)* | Update business |
| `DELETE` | `/businesses/:id` | *(authenticated)* | Delete business |
| `GET` | `/businesses/:id/connection-status` | *(authenticated)* | Check OAuth connection status |
| `GET` | `/businesses/:id/activity` | *(authenticated)* | Get credential activity log |
| `GET/POST` | `/businesses/:id/connect/:service` | *(authenticated)* | Initiate OAuth connection |
| `GET` | `/businesses/:id/connections` | `admin` | List connections for a business |
| `DELETE` | `/businesses/:id/connections/:service` | `admin` | Disconnect a service |

### 10.1 Create Business

**Request:**

```http
POST /businesses
Content-Type: application/json

{
  "name": "Joe's Pizza",
  "platform": "square",
  "location": "Austin, TX",
  "description": "Best pizza in town",
  "category": "restaurant",
  "preferences": { "defaultOrder": "pepperoni" }
}
```

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | MUST |
| `platform` | `string` | MUST |
| `location` | `string` | MAY |
| `description` | `string` | MAY |
| `category` | `string` | MAY |
| `preferences` | `object` | MAY |

The business ID is auto-generated as a URL-friendly slug from the name. If a collision occurs, a random suffix is appended.

### 10.2 Update Business

```http
PUT /businesses/:id
Content-Type: application/json

{
  "name": "Joe's Famous Pizza",
  "location": "Downtown Austin, TX"
}
```

The `platform` field MUST NOT be changed after creation (returns `400`).

---

## 11. Credential Management Endpoints

Users store and manage platform credentials for their AGP operations.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/credentials` | List all credentials for the caller |
| `POST` | `/credentials/:service` | Store a credential |
| `DELETE` | `/credentials/:service` | Delete a credential |
| `GET` | `/credentials/:service/activity` | Get audit log for a service |

### 11.1 Store Credential

```http
POST /credentials/stripe
Content-Type: application/json

{
  "auth_type": "api_key",
  "api_key": "sk_test_..."
}
```

Supported `auth_type` values and their required fields:

| `auth_type` | Required Fields |
|-------------|----------------|
| `api_key` | `api_key` |
| `cookie` | `cookie_name`, `cookie_value` |
| `basic` | `username`, `password` |
| `client_credentials` | `client_id`, `client_secret` |

### 11.2 List Credentials

```http
GET /credentials
```

Returns:

```json
[
  {
    "service": "stripe",
    "auth_type": "oauth2",
    "connected_at": "2026-02-10T...",
    "last_used_at": "2026-02-13T...",
    "expires_at": "2026-03-10T...",
    "status": "connected"
  }
]
```

Status is `"connected"` or `"expired"` based on `expires_at`.

---

## 12. OAuth Connection Endpoints

These endpoints handle OAuth 2.0 authorization code flows for platform connections.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/connect/services` | Required | List available OAuth services |
| `GET` | `/connect/:service` | Required | Initiate OAuth flow (redirects to provider) |
| `GET` | `/connect/:service/callback` | None | Handle OAuth callback |

### 12.1 OAuth Flow

```
1. GET /connect/stripe
   → 302 Redirect to https://connect.stripe.com/oauth/authorize?...

2. User authorizes on provider's consent screen

3. Provider redirects to GET /connect/stripe/callback?code=...&state=...

4. Server exchanges code for tokens, stores credential in vault

5. Returns HTML success page: "Connected to Stripe!"
```

**State parameter:** A CSRF token is generated and stored. The callback validates and consumes the state token. Invalid or expired state returns `400`.

**Token storage:** The exchanged `access_token` (and optionally `refresh_token`, `expires_in`) is stored as an `oauth2` credential in the vault.

### 12.2 Business-Scoped OAuth

Businesses can also initiate OAuth via:

```
GET /businesses/:id/connect/:service
```

This follows the same flow but stores credentials under the **business owner's** identity rather than the current caller's. The caller MUST be the business owner (or admin).

---

## 13. Adapter Marketplace Endpoints

Adapters follow a lifecycle: **sandbox** → **review** → **public** (or **rejected**). Sandbox adapters are only visible to their owner. Public adapters are available to all users.

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/adapters` | *(any)* | List visible adapters |
| `GET` | `/adapters/archived` | `admin` | List archived adapters |
| `POST` | `/adapters/generate` | `generate` | Generate adapter via AI |
| `GET` | `/adapters/jobs` | *(any)* | List generation jobs |
| `GET` | `/adapters/jobs/:id` | *(any)* | Get generation job status |
| `POST` | `/adapters/:platform/upload` | *(any)* | Upload adapter source |
| `POST` | `/adapters/:platform/submit` | *(any)* | Submit for review |
| `POST` | `/adapters/:platform/withdraw` | *(any)* | Withdraw from review |
| `POST` | `/adapters/:platform/promote` | `admin` | Promote to public |
| `POST` | `/adapters/:platform/demote` | `admin` | Demote to sandbox |
| `POST` | `/adapters/:platform/reject` | `admin` | Reject with feedback |
| `POST` | `/adapters/:platform/restore` | `admin` | Restore archived adapter |
| `DELETE` | `/adapters/:platform` | owner/`admin` | Soft delete (archive) |
| `DELETE` | `/adapters/:platform/hard` | `admin` | Hard delete |

### 13.1 Generate Adapter

```http
POST /adapters/generate
Content-Type: application/json

{
  "platform": "toast",
  "docsUrl": "https://doc.toasttab.com",
  "provider": "anthropic-api",
  "model": "claude-sonnet-4-20250514"
}
```

Returns `202 Accepted` with a job ID for polling:

```json
{
  "jobId": "uuid",
  "platform": "toast",
  "status": "queued",
  "poll": "/adapters/jobs/uuid"
}
```

Generation is rate-limited to 5 per 24 hours per owner (configurable via `AGENR_GENERATION_DAILY_LIMIT`). Exceeding returns `429`.

### 13.2 Upload Adapter

```http
POST /adapters/stripe/upload
Content-Type: application/json

{
  "source": "import { defineManifest } from ...",
  "description": "Stripe payment adapter"
}
```

Source validation rules:
- MUST export `manifest` (named export)
- MUST have a default export
- MUST NOT import banned modules (`fs`, `child_process`, `net`, `dgram`, `cluster`, `worker_threads`)
- MUST be valid TypeScript syntax
- MUST be ≤ 100KB

### 13.3 Adapter Resolution

When an AGP operation looks up an adapter:
1. **Scoped adapter** — if the caller has a sandbox adapter for the platform, use it
2. **Public adapter** — fall back to the public adapter for the platform

---

## 14. API Key Management Endpoints

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/keys` | *(session or admin)* | Create an API key |
| `GET` | `/keys/me` | *(any)* | Get current key details |
| `GET` | `/keys` | `admin` | List all keys |
| `DELETE` | `/keys/:id` | `admin` | Revoke a key |
| `POST` | `/keys/:id/link` | `admin` | Link key to a user |

### 14.1 Create Key

```http
POST /keys
Content-Type: application/json

{
  "label": "My Agent Key",
  "tier": "paid",
  "scopes": ["discover", "query", "execute"]
}
```

**Tiers and default scopes:**

| Tier | Default Scopes |
|------|---------------|
| `free` | `discover`, `query`, `execute` |
| `paid` | `discover`, `query`, `execute`, `generate` |

Custom scopes MAY be specified but MUST be within the tier's allowed set.

**Response:** `201 Created`

```json
{
  "id": "key-uuid",
  "key": "agenr_paid_a1b2c3d4e5f6...",
  "label": "My Agent Key",
  "tier": "paid",
  "scopes": ["discover", "query", "execute"],
  "createdAt": "2026-02-13T...",
  "warning": "Store this key securely. It will not be shown again."
}
```

API keys use the format `agenr_<tier>_<32 hex chars>` (e.g., `agenr_free_...` or `agenr_paid_...`).

Non-admin API keys MUST NOT create additional API keys. Only session-authenticated users and admin keys can create keys.

---

## 15. Console Authentication Endpoints

These endpoints support the web console's OAuth-based login.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/google` | Initiate Google OAuth login |
| `GET` | `/auth/google/callback` | Handle Google callback |
| `GET` | `/auth/github` | Initiate GitHub OAuth login |
| `GET` | `/auth/github/callback` | Handle GitHub callback |
| `GET` | `/auth/me` | Get current user info |
| `POST` | `/auth/logout` | End session |

Google login uses PKCE (S256 code challenge). GitHub uses standard authorization code flow.

On successful login, users receive a session cookie and are redirected to the console with `?session_token=<token>`.

**User allowlist:** If `AGENR_ALLOWED_EMAILS` is set, only listed emails can log in. An empty allowlist permits open registration.

---

## 16. Audit Endpoints

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/audit/verify` | *(any)* | Verify audit chain integrity |

Admins see the full chain; non-admins see only their own entries. Supports `?limit=N` query parameter.

---

## 17. Utility Endpoints

### 17.1 Health Check

```http
GET /health
```

No authentication required.

```json
{
  "status": "ok",
  "version": "0.5.0",
  "environment": "production",
  "timestamp": "2026-02-13T14:00:00.000Z"
}
```

### 17.2 Root Endpoint

```http
GET /
```

Returns service metadata and a list of all available endpoints.

### 17.3 App Credentials (Admin)

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/app-credentials` | `admin` | List configured OAuth app credentials |
| `POST` | `/app-credentials/:service` | `admin` | Store client ID/secret for a service |
| `DELETE` | `/app-credentials/:service` | `admin` | Remove app credentials |

---

## 18. Adapters

### 18.1 Adapter Interface

An adapter MUST implement the `AgpAdapter` interface:

```typescript
interface AgpAdapter {
  discover(ctx: AdapterContext): Promise<unknown>;
  query(request: Record<string, unknown>, ctx: AdapterContext): Promise<unknown>;
  execute(
    request: Record<string, unknown>,
    options: ExecuteOptions | undefined,
    ctx: AdapterContext,
  ): Promise<unknown>;
  testExecuteParams?(): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

interface ExecuteOptions {
  idempotencyKey?: string;
}
```

> **Naming note:** The `ExecuteOptions` interface here is the server-side adapter type defined in `src/adapters/adapter.ts`. SDK packages may define their own `ExecuteOptions` with a different shape (e.g., client-side options for calling AGP). Take care to distinguish them when importing both.

**`testExecuteParams()`** — An optional method that returns sample execute parameters for the adapter. This is used by the playground/testing UI to pre-populate the execute request form with valid example data, allowing developers to quickly test an adapter without manually constructing a request payload. Returns `null` if no sample params are available.

### 18.2 Adapter Context

Each AGP operation creates a fresh `AdapterContext` with:

| Property | Type | Description |
|----------|------|-------------|
| `platform` | `string` | Platform identifier |
| `userId` | `string` | Resolved caller identity |
| `executionId` | `string` (UUID) | Unique per-operation execution ID |

**`ctx.fetch(url, init?)`** — A credential-injecting fetch wrapper:
- Checks the target hostname against `authenticatedDomains` and `allowedDomains`
- Throws `DomainNotAllowedError` if the domain is not on either list
- Injects auth headers for authenticated domains based on the manifest's `strategy`
- On `401` responses from authenticated domains, automatically retries with refreshed credentials
- Merges the adapter timeout signal with any request-level abort signal

**`ctx.getCredential()`** — Retrieves the resolved credential object directly.

### 18.3 Auth Strategies

| Strategy | Header Injected |
|----------|----------------|
| `bearer` | `Authorization: Bearer <token>` |
| `api-key-header` | `<headerName>: <apiKey>` (default: `X-Api-Key`) |
| `basic` | `Authorization: Basic <base64(user:pass)>` |
| `cookie` | `Cookie: <cookieName>=<cookieValue>` |
| `custom` | `<headerName>: <headerValue>` |
| `client-credentials` | *(no auto-injection; adapter handles manually)* |
| `none` | *(no auth headers)* |

### 18.4 Adapter Manifest

Every adapter MUST export a `manifest`:

```typescript
interface AdapterManifest {
  name?: string;
  version?: string;
  description?: string;
  platform?: string;
  auth: {
    type: "oauth2" | "api_key" | "cookie" | "basic" | "client_credentials" | "none";
    strategy: AuthStrategy;
    scopes?: string[];
    headerName?: string;
    cookieName?: string;
    oauth?: {
      oauthService?: string;
      authorizationUrl: string;
      tokenUrl: string;
      tokenContentType?: "form" | "json";
      extraAuthParams?: Record<string, string>;
    };
  };
  authenticatedDomains: string[];
  allowedDomains?: string[];
}
```

- Adapters with `strategy` other than `"none"` MUST declare at least one `authenticatedDomain`.
- `allowedDomains` lists domains the adapter may call without credential injection.
- `oauth.oauthService` allows multiple platforms to share OAuth credentials (e.g., a "stripe" service for multiple Stripe-based adapters).

### 18.5 Adapter Timeout

Adapter operations are subject to a timeout (default: 30 seconds, configurable via `AGENR_ADAPTER_TIMEOUT_MS`). If an adapter exceeds the timeout, the operation fails with `504 Gateway Timeout` and error code `ADAPTER_TIMEOUT`.

### 18.6 Token Auto-Refresh

For OAuth2 adapters, credentials are automatically refreshed before each operation if expired. The refresh uses the stored `refresh_token` and the manifest's `tokenUrl`. Refresh is transparent to both the agent and the adapter.

---

## 19. Error Handling

### 19.1 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | `400` | Request body failed schema validation. |
| `BUSINESS_NOT_FOUND` | `400` | No business registered with the given ID. |
| `ADAPTER_NOT_FOUND` | `400` | No adapter registered for the business's platform. |
| `ADAPTER_ERROR` | `502` | Adapter operation threw an error. Message is truncated to 500 chars. |
| `ADAPTER_TIMEOUT` | `504` | Adapter did not respond within the timeout period. |
| `TRANSACTION_NOT_FOUND` | `404` | Transaction ID not found (or owned by another caller). |
| `DEMO_KEY_RESTRICTED` | `403` | Demo key used with non-echo business. |
| `INTERNAL_ERROR` | `500` | Unexpected server error. |

### 19.2 Authentication Errors

| Response | HTTP Status | Cause |
|----------|-------------|-------|
| `{ "error": "Unauthorized" }` | `401` | No valid authentication provided. |
| `{ "error": "Forbidden", "message": "Missing required scope: ..." }` | `403` | Authenticated but lacking required scope. |

### 19.3 Rate Limiting

Requests are rate-limited per API key. Exceeding the limit returns `429 Too Many Requests`. API keys MAY have custom `rateLimitOverride` values.

---

## 20. Security Considerations

### 20.1 Credential Isolation

Credentials are stored per user–service pair. The credential vault enforces strict isolation — a caller MUST NOT access another user's stored credentials.

### 20.2 Domain Allowlisting

Adapters declare which domains they are allowed to contact. The `AdapterContext.fetch()` method enforces this at runtime. Requests to unlisted domains throw `DomainNotAllowedError`.

### 20.3 Adapter Sandboxing

Uploaded adapter source code is validated for:
- Banned module imports (`fs`, `child_process`, `net`, etc.)
- Required exports (`manifest` + default export)
- TypeScript syntax validity
- Size limits (100KB)

### 20.4 CORS

Cross-origin access is controlled by `AGENR_CORS_ORIGINS`. If not set, cross-origin requests are denied by default.

### 20.5 Audit Trail

All credential operations (store, retrieve, delete) and connection events are logged to an append-only audit log with cryptographic chain verification.

### 20.6 Execute Safety

The confirmation flow (Section 8) provides defense against unintended transactions. Operators SHOULD set `AGENR_EXECUTE_POLICY=confirm` or `strict` in production.

---

## 21. Examples

### 21.1 Full Agent Workflow — Echo Adapter

```
# 1. Discover what Echo can do
POST /agp/discover
{ "businessId": "echo" }
→ 200 { transactionId: "...", status: "succeeded", data: { business: { name: "Echo Labs" }, services: [...] } }

# 2. Query the catalog
POST /agp/query
{ "businessId": "echo", "request": { "serviceId": "catalog" } }
→ 200 { transactionId: "...", status: "succeeded", data: { results: [{ id: "echo-widget-1", name: "Widget", price: 9.99 }, ...] } }

# 3. Execute an order (gets pending_confirmation)
POST /agp/execute
{ "businessId": "echo", "request": { "serviceId": "order", "items": [{ "productId": "echo-widget-1", "quantity": 2 }] } }
→ 200 { transactionId: "...", status: "succeeded", data: { status: "pending_confirmation", confirmationToken: "echo-confirm-1707836400000", summary: { ... } } }

# 4. Confirm the order
POST /agp/execute
{ "businessId": "echo", "request": { "serviceId": "order", "confirmationToken": "echo-confirm-1707836400000", "items": [...] } }
→ 200 { transactionId: "...", status: "succeeded", data: { status: "completed", orderId: "echo-order-...", receipt: { ... } } }
```

### 21.2 Policy-Based Confirmation Flow

```
# 1. Prepare confirmation token
POST /agp/execute/prepare
{ "businessId": "my-restaurant", "request": { "items": [...], "amount_cents": 1395 } }
→ 200 { confirmationToken: "uuid", expiresAt: "...", summary: "Execute request for business 'my-restaurant' (requested amount: 1395 cents)" }

# 2. Execute with confirmation
POST /agp/execute
X-Confirmation-Token: <uuid>
{ "businessId": "my-restaurant", "request": { "items": [...], "amount_cents": 1395 } }
→ 200 { transactionId: "...", status: "succeeded", data: { ... } }
```

### 21.3 Idempotent Execute

```
POST /agp/execute
Idempotency-Key: order-abc-123
{ "businessId": "my-restaurant", "request": { ... } }
→ 200 (first call: executes and caches)

POST /agp/execute
Idempotency-Key: order-abc-123
{ "businessId": "my-restaurant", "request": { ... } }
→ 200 (second call: returns cached response)
```

### 21.4 SDK Example

Full lifecycle using the `@agenr/sdk` TypeScript SDK:

```typescript
import { Agenr, AgenrError } from '@agenr/sdk';

const client = new Agenr({ apiKey: 'agenr_paid_...' });
const businessId = 'my-restaurant';

// 1. Discover capabilities
const discovery = await client.discover(businessId);
console.log(discovery.data.capabilities);

// 2. Query the menu
const menu = await client.query(businessId, { category: 'entrees' });
console.log(menu.data);

// 3. Prepare an order (get confirmation token)
const { confirmationToken, expiresAt, summary } = await client.prepare(businessId, {
  items: [{ productId: 'steak-01', quantity: 1 }],
  amount_cents: 2995,
});
console.log(`Confirm by ${expiresAt}: ${summary}`);

// 4. Execute with confirmation + idempotency
try {
  const order = await client.execute(businessId, {
    items: [{ productId: 'steak-01', quantity: 1 }],
    amount_cents: 2995,
  }, {
    confirmationToken,
    idempotencyKey: 'order-steak-abc123',
  });
  console.log('Order placed:', order.transactionId);

  // 5. Check status
  const tx = await client.status(order.transactionId);
  console.log('Status:', tx.status);
} catch (err) {
  if (err instanceof AgenrError) {
    console.error(`AGP error ${err.statusCode}: ${err.message}`);
  }
}
```

---

## 22. SDK Reference

`@agenr/sdk` is the official TypeScript SDK for the Agent Gateway Protocol.

### 22.1 Public Methods

```typescript
class Agenr {
  constructor(config: AgenrConfig);

  /** Discover business capabilities. POST /agp/discover */
  discover(businessId: string): Promise<AgpResponse>;

  /** Query a business. POST /agp/query */
  query(businessId: string, request: Record<string, unknown>): Promise<AgpResponse>;

  /** Prepare an execute (get confirmation token). POST /agp/execute/prepare */
  prepare(businessId: string, request: Record<string, unknown>): Promise<PrepareResponse>;

  /** Execute a transaction. POST /agp/execute */
  execute(
    businessId: string,
    request: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<AgpResponse>;

  /** Check transaction status. GET /agp/status/:id */
  status(transactionId: string): Promise<AgpTransaction>;
}
```

### 22.2 Exported Types

| Type | Description |
|------|-------------|
| `AgenrConfig` | Client configuration (`apiKey`, `baseUrl`, etc.) |
| `AgpOperation` | Union of AGP operation names |
| `AgpResponse` | Standard operation response envelope (`transactionId`, `status`, `data`) |
| `AgpTransaction` | Full transaction record (from status endpoint) |
| `PrepareResponse` | `{ confirmationToken: string, expiresAt: string, summary: string }` |
| `ExecuteOptions` | `{ confirmationToken?: string, idempotencyKey?: string }` |
| `TransactionStatus` | `"pending" \| "succeeded" \| "failed"` |
| `AgenrError` | Error class with `.statusCode`, `.message`, `.code` |

### 22.3 Header Mapping

| `ExecuteOptions` field | HTTP Header |
|------------------------|-------------|
| `confirmationToken` | `X-Confirmation-Token` |
| `idempotencyKey` | `Idempotency-Key` |

### 22.4 Example: Prepare → Execute → Confirm

```typescript
import { Agenr } from '@agenr/sdk';

const client = new Agenr({ apiKey: process.env.AGENR_API_KEY! });

// Prepare: get a confirmation token
const prep = await client.prepare('my-restaurant', {
  items: [{ productId: 'pizza-01', quantity: 2 }],
  amount_cents: 2400,
});

// Show summary to user, then execute with the token
const result = await client.execute('my-restaurant', {
  items: [{ productId: 'pizza-01', quantity: 2 }],
  amount_cents: 2400,
}, {
  confirmationToken: prep.confirmationToken,
  idempotencyKey: 'order-pizza-xyz',
});

console.log('Transaction:', result.transactionId, result.status);
```

For full documentation, see the [SDK README](../packages/sdk/README.md).

---

## 23. Related Specifications

- **[Execute Handoff Spec](EXECUTE-HANDOFF-SPEC.md)** — Human-in-the-loop pattern for commerce transactions.
- **[Auth Credential Spec](AUTH-CREDENTIAL-SPEC.md)** — Credential vault architecture and security model.
- **[Adapter OAuth Spec](ADAPTER-OAUTH-SPEC.md)** — OAuth integration for adapter platform connections.

---

## Appendix A: Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENR_API_KEY` | *(none)* | Admin API key for backdoor access |
| `AGENR_EXECUTE_POLICY` | `open` | Execute confirmation policy (`open`, `confirm`, `strict`) |
| `AGENR_MAX_EXECUTE_AMOUNT` | `100` | Max amount in cents for `strict` policy |
| `AGENR_ADAPTER_TIMEOUT_MS` | `30000` | Adapter operation timeout |
| `AGENR_CORS_ORIGINS` | *(none)* | Allowed CORS origins |
| `AGENR_ADMIN_EMAILS` | *(none)* | Comma-separated admin email addresses |
| `AGENR_ALLOWED_EMAILS` | *(none)* | User allowlist (empty = open registration) |
| `AGENR_GENERATION_DAILY_LIMIT` | `5` | Max adapter generations per 24h per user |
| `AGENR_ADAPTER_SYNC_INTERVAL_MS` | `300000` | Adapter DB sync interval (0 = disabled) |
| `AGENR_BASE_URL` | auto-detected | Public base URL for OAuth callbacks |
| `AGENR_ALLOW_UNAUTH_BOOTSTRAP` | *(none)* | Set to `1` for unauthenticated bootstrap |
| `CONSOLE_ORIGIN` | `http://localhost:5173` | Console URL for OAuth redirects |
| `PORT` | `3001` | HTTP server port |

## Appendix B: Demo Key

Agenr seeds a public demo API key restricted to the `echo` business. Any request using the demo key with a `businessId` other than `"echo"` returns `403 DEMO_KEY_RESTRICTED`.

## Appendix C: Verticals

For examples of AGP across different commerce verticals, see the project README.

<!-- Verticals table relocated from spec body to README.md:

| Domain | Discover | Query | Execute |
|--------|----------|-------|---------|
| **Food delivery** | Menu, hours, dietary info | Available items, pricing | Place order |
| **Restaurant reservation** | Dining options, location | Available time slots | Book table |
| **Salon booking** | Services, stylists | Availability, pricing | Book appointment |
| **Retail e-commerce** | Product catalog overview | Search, filter, pricing | Purchase |
| **Payments (Stripe)** | Account info, products | Prices, subscriptions | Create PaymentIntent |

The request/response shapes change. The protocol doesn't.
-->

---

*AGP is an open specification. Contributions and feedback welcome at [github.com/agenr-ai/agenr](https://github.com/agenr-ai/agenr).*
