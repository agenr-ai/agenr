import { getDb } from "./client";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    business_id TEXT NOT NULL,
    owner_key_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    input TEXT,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_cache (
    idempotency_key TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    status INTEGER NOT NULL,
    headers TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idempotency_cache_principal_created_idx
    ON idempotency_cache(principal_id, created_at_ms)`,
  `CREATE TABLE IF NOT EXISTS confirmation_tokens (
    token TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'free',
    owner_email TEXT,
    scopes TEXT NOT NULL DEFAULT 'discover,query,execute',
    rate_limit_override INTEGER,
    user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_id)
  )`,
  `CREATE INDEX IF NOT EXISTS users_email_idx
    ON users(email)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx
    ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry_idx
    ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    docs_url TEXT,
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    owner_key_id TEXT,
    logs TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS credential_audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    action TEXT NOT NULL,
    execution_id TEXT,
    ip_address TEXT,
    metadata TEXT,
    prev_hash TEXT,
    timestamp TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS audit_log_user_idx
    ON credential_audit_log(user_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS audit_log_action_idx
    ON credential_audit_log(action, timestamp)`,
  `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON credential_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
    END`,
  `CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON credential_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log entries cannot be updated');
    END`,
  `CREATE TABLE IF NOT EXISTS adapters (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sandbox' CHECK(status IN ('sandbox','public','rejected','review','archived')),
    file_path TEXT NOT NULL,
    source_code TEXT,
    source_hash TEXT,
    created_at TEXT NOT NULL,
    promoted_at TEXT,
    promoted_by TEXT,
    review_message TEXT,
    submitted_at TEXT,
    reviewed_at TEXT,
    review_feedback TEXT,
    archived_at TEXT,
    UNIQUE(platform, owner_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS adapters_public_platform_unique
    ON adapters(platform)
    WHERE status = 'public'`,
  `CREATE INDEX IF NOT EXISTS adapters_owner_status_idx
    ON adapters(owner_id, status)`,
  `CREATE INDEX IF NOT EXISTS adapters_platform_status_idx
    ON adapters(platform, status)`,
  `CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    location TEXT,
    description TEXT,
    category TEXT,
    preferences TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS businesses_owner_idx
    ON businesses(owner_id)`,
  `CREATE INDEX IF NOT EXISTS businesses_platform_idx
    ON businesses(platform)`,
  `CREATE INDEX IF NOT EXISTS businesses_status_idx
    ON businesses(status)`,
  `CREATE TABLE IF NOT EXISTS user_keys (
    user_id TEXT PRIMARY KEY,
    encrypted_dek BLOB NOT NULL,
    kms_key_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    rotated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    scopes TEXT,
    expires_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, service_id)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    service TEXT NOT NULL,
    code_verifier TEXT,
    created_at TEXT NOT NULL
  )`,
];

async function hasArchivedStatusConstraint(): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'adapters'",
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const tableSql = typeof row?.["sql"] === "string" ? row["sql"] : "";
  return tableSql.includes("'archived'");
}

async function hasAdaptersColumn(columnName: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute("PRAGMA table_info(adapters)");

  return result.rows.some((row) => {
    const record = row as Record<string, unknown>;
    return record["name"] === columnName;
  });
}

async function migrateAdaptersForArchivedStatus(): Promise<void> {
  const db = getDb();
  await db.execute("ALTER TABLE adapters RENAME TO adapters_legacy");
  await db.execute(`CREATE TABLE adapters (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sandbox' CHECK(status IN ('sandbox','public','rejected','review','archived')),
    file_path TEXT NOT NULL,
    source_code TEXT,
    source_hash TEXT,
    created_at TEXT NOT NULL,
    promoted_at TEXT,
    promoted_by TEXT,
    review_message TEXT,
    submitted_at TEXT,
    reviewed_at TEXT,
    review_feedback TEXT,
    archived_at TEXT,
    UNIQUE(platform, owner_id)
  )`);

  await db.execute(`INSERT INTO adapters (
    id,
    platform,
    owner_id,
    status,
    file_path,
    source_code,
    source_hash,
    created_at,
    promoted_at,
    promoted_by,
    review_message,
    submitted_at,
    reviewed_at,
    review_feedback,
    archived_at
  )
  SELECT
    id,
    platform,
    owner_id,
    status,
    file_path,
    source_code,
    source_hash,
    created_at,
    promoted_at,
    promoted_by,
    review_message,
    submitted_at,
    reviewed_at,
    review_feedback,
    NULL
  FROM adapters_legacy`);

  await db.execute("DROP TABLE adapters_legacy");
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS adapters_public_platform_unique
    ON adapters(platform)
    WHERE status = 'public'`);
  await db.execute(`CREATE INDEX IF NOT EXISTS adapters_owner_status_idx
    ON adapters(owner_id, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS adapters_platform_status_idx
    ON adapters(platform, status)`);
}

export async function migrate(): Promise<void> {
  const db = getDb();

  for (const sql of MIGRATIONS) {
    await db.execute(sql);
  }

  const archivedConstraintSupported = await hasArchivedStatusConstraint();
  const archivedColumnSupported = await hasAdaptersColumn("archived_at");
  if (!archivedConstraintSupported || !archivedColumnSupported) {
    await migrateAdaptersForArchivedStatus();
  }
}
