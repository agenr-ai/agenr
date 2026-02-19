import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { RetirementRecord, RetirementsLedger } from "../types.js";

const LEDGER_VERSION = 1;

export type LibSQLDatabase = Client;

function normalizeDbPath(rawPath?: string): string {
  if (rawPath && rawPath.trim().length > 0) {
    return rawPath.trim();
  }
  return path.join(os.homedir(), ".agenr", "knowledge.db");
}

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveLedgerPath(dbPath?: string): string | null {
  const resolvedDbPath = normalizeDbPath(dbPath);
  if (resolvedDbPath === ":memory:") {
    return null;
  }

  const unwrapped = resolvedDbPath.startsWith("file:") ? resolvedDbPath.slice("file:".length) : resolvedDbPath;
  const absolute = path.resolve(resolveUserPath(unwrapped));
  return path.join(path.dirname(absolute), "retirements.json");
}

function isRetirementRecord(value: unknown): value is RetirementRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.created_at === "string" &&
    typeof record.subject_pattern === "string" &&
    (record.match_type === "exact" || record.match_type === "contains") &&
    Array.isArray(record.suppressed_contexts)
  );
}

function normalizeLedger(input: unknown): RetirementsLedger {
  if (!input || typeof input !== "object") {
    return { version: LEDGER_VERSION, retirements: [] };
  }

  const record = input as Record<string, unknown>;
  const version = record.version ?? LEDGER_VERSION;
  const retirements = Array.isArray(record.retirements)
    ? record.retirements.filter(isRetirementRecord).map((item) => ({
        ...item,
        suppressed_contexts: item.suppressed_contexts.filter((context): context is string => typeof context === "string"),
      }))
    : [];

  return { version, retirements };
}

async function markEntryRetired(
  db: LibSQLDatabase,
  id: string | number,
  reason: string | null,
  suppressedContexts: string[],
): Promise<number> {
  const now = new Date().toISOString();
  const updateResult = await db.execute({
    sql: `
        UPDATE entries
        SET retired = 1,
            retired_at = ?,
            retired_reason = ?,
            suppressed_contexts = ?,
            updated_at = ?
        WHERE id = ?
          AND retired = 0
      `,
    args: [now, reason, JSON.stringify(suppressedContexts), now, id],
  });
  return toRowsAffected(updateResult.rowsAffected);
}

async function readLedger(dbPath?: string): Promise<RetirementsLedger> {
  const ledgerPath = resolveLedgerPath(dbPath);
  if (!ledgerPath) {
    return { version: LEDGER_VERSION, retirements: [] };
  }

  try {
    const raw = await fs.readFile(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeLedger(parsed);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ENOENT") {
      return { version: LEDGER_VERSION, retirements: [] };
    }
    throw error;
  }
}

function toRowsAffected(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }
  return 0;
}

