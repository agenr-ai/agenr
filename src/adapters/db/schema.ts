import type { Client } from "@libsql/client";

import type { SqlExecutor } from "./queries.js";
import { REQUIRED_INITIALIZED_TABLES } from "./schema/canonical-tables.js";
import {
  CORE_SCHEMA_STATEMENTS,
  CREATE_DURABLES_EMBEDDING_INDEX_SQL,
  CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL,
  CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL,
  CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_EPISODES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL,
  DURABLE_VECTOR_INDEX_NAME,
  EPISODE_VECTOR_INDEX_NAME,
  PROCEDURE_VECTOR_INDEX_NAME,
} from "./schema/core-memory.js";
import { DREAMING_SCHEMA_STATEMENTS } from "./schema/dreaming.js";
import {
  LEGACY_DB_COLUMNS,
  LEGACY_DB_TABLE_PREFIXES,
  LEGACY_DB_TABLES,
  legacyColumnReason,
  legacyTablePrefixReason,
  legacyTableReason,
  missingRequiredTableReason,
} from "./schema/legacy-artifacts.js";
import { PROCEDURE_PROPOSAL_SCHEMA_STATEMENTS } from "./schema/procedure-proposals.js";
import { SESSION_MEMORY_SCHEMA_STATEMENTS } from "./schema/session-memory.js";
import { WORKING_MEMORY_SCHEMA_STATEMENTS } from "./schema/working-memory.js";
import { runImmediateTransaction } from "./transaction.js";

/**
 * Metadata key used to detect interrupted bulk-write phases.
 */
const BULK_WRITE_STATE_META_KEY = "bulk_write_state";

/**
 * Metadata key that records when the last bulk ingest finished.
 */
const LAST_BULK_INGEST_META_KEY = "last_bulk_ingest_at";

const SCHEMA_STATEMENTS = [
  ...CORE_SCHEMA_STATEMENTS,
  ...DREAMING_SCHEMA_STATEMENTS,
  ...WORKING_MEMORY_SCHEMA_STATEMENTS,
  ...SESSION_MEMORY_SCHEMA_STATEMENTS,
  ...PROCEDURE_PROPOSAL_SCHEMA_STATEMENTS,
] as const;

export {
  BULK_WRITE_STATE_META_KEY,
  CREATE_DURABLES_EMBEDDING_INDEX_SQL,
  CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL,
  CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL,
  CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_EPISODES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL,
  DURABLE_VECTOR_INDEX_NAME,
  EPISODE_VECTOR_INDEX_NAME,
  PROCEDURE_VECTOR_INDEX_NAME,
};

/**
 * Creates the agenr database schema for fresh databases.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once schema initialization is complete.
 * @throws Error When the database contains legacy tables or columns.
 */
export async function initSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys = ON");
  await assertSupportedDatabaseState(db);

  const hadDurablesFts = await tableExists(db, "durables_fts");
  const hadProceduresFts = await tableExists(db, "procedures_fts");

  for (const statement of SCHEMA_STATEMENTS) {
    await db.execute(statement);
  }

  await ensureDreamStateRow(db);

  if (await hasActiveBulkWriteState(db)) {
    await finalizeBulkWrites(db);
    return;
  }

  if (!hadDurablesFts || !hadProceduresFts) {
    await rebuildFts(db);
  }

  await ensureVectorIndexes(db);
}

/**
 * Rejects persisted databases that still carry legacy tables or columns.
 *
 * @param db - libSQL client connected to the target database.
 */
async function assertSupportedDatabaseState(db: Client): Promise<void> {
  const existingTables = await listUserTables(db);
  if (existingTables.length === 0) {
    return;
  }

  for (const table of LEGACY_DB_TABLES) {
    if (existingTables.includes(table)) {
      throw unsupportedDatabaseError(legacyTableReason(table));
    }
  }

  for (const prefix of LEGACY_DB_TABLE_PREFIXES) {
    if (existingTables.some((tableName) => tableName.startsWith(prefix))) {
      throw unsupportedDatabaseError(legacyTablePrefixReason(prefix));
    }
  }

  for (const marker of LEGACY_DB_COLUMNS) {
    if (!existingTables.includes(marker.table)) {
      continue;
    }

    if (await columnExists(db, marker.table, marker.column)) {
      throw unsupportedDatabaseError(legacyColumnReason(marker.table, marker.column));
    }
  }

  for (const table of REQUIRED_INITIALIZED_TABLES) {
    if (!existingTables.includes(table)) {
      throw unsupportedDatabaseError(missingRequiredTableReason(table));
    }
  }
}

/** Builds the standard unsupported-database error for legacy persisted state. */
function unsupportedDatabaseError(reason: string): Error {
  return new Error(`Unsupported agenr database because ${reason}. Create a fresh database with \`agenr db reset\`.`);
}

