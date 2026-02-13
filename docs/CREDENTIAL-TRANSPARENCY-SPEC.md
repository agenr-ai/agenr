# Credential Transparency & Audit Access

> How Agenr gives users full visibility and control over credential usage.

## Overview

Agenr follows industry best practices for credential security: encryption at rest with AWS KMS, domain-scoped auth injection, and sandboxed adapter execution. This specification defines the user-facing transparency layer — the APIs and mechanisms that let users see exactly how their credentials are being used.

**Design principles:**

1. **Every credential operation is logged.** Storage, retrieval, deletion, rotation, and connection lifecycle events all produce immutable audit entries.
2. **Users own their audit data.** All queries are scoped to the authenticated user's own credentials.
3. **Audit integrity is verifiable.** A hash chain links consecutive audit entries, allowing tamper detection.

## Audit Actions

The following actions are recorded in the `credential_audit_log` table:

| Action | Trigger |
|--------|---------|
| `credential_stored` | User stores a new credential |
| `credential_retrieved` | Credential is decrypted for use during adapter execution |
| `credential_deleted` | User disconnects a service |
| `credential_rotated` | OAuth token is refreshed or credential is rotated |
| `credential_revoked_by_admin` | Admin revokes a user's credential |
| `dek_generated` | A new data encryption key is created for a user |
| `dek_unwrapped` | A data encryption key is unwrapped (decrypted) for use |
| `connection_initiated` | OAuth or connection flow begins |
| `connection_completed` | OAuth or connection flow succeeds |
| `connection_failed` | OAuth or connection flow fails |

Each audit entry includes:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique entry identifier |
| `user_id` | string | The user who owns the credential |
| `service_id` | string | The service identifier (e.g., `stripe`) |
| `action` | string | One of the actions listed above |
| `execution_id` | string? | The adapter execution that triggered this event, if applicable |
| `ip_address` | string? | Client IP for user-initiated actions |
| `metadata` | object? | Additional context (sensitive fields are automatically stripped) |
| `timestamp` | string | ISO 8601 timestamp |
| `prev_hash` | string? | SHA-256 hash linking to the previous entry (see [Audit Chain Integrity](#audit-chain-integrity)) |

## Credential Activity API

### Get activity for a service connection

```
GET /credentials/:service/activity
Authorization: Bearer <api-key>
```

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | 50 | Number of entries to return (1–200) |
| `before` | — | ISO 8601 timestamp cursor for pagination |

**Response:**

```json
{
  "service": "stripe",
  "entries": [
    {
      "id": "a1b2c3d4-...",
      "timestamp": "2026-02-12T14:34:00.000Z",
      "action": "credential_retrieved",
      "execution_id": "exec_01HQ...",
      "metadata": null
    },
    {
      "id": "e5f6g7h8-...",
      "timestamp": "2026-02-12T12:00:00.000Z",
      "action": "credential_stored",
      "execution_id": null,
      "metadata": null
    }
  ],
  "has_more": false
}
```

Entries are returned in reverse chronological order. When `has_more` is `true`, pass the `timestamp` of the last entry as the `before` parameter to fetch the next page.

### Instant revocation

Users can disconnect any service immediately:

```
DELETE /credentials/:service
Authorization: Bearer <api-key>
```

This deletes the encrypted credential and logs a `credential_deleted` audit event.

## Audit Chain Integrity

Every audit entry stores a `prev_hash` field containing the SHA-256 hash of the previous entry's `id` and `timestamp` concatenated. The first entry in the chain uses a genesis sentinel value. This creates an append-only hash chain that allows tamper detection.

### Verify the audit chain

```
GET /audit/verify
Authorization: Bearer <api-key>
```

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | — | Number of most recent entries to verify (omit to verify all) |

**Response:**

```json
{
  "valid": true,
  "totalEntries": 142,
  "checkedEntries": 142
}
```

If the chain is broken, the response includes a `brokenAt` object identifying the first inconsistent entry. Admin-scoped API keys verify the full global chain; user-scoped keys verify only that user's entries.

### Metadata sanitization

Audit metadata is automatically sanitized before storage. Fields matching sensitive key patterns (e.g., `access_token`, `api_key`, `password`, `secret`, `private_key`) are stripped recursively, including in nested objects and arrays. This ensures no credential material is persisted in audit logs.

## Security Considerations

- **Append-only.** Audit queries enforce a read-only guard that rejects `UPDATE` and `DELETE` statements against the audit log table.
- **User-scoped.** All activity and verification queries are scoped to the authenticated user. Admin endpoints require an admin-tier API key.
- **Fire-and-forget logging.** Audit writes are non-blocking. A failed audit write never prevents a credential operation from completing, but failures are logged as warnings.
- **Domain-scoped injection.** Credentials are injected into outbound requests only when the target domain matches the adapter's declared allowed domains. Credentials are never exposed to adapter code directly.

## Future Directions

The following capabilities are planned but not yet implemented:

- **Webhook notifications.** Register a URL to receive real-time POST notifications on credential events, signed with HMAC-SHA256 for payload verification.
- **Approval gates.** Require explicit user approval before credential access, with configurable auto-approve windows and timeout policies.
- **Notification channels.** Email, SMS, and mobile push notifications for credential events.
- **Exportable audit reports.** CSV and PDF export of audit history.
- **Per-adapter approval policies.** Gate write operations while auto-approving read operations.
