import type { Client } from "@libsql/client";

import { runImmediateTransaction } from "../transaction.js";

const MEMORY_TABLES = ["durables", "episodes", "procedures"] as const;

/**
 * Migrates a schema v4 database to v5 by replacing retire semantics with valid-time staleness.
 *
 * @param db - libSQL client connected to the target database.
 */
export async function migrateSchemaV4ToV5(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    for (const table of MEMORY_TABLES) {
      await migrateRetiredRowsToStaleValidity(db, table);
    }

    await addEpisodeProcedureTemporalColumns(db);
    await renameDreamRunsRetiredColumn(db);
    await dropRetireColumns(db);
    await dropRetireIndexes(db);

    await db.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES ('schema_version', '5')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    });
  });
}

/** Copies retired rows into closed valid-time windows before dropping retire columns. */
async function migrateRetiredRowsToStaleValidity(db: Client, table: (typeof MEMORY_TABLES)[number]): Promise<void> {
  const hasRetired = await columnExists(db, table, "retired");
  if (!hasRetired) {
    return;
  }

  const hasSupersessionKind = await columnExists(db, table, "supersession_kind");
  const hasValidTo = await columnExists(db, table, "valid_to");

  if (!hasValidTo) {
    return;
  }

  if (hasSupersessionKind) {
    await db.execute(`
      UPDATE ${table}
      SET valid_to = COALESCE(valid_to, retired_at, updated_at),
          supersession_kind = COALESCE(supersession_kind, 'stale'),
          supersession_reason = COALESCE(supersession_reason, retired_reason, 'migrated from retire')
      WHERE retired = 1
    `);
    return;
  }

  await db.execute(`
    UPDATE ${table}
    SET valid_to = COALESCE(valid_to, retired_at, updated_at),
        supersession_reason = COALESCE(supersession_reason, retired_reason, 'migrated from retire')
    WHERE retired = 1
  `);
}

/** Adds temporal and supersession metadata columns to episodes and procedures when missing. */
async function addEpisodeProcedureTemporalColumns(db: Client): Promise<void> {
  for (const table of ["episodes", "procedures"] as const) {
    if (!(await columnExists(db, table, "valid_from"))) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN valid_from TEXT`);
    }
    if (!(await columnExists(db, table, "valid_to"))) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN valid_to TEXT`);
    }
    if (!(await columnExists(db, table, "supersession_kind"))) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN supersession_kind TEXT`);
    }
    if (!(await columnExists(db, table, "supersession_reason"))) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN supersession_reason TEXT`);
    }
  }
}

/** Renames the dreaming run counter from retired to staled when the old column exists. */
async function renameDreamRunsRetiredColumn(db: Client): Promise<void> {
  const hasRetiredColumn = await columnExists(db, "dream_runs", "durables_retired");
  const hasStaledColumn = await columnExists(db, "dream_runs", "durables_staled");
  if (hasRetiredColumn && !hasStaledColumn) {
    await db.execute("ALTER TABLE dream_runs RENAME COLUMN durables_retired TO durables_staled");
  }
}

/** Drops retire columns from memory tables after data has been migrated. */
async function dropRetireColumns(db: Client): Promise<void> {
  for (const table of MEMORY_TABLES) {
    if (await columnExists(db, table, "retired")) {
      await db.execute(`ALTER TABLE ${table} DROP COLUMN retired`);
    }
    if (await columnExists(db, table, "retired_at")) {
      await db.execute(`ALTER TABLE ${table} DROP COLUMN retired_at`);
    }
    if (await columnExists(db, table, "retired_reason")) {
      await db.execute(`ALTER TABLE ${table} DROP COLUMN retired_reason`);
    }
  }
}

/** Drops indexes that referenced retire columns and recreates the active procedure key index. */
async function dropRetireIndexes(db: Client): Promise<void> {
  await db.execute("DROP INDEX IF EXISTS idx_durables_retired");
  await db.execute("DROP INDEX IF EXISTS idx_episodes_retired");
  await db.execute("DROP INDEX IF EXISTS idx_procedures_retired");
  await db.execute("DROP INDEX IF EXISTS idx_procedures_active_procedure_key");
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_active_procedure_key
    ON procedures(procedure_key)
    WHERE superseded_by IS NULL
      AND valid_to IS NULL
  `);
}

/** Checks whether one column exists on a table. */
async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => row.name === column);
}
