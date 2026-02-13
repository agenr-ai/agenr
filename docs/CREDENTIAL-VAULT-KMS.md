# Credential Vault — Envelope Encryption with KMS

> **Status: Implemented**
>
> Zero-trust credential storage. No single compromised component exposes user secrets.

## Overview

Agenr holds user credentials (OAuth tokens, API keys) to make authenticated requests on their behalf. A single encryption key on the server is not enough — if the server is compromised, all credentials are exposed. This design ensures that **no single system, person, or breach can access user credentials.**

In local development, a mock KMS mode is used automatically when `AGENR_KMS_KEY_ID` is not set. In production, AWS KMS provides hardware-backed key management.

## Threat Model

| Attacker | Access | Can decrypt? | Why |
|----------|--------|-------------|-----|
| SQL injection / DB dump | Encrypted blobs + encrypted DEKs | **No** | Need KMS to unwrap DEKs |
| Server SSH / env vars | Running process, memory | **No** | No vault key in env; KMS is external |
| Environment variable leak | All environment variables | **No** | Master key lives in KMS, not env |
| Admin | DB + SSH + dashboard | **No practical path** | No decrypt API exists; KMS calls are audit-logged and alerted |
| Compromised adapter code | `ctx.fetch()` | **No** | Only makes HTTP requests to allowed domains; never sees raw tokens |
| KMS access alone | Can unwrap DEKs | **No** | Still need encrypted blobs from DB |
| DB + KMS together | Full decrypt capability | **Yes, but audited** | Every KMS call logged; alerts on anomalous access patterns |

**Key insight:** Three independent systems must be compromised simultaneously (application server + database + AWS KMS), and every access attempt is audit-logged.

## Architecture

### Key Hierarchy

```
┌───────────────────────────────────┐
│          AWS KMS                  │
│  ┌─────────────────────────────┐  │
│  │  CMK (Customer Master Key)  │  │  ← Never leaves KMS hardware
│  │  Symmetric, AES-256         │  │     Not extractable by anyone
│  └──────────────┬──────────────┘  │
└─────────────────┼─────────────────┘
                  │
         wraps/unwraps
                  │
    ┌─────────────▼──────────────┐
    │  Per-User DEK              │    ← Unique AES-256 key per user
    │  (Data Encryption Key)     │       Stored encrypted (wrapped by CMK)
    │  Plaintext only in memory  │       One compromised DEK = one user only
    └─────────────┬──────────────┘
                  │
         encrypts/decrypts
                  │
    ┌─────────────▼──────────────┐
    │  Credential Payload        │    ← OAuth tokens, API keys, cookies
    │  (AES-256-GCM encrypted)   │       Plaintext exists in memory for
    │                            │       one request, then wiped
    └────────────────────────────┘
```

### Encryption Flow (Storing a Credential)

```
User connects a service via OAuth
        │
        ▼
1. Receive OAuth tokens from callback
        │
        ▼
2. Check: does this user have a DEK?
   ├─ NO:  Call KMS GenerateDataKey → returns plaintext DEK + encrypted DEK
   └─ YES: Call KMS Decrypt → unwrap existing encrypted DEK → plaintext DEK
        │
        ▼
3. Encrypt credential payload with plaintext DEK (AES-256-GCM)
   → produces: IV (12 bytes) + ciphertext + auth tag (16 bytes)
        │
        ▼
4. Store in DB:
   - credentials table: encrypted_payload, iv, auth_tag, service_id, user_id
   - user_keys table: encrypted_dek (KMS-wrapped), user_id
        │
        ▼
5. Wipe plaintext DEK and credential from memory (zero-fill buffer)
```

### Decryption Flow (Adapter Execution)

```
Agent executes an adapter action
        │
        ▼
1. Resolve user from API key → get user_id
        │
        ▼
2. Read from DB: encrypted_dek (user_keys) + encrypted_payload (credentials)
        │
        ▼
3. Call KMS Decrypt(encrypted_dek) → plaintext DEK
   [KMS audit log: who, when, key ID, caller identity]
        │
        ▼
4. Decrypt credential payload with plaintext DEK
        │
        ▼
5. Inject into adapter request (Authorization header)
        │
        ▼
6. Wipe plaintext DEK + credential from memory (zero-fill)
        │
        ▼
7. Return adapter response
```

### Memory Hygiene

Credentials exist in plaintext for the minimum possible window:

```typescript
async function withDecryptedCredential<T>(
  encryptedDek: Buffer,
  encryptedPayload: EncryptedBlob,
  fn: (credential: CredentialPayload) => Promise<T>,
): Promise<T> {
  let decryptedDek: Buffer | null = null;
  let plaintextBuffer: Buffer | null = null;

  try {
    decryptedDek = await decryptDataKey(encryptedDek);
    plaintextBuffer = decrypt(encryptedPayload, decryptedDek);
    const credential = parseCredentialPayload(plaintextBuffer);
    return await fn(credential);
  } finally {
    if (plaintextBuffer) zeroFill(plaintextBuffer);
    if (decryptedDek) zeroFill(decryptedDek);
  }
}
```

