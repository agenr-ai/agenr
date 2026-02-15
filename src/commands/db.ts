import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { closeDb, DEFAULT_DB_PATH, getDb, initDb } from "../db/client.js";
import { banner, formatLabel, ui } from "../ui.js";

interface DbRow {
  [key: string]: unknown;
}

export interface DbCommandCommonOptions {
  db?: string;
}

export interface DbExportCommandOptions extends DbCommandCommonOptions {
  json?: boolean;
  md?: boolean;
}

export interface DbResetCommandOptions extends DbCommandCommonOptions {
  confirm?: boolean;
}

export interface DbCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
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

async function fetchExportEntries(db: ReturnType<typeof getDb>): Promise<Array<Record<string, unknown>>> {
  const result = await db.execute(`
    SELECT
      id,
      type,
      subject,
      content,
      confidence,
      expiry,
      scope,
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
    ORDER BY created_at ASC
  `);

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
      confidence: toStringValue(record.confidence),
      expiry: toStringValue(record.expiry),
      scope: toStringValue(record.scope) || "private",
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
        `  - confidence=${toStringValue(row.confidence)} | expiry=${toStringValue(row.expiry)} | recalled=${toStringValue(row.recall_count) || "0"}`,
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
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const resolved = resolveEffectiveDbPath(configured);
  process.stdout.write(`${resolved}\n`);
  return resolved;
}

export async function runDbStatsCommand(
  options: DbCommandCommonOptions,
  deps?: Partial<DbCommandDeps>,
): Promise<{
  total: number;
  byType: Array<{ type: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  oldest: string | null;
  newest: string | null;
  fileSizeBytes: number | null;
}> {
  const resolvedDeps: DbCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
  };

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const config = resolvedDeps.readConfigFn(process.env);
  const configured = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const resolvedPath = resolveEffectiveDbPath(configured);
  const db = resolvedDeps.getDbFn(configured);

  try {
    await resolvedDeps.initDbFn(db);

    const totalResult = await db.execute("SELECT COUNT(*) AS count FROM entries WHERE superseded_by IS NULL");
    const total = Number.isFinite(toNumber((totalResult.rows[0] as DbRow | undefined)?.count))
      ? toNumber((totalResult.rows[0] as DbRow | undefined)?.count)
      : 0;

    const byTypeResult = await db.execute(`
      SELECT type, COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
      GROUP BY type
      ORDER BY count DESC, type ASC
    `);
    const byType = byTypeResult.rows.map((row) => ({
      type: toStringValue((row as DbRow).type),
      count: Number.isFinite(toNumber((row as DbRow).count)) ? toNumber((row as DbRow).count) : 0,
    }));

    const tagsResult = await db.execute(`
      SELECT t.tag, COUNT(*) AS count
      FROM tags t
      JOIN entries e ON e.id = t.entry_id
      WHERE e.superseded_by IS NULL
      GROUP BY t.tag
      ORDER BY count DESC, t.tag ASC
      LIMIT 20
    `);
    const topTags = tagsResult.rows.map((row) => ({
      tag: toStringValue((row as DbRow).tag),
      count: Number.isFinite(toNumber((row as DbRow).count)) ? toNumber((row as DbRow).count) : 0,
    }));

    const rangeResult = await db.execute(`
      SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest
      FROM entries
      WHERE superseded_by IS NULL
    `);
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
        formatLabel("Entries", String(total)),
        formatLabel("File Size", fileSizeBytes === null ? "n/a" : `${fileSizeBytes} bytes`),
        formatLabel("Oldest", oldest ?? "n/a"),
        formatLabel("Newest", newest ?? "n/a"),
        "",
        ui.bold("By Type"),
        ...(byType.length > 0 ? byType.map((row) => `- ${row.type}: ${row.count}`) : ["- none"]),
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
      topTags,
      oldest,
      newest,
      fileSizeBytes,
    };
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

  try {
    await resolvedDeps.initDbFn(db);
    const entries = await fetchExportEntries(db);

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

    await resolvedDeps.initDbFn(db);
    clack.log.success("Database reset and migrations reapplied.", clackOutput);
    clack.outro(undefined, clackOutput);
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
