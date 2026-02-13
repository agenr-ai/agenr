# Agent Policy Engine — Consumer Controls for AI Agents

**Status:** Draft
**Date:** February 13, 2026

---

## 1. Problem

When a consumer gives their AI agent direct API tokens, the agent has unrestricted access. There is no middleware to enforce spending limits, require approval workflows, or restrict agent behavior. The consumer must trust the agent completely.

The gateway sits between agents and businesses, making it the natural place to enforce consumer-defined policies on agent behavior.

## 2. Current Implementation: Execute Policy Middleware

The gateway enforces an **execute policy** that controls whether agents can call `POST /agp/execute` freely or must first obtain a confirmation token via `POST /agp/execute/prepare`.

### 2.1 Policy Modes

The policy mode is set via the `AGENR_EXECUTE_POLICY` environment variable:

| Mode | Behavior |
|------|----------|
| `open` (default) | No confirmation required. Execute proceeds directly. `X-Confirmation-Token` is ignored. |
| `confirm` | A valid `X-Confirmation-Token` header MUST be present. The agent must call `/agp/execute/prepare` first. |
| `strict` | Same as `confirm`, plus an amount ceiling check against `AGENR_MAX_EXECUTE_AMOUNT`. |

### 2.2 Confirmation Token Flow

When the policy is `confirm` or `strict`:

```
Agent -> POST /agp/execute/prepare { businessId, request }
  <- { confirmationToken, expiresAt, summary }

Agent -> POST /agp/execute { businessId, request }
         Header: X-Confirmation-Token: <token>
  <- { transactionId, status, data }
```

**Token properties:**
- Single-use — consumed after successful policy validation
- 5-minute TTL — expired tokens are rejected and cleaned up automatically
- Request-bound — the token is tied to the specific `businessId` and a SHA-256 hash of the normalized request payload
- Mismatched tokens return `403`

### 2.3 Amount Ceiling (`strict` mode)

When the policy is `strict`, the middleware reads `amount_cents` or `amount` from the execute request body. If the value exceeds `AGENR_MAX_EXECUTE_AMOUNT` (default: **100 cents**), the request is rejected with `403`.

This provides a basic spending guard independent of the confirmation token.

### 2.4 Middleware Behavior

The policy middleware only applies to `POST /agp/execute`. All other endpoints pass through unaffected.

**Error responses:**

| Condition | Status | Message |
|-----------|--------|---------|
| Missing token (when required) | `403` | Execute confirmation required. Provide x-confirmation-token header. |
| Invalid token | `403` | Invalid confirmation token. |
| Expired token | `403` | Confirmation token expired. Prepare a new token. |
| Token/request mismatch | `403` | Confirmation token does not match this execute request. |
| Amount exceeds limit (`strict`) | `403` | Execute amount exceeds policy limit (N cents). |
| Unparseable body (when validating token) | `403` | Unable to validate confirmation token for execute payload. |

### 2.5 Data Model

Confirmation tokens are stored in a `confirmation_tokens` table:

| Column | Type | Description |
|--------|------|-------------|
| `token` | TEXT PK | UUID token value |
| `business_id` | TEXT | Target business |
| `request_hash` | TEXT | SHA-256 of normalized request |
| `summary` | TEXT | Human-readable description |
| `created_at_ms` | INTEGER | Creation timestamp (ms) |
| `expires_at_ms` | INTEGER | Expiration timestamp (ms) |

### 2.6 Adapter-Level Confirmation

Adapters MAY implement their own confirmation flow independent of the policy middleware. In this pattern, the first `execute` call returns `status: "pending_confirmation"` with a `confirmationToken` in the response body, and the second call includes that token in the request body to complete the transaction.

This is distinct from the gateway-level policy middleware, which uses the `X-Confirmation-Token` HTTP header and the `/agp/execute/prepare` endpoint.

---

## 3. Future: Per-Consumer Policy Engine

The current implementation is gateway-wide (a single env var applies to all consumers). The following sections describe the planned evolution toward per-consumer, per-agent, and per-business policy controls.

### 3.1 Planned Policy Types

#### Spending Limits

Control how much an agent can spend:

- Per-transaction cap: block orders over a threshold
- Daily/weekly/monthly rolling totals
- When exceeded: block, notify, or require confirmation

#### Category Restrictions

Control what types of businesses the agent can interact with:

- Allowlist: agent can ONLY use these categories
- Blocklist: agent can use anything EXCEPT these
- Categories derived from business registration metadata

#### Confirmation Requirements

Force human approval for certain actions:

- Always require confirmation for execute operations
- Require confirmation above a dollar threshold
- Require confirmation the first time interacting with a new business

#### Time Windows

Control when the agent can act:

- Restrict to specific hours and days
- Queue actions until the window opens, or block entirely

#### Per-Business Overrides

Different rules for different businesses:

- Raise or lower limits for trusted/untrusted businesses
- Overrides stack on top of global policies

### 3.2 Planned Enforcement Architecture

```
Agent -> POST /agp/execute { businessId, request }
  |
  v
[Auth Middleware] -> identify the agent and its owner
  |
  v
[Policy Engine] -> load consumer's policies
  |                check spending limits (query transaction history)
  |                check category restrictions (look up business category)
  |                check confirmation requirements
  |                check time windows
  |
  v
[PASS] -> forward to adapter -> execute -> return result
[BLOCK] -> return policy violation response
[CONFIRM] -> return pending status with approval mechanism
```

### 3.3 Planned API Endpoints

```
# Policies
GET    /policies                    -- list consumer's policies
POST   /policies                    -- create policy
PUT    /policies/:id                -- update policy
DELETE /policies/:id                -- delete policy

# Transactions
GET    /transactions                -- list agent transactions
GET    /transactions/summary        -- spending summary

# Approvals
GET    /approvals                   -- list pending approvals
POST   /approvals/:id/approve       -- approve a request
POST   /approvals/:id/deny          -- deny a request
```

### 3.4 Implementation Phases

**Phase 1 — Spending Limits:**
Per-consumer spending limit policies, transaction ledger, policy management API, console UI.

**Phase 2 — Confirmation & Categories:**
Confirmation requirement policies, category restrictions, approval request flow, console approval queue.

**Phase 3 — Advanced Controls:**
Time windows, per-business overrides, multi-agent policies, push notifications.

**Phase 4 — Analytics:**
Spending trends, anomaly detection, policy recommendations.

---

## 4. Positioning

The policy engine is the consumer-side differentiator. Direct API tokens give agents unrestricted access. The gateway gives consumers a control plane — spending limits, approval workflows, and full visibility into what their agents do across every business.