/**
 * Ensures the singleton dream_state row exists.
 *
 * @param db - libSQL client connected to the target database.
 */
async function ensureDreamStateRow(db: Client): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO dream_state (id, unsynthesized_importance_sum, updated_at)
      VALUES ('default', 0, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    args: [now],
  });
}

/**
 * Rebuilds the FTS shadow tables from canonical durable and procedure tables.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once the rebuild completes.
 */
export async function rebuildFts(db: Client): Promise<void> {
  await db.execute("INSERT INTO durables_fts(durables_fts) VALUES ('rebuild')");
  await db.execute("INSERT INTO procedures_fts(procedures_fts) VALUES ('rebuild')");
}

/**
 * Drops FTS triggers and the vector index before an ingest bulk-write phase.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once bulk-write preparation completes.
 */
export async function prepareBulkWrites(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    await db.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES (?, 'active')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      args: [BULK_WRITE_STATE_META_KEY],
    });
    await db.execute("DROP TRIGGER IF EXISTS durables_ai");
    await db.execute("DROP TRIGGER IF EXISTS durables_ad");
    await db.execute("DROP TRIGGER IF EXISTS durables_au");
    await db.execute("DROP TRIGGER IF EXISTS procedures_ai");
    await db.execute("DROP TRIGGER IF EXISTS procedures_ad");
    await db.execute("DROP TRIGGER IF EXISTS procedures_au");
    await dropVectorIndexes(db);
  });
}

/**
 * Recreates FTS triggers, rebuilds FTS, and recreates the vector index after bulk writes.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once bulk-write finalization completes.
 */
export async function finalizeBulkWrites(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    await db.execute(CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL);
    await rebuildFts(db);
    await ensureVectorIndexes(db);
    await db.execute({
      sql: "DELETE FROM _meta WHERE key = ?",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    await db.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      args: [LAST_BULK_INGEST_META_KEY, new Date().toISOString()],
    });
  });
}

/**
 * Reads the last bulk ingest timestamp from metadata, if present.
 *
 * @param db - libSQL client connected to the target database.
 * @returns ISO timestamp string, or null if no bulk ingest has been recorded.
 */
export async function getLastBulkIngestAt(db: Client): Promise<string | null>;
export async function getLastBulkIngestAt(db: SqlExecutor): Promise<string | null>;
export async function getLastBulkIngestAt(db: Client | SqlExecutor): Promise<string | null> {
  try {
    const result = await db.execute({
      sql: "SELECT value FROM _meta WHERE key = ? LIMIT 1",
      args: [LAST_BULK_INGEST_META_KEY],
    });
    const row = result.rows[0];
    return row?.value ? String(row.value) : null;
  } catch {
    return null;
  }
}

/** Checks whether one column exists on a table. */
async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => row.name === column);
}

/** Checks whether a SQLite table already exists. */
async function tableExists(db: Client, tableName: string): Promise<boolean> {
  const result = await db.execute({
    sql: `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `,
    args: [tableName],
  });

  return result.rows.length > 0;
}

/** Lists existing user-defined tables excluding SQLite internals. */
async function listUserTables(db: Client): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
  });

  return result.rows.flatMap((row) => {
    const name = row.name;
    return typeof name === "string" ? [name] : [];
  });
}

/** Checks whether a prior bulk-write phase was interrupted. */
async function hasActiveBulkWriteState(db: Client): Promise<boolean> {
  try {
    const result = await db.execute({
      sql: "SELECT value FROM _meta WHERE key = ? LIMIT 1",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    const row = result.rows[0];
    return row?.value === "active";
  } catch {
    return false;
  }
}

/** Recreates the vector index when the SQLite build supports it. */
async function ensureVectorIndexes(db: Client): Promise<void> {
  try {
    await db.execute(CREATE_DURABLES_EMBEDDING_INDEX_SQL);
    await db.execute(CREATE_EPISODES_EMBEDDING_INDEX_SQL);
    await db.execute(CREATE_PROCEDURES_EMBEDDING_INDEX_SQL);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

/** Drops the vector index when the SQLite build supports it. */
async function dropVectorIndexes(db: Client): Promise<void> {
  try {
    await db.execute(`DROP INDEX IF EXISTS ${DURABLE_VECTOR_INDEX_NAME}`);
    await db.execute(`DROP INDEX IF EXISTS ${EPISODE_VECTOR_INDEX_NAME}`);
    await db.execute(`DROP INDEX IF EXISTS ${PROCEDURE_VECTOR_INDEX_NAME}`);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

/** Detects vector-extension errors that should be tolerated in SQLite builds without support. */
function isVectorUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /libsql_vector_idx|vector32|vector_top_k|vector|no such function|unsupported/i.test(message);
}
