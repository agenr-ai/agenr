# Adapter Lifecycle Specification

**Version:** 0.2.0  
**Date:** February 13, 2026  
**Status:** Draft  

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

---

## 1. Overview

Adapters follow a promotion lifecycle analogous to Git branching: authors develop in a sandbox, submit for review, and administrators promote approved adapters to public availability.

## 2. Status Model

### 2.1 Status Values

Every adapter record MUST have exactly one of the following statuses:

| Status     | Visibility             | Usable By        | Description                                      |
|------------|------------------------|------------------|--------------------------------------------------|
| `sandbox`  | Owner only             | Owner only       | Under development or returned from review         |
| `review`   | Owner + administrators | Owner only       | Submitted for administrative review               |
| `public`   | All users              | All users        | Approved and live                                 |
| `rejected` | None                   | None             | Replaced during promotion (superseded adapter)    |
| `archived` | Administrators only    | None             | Soft-deleted by an administrator                  |

```typescript
type AdapterStatus = "sandbox" | "review" | "public" | "rejected" | "archived";
```

> **Note:** The `rejected` status is used exclusively for previously-public adapters that were replaced when a new adapter was promoted for the same platform. When an administrator rejects a `review` adapter, it transitions back to `sandbox` with feedback — it does NOT enter the `rejected` state.

### 2.2 State Diagram

```
                          ┌──────────────┐
                          │   sandbox    │ ← generate / upload / reject / withdraw
                          └──────┬───────┘
                                 │ submit (owner)
                                 ▼
                          ┌──────────────┐
                     ┌────│    review     │────┐
                     │    └──────────────┘    │
          reject     │                        │  promote (admin)
          (admin)    │                        │
                     ▼                        ▼
              ┌──────────┐            ┌──────────────┐
              │ sandbox  │            │    public     │
              │ (+ feedback) │        └──────┬───────┘
              └──────────┘                   │ demote (admin)
                                             ▼
                                      ┌──────────────┐
                                      │   sandbox    │
                                      └──────────────┘
```

Additional transitions:

- **Delete (soft):** Any active status → `archived` (admin) or removed entirely (owner, sandbox only).
- **Delete (hard):** Any status → permanently removed (admin only).
- **Restore:** `archived` → `sandbox` (admin only, requires preserved source).
- **Supersede:** When a new adapter is promoted, any existing `public` adapter for the same platform transitions to `rejected`.

### 2.3 Transition Table

| From       | To         | Action     | Actor         | Notes                                              |
|------------|-----------|------------|---------------|-----------------------------------------------------|
| —          | `sandbox` | generate   | Owner         | AI-assisted adapter generation                      |
| —          | `sandbox` | upload     | Owner         | Manual source upload                                |
| `sandbox`  | `review`  | submit     | Owner         | Request administrative review                       |
| `review`   | `public`  | promote    | Administrator | Adapter goes live; existing public version superseded |
| `sandbox`  | `public`  | promote    | Administrator | Direct promotion (admin override)                   |
| `review`   | `sandbox` | reject     | Administrator | Returned with required feedback                     |
| `review`   | `sandbox` | withdraw   | Owner         | Owner cancels review request                        |
| `public`   | `sandbox` | demote     | Administrator | Pulled from public availability                     |
| `sandbox`  | —         | delete     | Owner         | Permanent removal                                   |
| any active | `archived`| delete     | Administrator | Soft-delete (file removed, record preserved)        |
| `archived` | `sandbox` | restore    | Administrator | Recreates sandbox file from preserved source        |
| any        | —         | hard delete| Administrator | Permanent removal of record and file                |
| `public`   | `rejected`| (automatic)| System        | Previous public adapter superseded during promotion |

### 2.4 Invalid Transitions (Enforced)

The server MUST reject the following transitions with an appropriate error:

- `public` → `review` (MUST demote first)
- `review` → `review` (already in review)
- `sandbox` → `public` by non-administrator (MUST go through review)
- `rejected` → `review` (MUST generate or upload a new version)

## 3. API Endpoints

All endpoints require API key authentication via the `Authorization` header. Endpoints marked **(admin)** require the `admin` scope or `*` wildcard scope.

### 3.1 List Adapters

```
GET /adapters
```

- **Auth:** Any authenticated user
- **Behavior:** Administrators see all adapters. Non-admin users see their own `sandbox`/`review` adapters plus all `public` adapters.
- **Response:** Array of adapter objects including `platform`, `status`, `ownerId`, `adapterId`, review metadata, and `sourceCode` (visible to administrators and the adapter owner only).

