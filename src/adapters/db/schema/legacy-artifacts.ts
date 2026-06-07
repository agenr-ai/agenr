export /** Legacy tables that require database rejection when present. */ const LEGACY_DB_TABLES = ["entries"] as const;

export /** Legacy table-name prefixes that require database rejection when present. */ const LEGACY_DB_TABLE_PREFIXES = ["surgeon_"] as const;

export /** Legacy columns that require database rejection when present on an existing table. */ const LEGACY_DB_COLUMNS = [
  { table: "durables", column: "retired" },
  { table: "durables", column: "retired_at" },
  { table: "durables", column: "retired_reason" },
  { table: "durables", column: "minhash_sig" },
  { table: "durables", column: "cluster_id" },
  { table: "dream_runs", column: "durables_retired" },
  { table: "dream_run_actions", column: "recall_delta" },
] as const;

/** Builds the unsupported-database reason for one legacy table. */
export function legacyTableReason(table: string): string {
  if (table === "entries") {
    return "the legacy entries table is present";
  }

  return `legacy table "${table}" is present`;
}

/** Builds the unsupported-database reason for one legacy table prefix. */
export function legacyTablePrefixReason(prefix: string): string {
  return `legacy tables with prefix "${prefix}" are present`;
}

/** Builds the unsupported-database reason for one legacy column. */
export function legacyColumnReason(table: string, column: string): string {
  return `the ${table}.${column} column is present`;
}

/** Builds the unsupported-database reason for one missing required table. */
export function missingRequiredTableReason(table: string): string {
  return `required table "${table}" is missing`;
}
