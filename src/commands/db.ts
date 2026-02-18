import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { closeDb, DEFAULT_DB_PATH, getDb, initDb, walCheckpoint } from "../db/client.js";
import { initSchema } from "../db/schema.js";
import { rebuildVectorIndex } from "../db/vector-index.js";
import { banner, formatLabel, ui } from "../ui.js";
import { APP_VERSION } from "../version.js";
import { normalizeKnowledgePlatform } from "../platform.js";
import type { KnowledgePlatform } from "../types.js";

interface DbRow {
  [key: string]: unknown;
}

export interface DbCommandCommonOptions {
  db?: string;
}

export interface DbExportCommandOptions extends DbCommandCommonOptions {
  json?: boolean;
  md?: boolean;
  platform?: string;
}

export interface DbStatsCommandOptions extends DbCommandCommonOptions {
  platform?: string;
}

export interface DbResetCommandOptions extends DbCommandCommonOptions {
  confirm?: boolean;
}

export interface DbCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  initSchemaFn: typeof initSchema;
  closeDbFn: typeof closeDb;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveDbFilePath(rawPath: string): string {
  if (rawPath.startsWith("file:")) {
    return rawPath.slice("file:".length);
  }
  if (rawPath === ":memory:") {
    return rawPath;
  }
  return resolveUserPath(rawPath);
}

function resolveEffectiveDbPath(inputPath: string | undefined): string {
  if (inputPath?.trim()) {
    return resolveDbFilePath(inputPath.trim());
  }
  return resolveDbFilePath(DEFAULT_DB_PATH);
}

async function hasMetaTable(db: ReturnType<typeof getDb>): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_meta' LIMIT 1",
    args: [],
  });
  return result.rows.length > 0;
}

async function readMetaRow(
  db: ReturnType<typeof getDb>,
  key: string,
): Promise<{ value: string; updatedAt: string } | null> {
  const result = await db.execute({
    sql: "SELECT value, updated_at FROM _meta WHERE key = ? LIMIT 1",
    args: [key],
  });
  const row = result.rows[0] as DbRow | undefined;
  if (!row) {
    return null;
  }
  const value = toStringValue(row.value);
  const updatedAt = toStringValue(row.updated_at);
  if (!value && !updatedAt) {
    return null;
  }
  return { value, updatedAt };
}