### 3.2 List Archived Adapters

```
GET /adapters/archived
```

- **Auth:** Administrator
- **Response:** Array of archived adapter records with `archivedAt` timestamps.

### 3.3 Generate Adapter

```
POST /adapters/generate
```

- **Auth:** Any authenticated user (requires `generate` scope)
- **Body:** `{ "platform": string, "docsUrl"?: string, "provider"?: string, "model"?: string }`
- **Effect:** Creates an asynchronous generation job. The resulting adapter lands in `sandbox` status.
- **Response:** `202 Accepted` with `{ jobId, platform, status, poll }`.
- **Rate Limit:** Configurable per-owner daily limit (default: 5 per 24 hours). Returns `429` when exceeded.
- **Error:** `409` if the owner already has a `public` adapter for this platform (MUST demote first).

### 3.4 Upload Adapter

```
POST /adapters/:platform/upload
```

- **Auth:** Any authenticated user
- **Content-Type:** `application/json`
- **Body:** `{ "source": string, "description"?: string }`
- **Validation Pipeline:**
  1. Platform identifier MUST match `^[a-z0-9]+(-[a-z0-9]+)*$`.
  2. TypeScript syntax validation (transpile check).
  3. Source MUST export `manifest` (named export).
  4. Source MUST include a default export.
  5. Source MUST NOT import banned modules (`fs`, `child_process`, `net`, `dgram`, `cluster`, `worker_threads`).
  6. Source size MUST NOT exceed 100 KB.
- **Effect:** Writes source to the sandbox file path, upserts the adapter record, and hot-loads it into the scoped registry.
- **Response:** `{ platform, status: "sandbox", adapterId }`
- **Errors:**
  - `400` if validation fails.
  - `409` if the platform already has a public adapter owned by a different user.
  - `409` if the owner already has a public adapter for this platform.

### 3.5 Submit for Review

```
POST /adapters/:platform/submit
```

- **Auth:** Owner of the sandbox adapter
- **Body:** `{ "message"?: string }` — optional description for the reviewer (max 1000 characters).
- **Effect:** Sets status to `review`, records the submission message and timestamp.
- **Response:** `{ platform, status: "review", adapterId }`
- **Errors:**
  - `404` if no sandbox adapter found for this owner.
  - `409` if the adapter is already in `review`, `public`, or `rejected` status.

### 3.6 Review Queue

```
GET /adapters/reviews
```

- **Auth:** Administrator
- **Response:** `{ reviews: [...] }` — list of adapters in `review` status with submitter info, review message, timestamps, source code, and loaded metadata.

### 3.7 Reject

```
POST /adapters/:platform/reject
```

- **Auth:** Administrator
- **Query:** `?owner_id=<owner>` (REQUIRED when multiple review adapters exist for the platform)
- **Body:** `{ "reason": string }` — feedback is REQUIRED.
- **Effect:** Sets status back to `sandbox`, stores feedback and review timestamp, clears submission timestamp.
- **Response:** `{ platform, status: "sandbox", reason }`
- **Errors:**
  - `404` if no adapter in `review` status is found.
  - `409` if multiple review adapters exist and `owner_id` is not specified.

### 3.8 Withdraw

```
POST /adapters/:platform/withdraw
```

- **Auth:** Owner of the adapter in review
- **Effect:** Sets status back to `sandbox`.
- **Response:** `{ platform, status: "sandbox" }`
- **Error:** `404` if no adapter in `review` status is found for this owner.

### 3.9 Promote

```
POST /adapters/:platform/promote
```

- **Auth:** Administrator
- **Query:** `?owner_id=<owner>` (REQUIRED when multiple promotable adapters exist)
- **Effect:** Moves the adapter file to the public path, updates status to `public`, and hot-loads it into the public registry. If another public adapter exists for this platform, it is superseded (moved to `rejected` status).
- **Promotable statuses:** `sandbox` and `review`. Adapters in `review` are preferred when multiple candidates exist.
- **Response:** `{ platform, ownerId, status: "public", source }`
- **Error:** `409` if multiple candidates exist and `owner_id` is not specified.

### 3.10 Demote

```
POST /adapters/:platform/demote
```