function normalizeSuppressedContexts(suppressedContexts?: string[]): string[] {
  const contexts =
    suppressedContexts?.filter((context): context is string => typeof context === "string" && context.trim().length > 0) ?? [];
  if (contexts.length === 0) {
    return ["session-start"];
  }
  return Array.from(new Set(contexts.map((context) => context.trim())));
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function makeRetirementId(): string {
  return `ret_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

async function queryMatchingEntries(
  db: LibSQLDatabase,
  opts: {
    entryId?: string;
    subjectPattern?: string;
    matchType?: "exact" | "contains";
    canonicalKey?: string;
  },
): Promise<Array<{ id: string; canonical_key?: string }>> {
  if (opts.entryId) {
    const result = await db.execute({
      sql: `
        SELECT id, canonical_key
        FROM entries
        WHERE id = ?
          AND retired = 0
      `,
      args: [opts.entryId],
    });
    return result.rows.map((row) => ({
      id: String((row as { id?: unknown }).id ?? ""),
      canonical_key: typeof (row as { canonical_key?: unknown }).canonical_key === "string"
        ? String((row as { canonical_key?: unknown }).canonical_key)
        : undefined,
    }));
  }

  const subjectPattern = opts.subjectPattern?.trim();
  if (!subjectPattern) {
    return [];
  }
  const matchType = opts.matchType === "contains" ? "contains" : "exact";
  const pattern = matchType === "contains" ? escapeLike(subjectPattern) : subjectPattern;

  if (opts.canonicalKey && opts.canonicalKey.trim().length > 0) {
        const result = await db.execute({
          sql: `
        SELECT id, canonical_key
        FROM entries
        WHERE retired = 0
          AND (
            canonical_key = ?
            OR ${
              matchType === "exact"
                ? "LOWER(subject) = LOWER(?)"
                : "LOWER(subject) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'"
            }
          )
      `,
          args: [opts.canonicalKey.trim(), pattern],
        });
    return result.rows.map((row) => ({
      id: String((row as { id?: unknown }).id ?? ""),
      canonical_key: typeof (row as { canonical_key?: unknown }).canonical_key === "string"
        ? String((row as { canonical_key?: unknown }).canonical_key)
        : undefined,
    }));
  }

  const sql =
    matchType === "exact"
      ? `
        SELECT id, canonical_key
        FROM entries
        WHERE LOWER(subject) = LOWER(?)
          AND retired = 0
      `
      : `
        SELECT id, canonical_key
        FROM entries
        WHERE LOWER(subject) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
          AND retired = 0
      `;
  const result = await db.execute({ sql, args: [pattern] });
  return result.rows.map((row) => ({
    id: String((row as { id?: unknown }).id ?? ""),
    canonical_key: typeof (row as { canonical_key?: unknown }).canonical_key === "string"
      ? String((row as { canonical_key?: unknown }).canonical_key)
      : undefined,
  }));
}

async function applyRetirementRecord(db: LibSQLDatabase, record: RetirementRecord): Promise<number> {
  const suppressedContexts = normalizeSuppressedContexts(record.suppressed_contexts);
  const matches = await queryMatchingEntries(db, {
    subjectPattern: record.subject_pattern,
    matchType: record.match_type,
    canonicalKey: record.canonical_key,
  });

  let updated = 0;
  for (const match of matches) {
    updated += await markEntryRetired(db, match.id, record.reason ?? null, suppressedContexts);
  }

  return updated;
}

export async function loadLedger(dbPath?: string): Promise<RetirementRecord[]> {
  const ledger = await readLedger(dbPath);
  return ledger.retirements;
}

export async function appendToLedger(record: RetirementRecord, dbPath?: string): Promise<void> {
  const ledgerPath = resolveLedgerPath(dbPath);
  if (!ledgerPath) {
    return;
  }

  const existing = await readLedger(dbPath);
  const next: RetirementsLedger = {
    version: LEDGER_VERSION,
    retirements: [...existing.retirements, record],
  };

  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const tmpPath = `${ledgerPath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, ledgerPath);
}

export async function applyLedger(db: LibSQLDatabase, dbPath?: string): Promise<number> {
  const records = await loadLedger(dbPath);
  if (records.length === 0) {
    return 0;
  }

  let updated = 0;
  for (const record of records) {
    updated += await applyRetirementRecord(db, record);
  }
  return updated;
}

export async function retireEntries(opts: {
  entryId?: string;
  subjectPattern?: string;
  matchType?: "exact" | "contains";
  reason?: string;
  suppressedContexts?: string[];
  writeLedger?: boolean;
  db: LibSQLDatabase;
  dbPath?: string;
}): Promise<{ count: number }> {
  const matchType = opts.matchType === "contains" ? "contains" : "exact";
  const suppressedContexts = normalizeSuppressedContexts(opts.suppressedContexts);
  const writeLedger = opts.writeLedger !== false;

  const matches = await queryMatchingEntries(opts.db, {
    entryId: opts.entryId,
    subjectPattern: opts.subjectPattern,
    matchType,
  });

  let count = 0;
  for (const match of matches) {
    count += await markEntryRetired(opts.db, match.id, opts.reason ?? null, suppressedContexts);
  }

  if (writeLedger && opts.subjectPattern && opts.subjectPattern.trim().length > 0) {
    const canonicalKey = matches.map((entry) => entry.canonical_key).find((value) => typeof value === "string" && value.length > 0);
    const record: RetirementRecord = {
      id: makeRetirementId(),
      created_at: new Date().toISOString(),
      canonical_key: canonicalKey,
      subject_pattern: opts.subjectPattern.trim(),
      match_type: matchType,
      reason: opts.reason,
      suppressed_contexts: suppressedContexts,
    };
    await appendToLedger(record, opts.dbPath);
  }

  return { count };
}