async function getTagsByEntryId(db: ReturnType<typeof getDb>, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT entry_id, tag FROM tags WHERE entry_id IN (${placeholders})`,
    args: ids,
  });

  const tags = new Map<string, string[]>();
  for (const row of result.rows) {
    const entryId = toStringValue((row as DbRow).entry_id);
    const tag = toStringValue((row as DbRow).tag);
    if (!entryId || !tag) {
      continue;
    }
    const current = tags.get(entryId) ?? [];
    current.push(tag);
    tags.set(entryId, current);
  }

  for (const [entryId, values] of tags.entries()) {
    tags.set(entryId, Array.from(new Set(values.map((value) => value.toLowerCase()))));
  }

  return tags;
}

async function fetchExportEntries(
  db: ReturnType<typeof getDb>,
  platform?: KnowledgePlatform,
): Promise<Array<Record<string, unknown>>> {
  const args: unknown[] = [];
  if (platform) {
    args.push(platform);
  }

  const result = await db.execute({
    sql: `
    SELECT
      id,
      type,
      subject,
      content,
      importance,
      expiry,
      scope,
      platform,
      source_file,
      source_context,
      created_at,
      updated_at,
      last_recalled_at,
      recall_count,
      confirmations,
      contradictions,
      superseded_by
    FROM entries
    WHERE superseded_by IS NULL
      ${platform ? "AND platform = ?" : ""}
    ORDER BY created_at ASC
    `,
    args,
  });

  const ids = result.rows.map((row) => toStringValue((row as DbRow).id)).filter((id) => id.length > 0);
  const tagsById = await getTagsByEntryId(db, ids);

  return result.rows.map((row) => {
    const record = row as DbRow;
    const id = toStringValue(record.id);
    return {
      id,
      type: toStringValue(record.type),
      subject: toStringValue(record.subject),
      content: toStringValue(record.content),
      importance: toStringValue(record.importance),
      expiry: toStringValue(record.expiry),
      scope: toStringValue(record.scope) || "private",
      platform: toStringValue(record.platform) || null,
      tags: tagsById.get(id) ?? [],
      source_file: toStringValue(record.source_file),
      source_context: toStringValue(record.source_context),
      created_at: toStringValue(record.created_at),
      updated_at: toStringValue(record.updated_at),
      last_recalled_at: toStringValue(record.last_recalled_at) || null,
      recall_count: Number.isFinite(toNumber(record.recall_count)) ? toNumber(record.recall_count) : 0,
      confirmations: Number.isFinite(toNumber(record.confirmations)) ? toNumber(record.confirmations) : 0,
      contradictions: Number.isFinite(toNumber(record.contradictions)) ? toNumber(record.contradictions) : 0,
      superseded_by: toStringValue(record.superseded_by) || null,
    };
  });
}

function renderMarkdownExport(entries: Array<Record<string, unknown>>): string {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of entries) {
    const type = toStringValue(entry.type) || "unknown";
    const current = grouped.get(type) ?? [];
    current.push(entry);
    grouped.set(type, current);
  }

  const lines: string[] = ["# Agenr Knowledge Export", ""];
  const types = [...grouped.keys()].sort();
  for (const type of types) {
    const rows = grouped.get(type) ?? [];
    lines.push(`## ${type} (${rows.length})`);
    lines.push("");
    for (const row of rows) {
      const tags = Array.isArray(row.tags) ? row.tags.join(", ") : "";
      lines.push(`- **${toStringValue(row.subject)}**: ${toStringValue(row.content)}`);
      lines.push(
        `  - importance=${toStringValue(row.importance)} | expiry=${toStringValue(row.expiry)} | recalled=${toStringValue(row.recall_count) || "0"}`,
      );
      lines.push(`  - tags: ${tags || "none"}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runDbPathCommand(options: DbCommandCommonOptions, deps?: Partial<DbCommandDeps>): Promise<string> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const resolved = resolveEffectiveDbPath(configured);
  process.stdout.write(`${resolved}\n`);
  return resolved;
}

export async function runDbStatsCommand(
  options: DbStatsCommandOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<{
  total: number;
  byType: Array<{ type: string; count: number }>;
  byPlatform: Array<{ platform: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  oldest: string | null;
  newest: string | null;
  fileSizeBytes: number | null;
}> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const resolvedPath = resolveEffectiveDbPath(configured);
  const db = resolvedDeps.getDbFn(configured);
  const platformRaw = options.platform?.trim();
  const platform = platformRaw ? normalizeKnowledgePlatform(platformRaw) : null;
  if (platformRaw && !platform) {
    throw new Error("--platform must be one of: openclaw, claude-code, codex");
  }
  const platformClause = platform ? "AND platform = ?" : "";
  const platformArgs = platform ? [platform] : [];

  try {
    await resolvedDeps.initDbFn(db);

    let schemaVersionLabel = "unknown (pre-0.4.0)";
    if (await hasMetaTable(db)) {
      const versionRow = await readMetaRow(db, "schema_version");
      if (versionRow?.value) {
        schemaVersionLabel = versionRow.value;
      }
    }

    const totalResult = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM entries WHERE superseded_by IS NULL ${platformClause}`,
      args: platformArgs,
    });
    const total = Number.isFinite(toNumber((totalResult.rows[0] as DbRow | undefined)?.count))
      ? toNumber((totalResult.rows[0] as DbRow | undefined)?.count)
      : 0;

    const byTypeResult = await db.execute({
      sql: `
      SELECT type, COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        ${platformClause}
      GROUP BY type
      ORDER BY count DESC, type ASC
    `,
      args: platformArgs,
    });
    const byType = byTypeResult.rows.map((row) => ({
      type: toStringValue((row as DbRow).type),
      count: Number.isFinite(toNumber((row as DbRow).count)) ? toNumber((row as DbRow).count) : 0,
    }));

    const byPlatformResult = await db.execute({
      sql: `
      SELECT platform, COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        ${platformClause}
      GROUP BY platform
      ORDER BY count DESC
    `,
      args: platformArgs,
    });
    const byPlatform = byPlatformResult.rows.map((row) => {
      const raw = (row as DbRow).platform;
      const platformValue = toStringValue(raw);
      return {
        platform: platformValue.trim().length > 0 ? platformValue : "(untagged)",
        count: Number.isFinite(toNumber((row as DbRow).count)) ? toNumber((row as DbRow).count) : 0,
      };
    });

    const tagsResult = await db.execute({
      sql: `
      SELECT t.tag, COUNT(*) AS count
      FROM tags t
      JOIN entries e ON e.id = t.entry_id
      WHERE e.superseded_by IS NULL
        ${platform ? "AND e.platform = ?" : ""}
      GROUP BY t.tag
      ORDER BY count DESC, t.tag ASC
      LIMIT 20
    `,
      args: platform ? [platform] : [],
    });
    const topTags = tagsResult.rows.map((row) => ({
      tag: toStringValue((row as DbRow).tag),
      count: Number.isFinite(toNumber((row as DbRow).count)) ? toNumber((row as DbRow).count) : 0,
    }));

    const rangeResult = await db.execute({
      sql: `
      SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest
      FROM entries
      WHERE superseded_by IS NULL
        ${platformClause}
    `,
      args: platformArgs,
    });
    const oldest = toStringValue((rangeResult.rows[0] as DbRow | undefined)?.oldest) || null;
    const newest = toStringValue((rangeResult.rows[0] as DbRow | undefined)?.newest) || null;

    let fileSizeBytes: number | null = null;
    if (resolvedPath !== ":memory:") {
      const stat = await fs
        .stat(resolvedPath)
        .then((value) => value)
        .catch(() => null);
      fileSizeBytes = stat ? stat.size : null;
    }

    clack.note(
      [
        formatLabel("Database", resolvedPath),
        formatLabel("Schema Version", schemaVersionLabel),
        formatLabel("Entries", String(total)),
        formatLabel("File Size", fileSizeBytes === null ? "n/a" : `${fileSizeBytes} bytes`),
        formatLabel("Oldest", oldest ?? "n/a"),
        formatLabel("Newest", newest ?? "n/a"),
        "",
        ui.bold("By Type"),
        ...(byType.length > 0 ? byType.map((row) => `- ${row.type}: ${row.count}`) : ["- none"]),
        "",
        ui.bold("By Platform"),
        ...(byPlatform.length > 0 ? byPlatform.map((row) => `- ${row.platform}: ${row.count}`) : ["- none"]),
        "",
        ui.bold("Top Tags"),
        ...(topTags.length > 0 ? topTags.map((row) => `- ${row.tag}: ${row.count}`) : ["- none"]),
      ].join("\n"),
      "DB Stats",
      clackOutput,
    );

    clack.outro(undefined, clackOutput);
    return {
      total,
      byType,
      byPlatform,
      topTags,
      oldest,
      newest,
      fileSizeBytes,
    };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runDbVersionCommand(
  options: DbCommandCommonOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<{ schemaVersion: string | null; dbCreatedAt: string | null; lastMigrationAt: string | null }> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const db = resolvedDeps.getDbFn(configured);

  try {
    const hasMeta = await hasMetaTable(db);
    if (!hasMeta) {
      const lines = [
        `agenr v${APP_VERSION}`,
        "Database schema version: unknown (pre-0.4.0)",
        "Database created: unknown",
        "Last migration: unknown",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return { schemaVersion: null, dbCreatedAt: null, lastMigrationAt: null };
    }

    const schemaRow = await readMetaRow(db, "schema_version");
    const createdRow = await readMetaRow(db, "db_created_at");

    const schemaVersion = schemaRow?.value ?? null;
    const dbCreatedAt = createdRow?.value ?? null;
    const lastMigrationAt = schemaRow?.updatedAt ?? null;

    const lines = [
      `agenr v${APP_VERSION}`,
      `Database schema version: ${schemaVersion ?? "unknown (pre-0.4.0)"}`,
      `Database created: ${dbCreatedAt ?? "unknown"}`,
      `Last migration: ${lastMigrationAt ?? "unknown"}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);

    return { schemaVersion, dbCreatedAt, lastMigrationAt };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runDbExportCommand(
  options: DbExportCommandOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<Array<Record<string, unknown>>> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  if (!options.json && !options.md) {
    throw new Error("Choose one export format: --json or --md");
  }
  if (options.json && options.md) {
    throw new Error("Use either --json or --md, not both.");
  }

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const db = resolvedDeps.getDbFn(configured);
  const platformRaw = options.platform?.trim();
  const platform = platformRaw ? normalizeKnowledgePlatform(platformRaw) : null;
  if (platformRaw && !platform) {
    throw new Error("--platform must be one of: openclaw, claude-code, codex");
  }

  try {
    await resolvedDeps.initDbFn(db);
    const entries = await fetchExportEntries(db, platform ?? undefined);

    if (options.md) {
      process.stdout.write(renderMarkdownExport(entries));
    } else {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    }

    return entries;
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runDbResetCommand(
  options: DbResetCommandOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<void> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  if (!options.confirm) {
    throw new Error("Refusing to reset database without --confirm.");
  }

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const db = resolvedDeps.getDbFn(configured);

  try {
    await db.execute("PRAGMA foreign_keys=OFF");

    const schemaObjects = await db.execute(`
      SELECT type, name
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY
        CASE type
          WHEN 'trigger' THEN 1
          WHEN 'index' THEN 2
          WHEN 'table' THEN 3
          ELSE 4
        END,
        name
    `);

    for (const row of schemaObjects.rows) {
      const type = toStringValue((row as DbRow).type);
      const name = toStringValue((row as DbRow).name);
      if (!type || !name) {
        continue;
      }

      if (type === "trigger") {
        await db.execute(`DROP TRIGGER IF EXISTS "${name}"`);
      } else if (type === "index") {
        await db.execute(`DROP INDEX IF EXISTS "${name}"`);
      } else if (type === "table") {
        await db.execute(`DROP TABLE IF EXISTS "${name}"`);
      }
    }

    await resolvedDeps.initSchemaFn(db);
    clack.log.success("Database reset and schema reinitialized.", clackOutput);
    clack.outro(undefined, clackOutput);
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runDbRebuildIndexCommand(
  options: DbCommandCommonOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<{ exitCode: number; embeddingCount: number; durationMs: number }> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const start = Date.now();
  let embeddingCount = 0;

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const db = resolvedDeps.getDbFn(configured);

  try {
    await resolvedDeps.initDbFn(db);

    process.stderr.write("Rebuilding vector index...\n");
    const rebuildResult = await rebuildVectorIndex(db);
    await walCheckpoint(db);

    embeddingCount = rebuildResult.embeddingCount;

    const durationMs = Date.now() - start;
    process.stderr.write(`Rebuilt index for ${embeddingCount} entries (${durationMs}ms)\n`);
    return { exitCode: 0, embeddingCount, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    process.stderr.write(
      `Failed to rebuild vector index: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { exitCode: 1, embeddingCount, durationMs };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runDbCheckCommand(
  options: DbCommandCommonOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<{ exitCode: number; embeddingCount: number }> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    initSchemaFn: deps?.initSchemaFn ?? initSchema,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  let embeddingCount = 0;

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const db = resolvedDeps.getDbFn(configured);

  try {
    await resolvedDeps.initDbFn(db);

    const quickCheckResult = await db.execute("PRAGMA quick_check");
    const quickCheckMessages = quickCheckResult.rows
      .map((row) => toStringValue((row as DbRow).quick_check ?? Object.values(row)[0]))
      .filter((message) => message.length > 0);

    const filteredQuickCheck = quickCheckMessages.filter(
      (message) => !message.includes("wrong # of entries in index idx_entries_embedding"),
    );

    if (filteredQuickCheck.length !== 1 || filteredQuickCheck[0] !== "ok") {
      process.stderr.write("DB quick_check failed:\n");
      for (const message of filteredQuickCheck.length > 0 ? filteredQuickCheck : ["unknown error"]) {
        process.stderr.write(`- ${message}\n`);
      }
      return { exitCode: 1, embeddingCount: 0 };
    }

    const embeddingsResult = await db.execute("SELECT COUNT(*) AS count FROM entries WHERE embedding IS NOT NULL");
    embeddingCount = Number.isFinite(toNumber((embeddingsResult.rows[0] as DbRow | undefined)?.count))
      ? toNumber((embeddingsResult.rows[0] as DbRow | undefined)?.count)
      : 0;

    if (embeddingCount <= 0) {
      process.stdout.write("DB check ok (empty)\n");
      return { exitCode: 0, embeddingCount: 0 };
    }

    try {
      await db.execute(`
        SELECT count(*) AS count
        FROM vector_top_k(
          'idx_entries_embedding',
          (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
          1
        )
      `);
    } catch (error) {
      process.stderr.write(
        `Vector index check failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { exitCode: 1, embeddingCount };
    }

    process.stdout.write(`DB check ok (${embeddingCount} entries with embeddings)\n`);
    return { exitCode: 0, embeddingCount };
  } catch (error) {
    process.stderr.write(`DB check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1, embeddingCount };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