- **Auth:** Administrator
- **Effect:** Moves the public adapter file back to the owner's sandbox path, updates status to `sandbox`, and reloads it as a scoped adapter.
- **Response:** `{ platform, ownerId, status: "sandbox", source }`
- **Error:** `404` if no public adapter exists for this platform.

### 3.11 Delete (Soft)

```
DELETE /adapters/:platform
```

- **Auth:** Owner (sandbox only) or Administrator (any active status)
- **Query:** `?owner_id=<owner>` (admin, to disambiguate)
- **Effect:**
  - **Owner:** Permanently removes the adapter record and file.
  - **Administrator:** Marks the adapter as `archived` (record preserved, file removed). Unregisters from the runtime.
- **Response:** `{ platform, status: "archived" | "removed", scope }`
- **Errors:**
  - `403` if a non-admin user attempts to delete a public adapter.
  - `409` if the adapter is already archived.

### 3.12 Delete (Hard)

```
DELETE /adapters/:platform/hard
```

- **Auth:** Administrator
- **Query:** `?owner_id=<owner>` (REQUIRED when multiple adapters exist)
- **Effect:** Permanently removes the adapter record and file. Includes archived adapters.
- **Response:** `{ platform, status: "removed", scope }`

### 3.13 Restore

```
POST /adapters/:platform/restore
```

- **Auth:** Administrator
- **Query:** `?owner_id=<owner>` (REQUIRED)
- **Effect:** Recreates the sandbox file from preserved source code, sets status to `sandbox`, and hot-loads into the scoped registry.
- **Response:** `{ platform, ownerId, status: "sandbox", source }`
- **Errors:**
  - `404` if no archived adapter is found.
  - `400` if source code was not preserved.

### 3.14 Generation Jobs

```
GET /adapters/jobs/:id
```

- **Auth:** Job owner or Administrator
- **Response:** Full job record.

```
GET /adapters/jobs
```

- **Auth:** Any authenticated user (filtered to own jobs; administrators see all)
- **Query:** `?status=queued|running|complete|failed`, `?limit=N` (max 50), `?before=<ISO timestamp>`, `?before_id=<id>`
- **Response:** `{ jobs: [...], has_more: boolean }`

## 4. Database Schema

### 4.1 Adapter Record

| Column            | Type   | Description                                          |
|-------------------|--------|------------------------------------------------------|
| `id`              | TEXT   | Primary key (UUID)                                   |
| `platform`        | TEXT   | Platform identifier                                  |
| `owner_id`        | TEXT   | API key ID of the adapter owner                      |
| `status`          | TEXT   | One of: `sandbox`, `review`, `public`, `rejected`, `archived` |
| `file_path`       | TEXT   | Path to the adapter source file                      |
| `source_code`     | TEXT   | Preserved TypeScript source (nullable)               |
| `source_hash`     | TEXT   | SHA-256 hash of the source (nullable)                |
| `created_at`      | TEXT   | ISO 8601 creation timestamp                          |
| `promoted_at`     | TEXT   | ISO 8601 promotion timestamp (nullable)              |
| `promoted_by`     | TEXT   | API key ID of the promoting administrator (nullable) |
| `review_message`  | TEXT   | Owner's submission message (nullable)                |
| `submitted_at`    | TEXT   | ISO 8601 review submission timestamp (nullable)      |
| `reviewed_at`     | TEXT   | ISO 8601 review decision timestamp (nullable)        |
| `review_feedback` | TEXT   | Administrator's rejection feedback (nullable)        |
| `archived_at`     | TEXT   | ISO 8601 archive timestamp (nullable)                |

## 5. Entry Points

An adapter enters the `sandbox` status through one of the following mechanisms:

| Method                         | Use Case                                  |
|--------------------------------|-------------------------------------------|
| `POST /adapters/generate`      | AI-assisted generation from documentation |
| `POST /adapters/:platform/upload` | Manual source code upload              |

Both paths produce a sandbox adapter. The lifecycle proceeds identically from that point: test → submit → review → promote.

## 6. Security Considerations

- Owners MUST only be able to submit and withdraw their own adapters.
- Only administrators MUST be able to promote, reject, demote, archive, restore, or hard-delete adapters.
- Adapters in `review` status MUST NOT be visible to non-admin users other than the owner.
- Adapter source code MUST be visible to administrators during review.
- Adapters in `review` status MUST continue to execute only for the owner (no expanded runtime access).
- Uploaded source MUST be validated for banned imports before acceptance.

---

*Specification version 0.2.0 — February 13, 2026*