## Database Schema

### user_keys

```sql
CREATE TABLE user_keys (
  user_id TEXT PRIMARY KEY,
  encrypted_dek BLOB NOT NULL,        -- KMS-wrapped DEK (AES-256)
  kms_key_id TEXT NOT NULL,            -- KMS CMK ARN used for wrapping
  created_at TEXT NOT NULL,
  rotated_at TEXT                       -- last DEK rotation
);
```

### credentials

```sql
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  auth_type TEXT NOT NULL,             -- 'oauth2', 'api_key', 'cookie', 'basic', 'app_oauth', 'client_credentials'
  encrypted_payload BLOB NOT NULL,     -- AES-256-GCM encrypted by user's DEK
  iv BLOB NOT NULL,                    -- 12-byte initialization vector
  auth_tag BLOB NOT NULL,              -- 16-byte GCM authentication tag
  scopes TEXT,                         -- granted OAuth scopes (JSON array)
  expires_at TEXT,                     -- token expiry (null for non-expiring)
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, service_id),
  FOREIGN KEY (user_id) REFERENCES user_keys(user_id)
);
```

### credential_audit_log

```sql
CREATE TABLE credential_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- 'decrypt', 'encrypt', 'rotate', 'delete'
  execution_id TEXT,
  ip_address TEXT,
  timestamp TEXT NOT NULL
);
```

Audit entries are hash-chained for tamper detection — each entry's hash includes the previous entry, forming an append-only verifiable log.

## AWS KMS Configuration

### Resources Needed

- **1 CMK (Customer Master Key):** Symmetric, AES-256
- **1 IAM Role:** Permissions limited to `kms:Decrypt` and `kms:GenerateDataKey` on the CMK
- **Authentication:** Application assumes IAM role via environment credentials (no long-lived access keys)

### KMS Key Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowApplicationOnly",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::role/agenr-vault-role" },
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "*"
    },
    {
      "Sid": "DenyDirectEncrypt",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["kms:Encrypt", "kms:ReEncrypt*"],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::role/agenr-vault-role"
        }
      }
    },
    {
      "Sid": "AdminKeyManagementOnly",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::root" },
      "Action": ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:ListAliases", "kms:EnableKeyRotation"],
      "Resource": "*"
    }
  ]
}
```

**Key points:**
- Application role can only decrypt and generate data keys — not create or delete keys
- No human IAM user has decrypt permission
- Root account can manage the key but not use it for crypto operations
- Automatic key rotation enabled (annual)

### Monitoring

- Alert on abnormal bulk KMS Decrypt calls (e.g. >100/minute)
- Alert on KMS calls from unexpected IP ranges
- Alert on manual console access to the CMK

## Local Development

When `AGENR_KMS_KEY_ID` is not set, the vault automatically uses mock KMS mode. This uses a local AES-256-GCM wrapping key derived from `AGENR_KMS_MOCK_SECRET` (or a built-in default) to simulate envelope encryption without requiring AWS credentials. A warning is logged on first use.

Mock mode is **not** for production — it exists so developers can work with the full vault API without AWS access.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENR_KMS_KEY_ID` | CMK ARN or alias (when unset, mock mode is used) |
| `AWS_ACCESS_KEY_ID` | IAM role credentials (production) |
| `AWS_SECRET_ACCESS_KEY` | IAM role credentials (production) |
| `AWS_REGION` | AWS region for KMS |
| `AGENR_KMS_MOCK_SECRET` | Optional override for local dev wrapping key |

No encryption key is stored in environment variables — the master key never leaves KMS hardware.

## Cost Estimate

AWS KMS charges **$1/month** for one CMK and **$0.03 per 10,000 API requests**.

| Users | Est. Monthly KMS Calls | Total Cost |
|-------|----------------------|------------|
| 100 | ~30,000 | ~$1.40 |
| 1,000 | ~300,000 | ~$2.20 |
| 10,000 | ~3,000,000 | ~$10.50 |
| 100,000 | ~30,000,000 | ~$93.40 |

At scale, credential security costs less than $100/month — negligible compared to compute and database costs.

## Security Guarantees

### What admins CAN do:
- See that credentials exist (encrypted blobs in DB)
- See connection metadata (service name, created date, last used)
- Delete credentials (disconnect a service)
- Rotate DEKs (re-encrypt with new key)
- Read audit logs

### What admins CANNOT do:
- Decrypt credentials (no API endpoint or code path returns plaintext to callers)
- Extract the KMS master key (hardware-bound, not extractable)
- Use KMS without audit trail (every call logged)
- Silently access credentials (alerts fire on anomalous patterns)

### Defense in depth:

1. **Code level:** No function returns decrypted credentials to a caller — `withDecryptedCredential` scopes plaintext to a callback
2. **API level:** No endpoint accepts or returns plaintext credentials
3. **Database level:** Only encrypted blobs stored
4. **KMS level:** Master key never leaves AWS hardware
5. **IAM level:** No human user has decrypt permission
6. **Audit level:** Every vault operation logged with hash-chained tamper detection
7. **Alert level:** Anomalous access patterns trigger immediate notification
