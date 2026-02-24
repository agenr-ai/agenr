import * as clack from "@clack/prompts";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { retireEntries } from "../db/retirements.js";
import { banner } from "../ui.js";

interface RetireCandidate {
  id: string;
  type: string;
  subject: string;
  importance: number;
  content: string;
}

export interface RetireCommandOptions {
  persist?: boolean;
  contains?: boolean;
  dryRun?: boolean;
  force?: boolean;
  reason?: string;
  db?: string;
  id?: string;
}

export interface RetireCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  retireEntriesFn: typeof retireEntries;
  confirmFn: (message: string) => Promise<boolean>;
  textInputFn: (message: string) => Promise<string | null>;
  logFn: (line: string) => void;
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

function toNumber(value: unknown): number {
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

function summarizeContent(content: string, maxLength = 80): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function queryCandidates(
  db: Client,
  subject: string,
  contains: boolean,
): Promise<RetireCandidate[]> {
  const result = await db.execute({
    sql: `
      SELECT id, type, subject, importance, content
      FROM entries
      WHERE retired = 0
        AND ${contains ? "LOWER(subject) LIKE '%' || LOWER(?) || '%'" : "LOWER(subject) = LOWER(?)"}
      ORDER BY updated_at DESC
    `,
    args: [subject],
  });

  return result.rows.map((row) => ({
    id: toStringValue((row as { id?: unknown }).id),
    type: toStringValue((row as { type?: unknown }).type),
    subject: toStringValue((row as { subject?: unknown }).subject),
    importance: toNumber((row as { importance?: unknown }).importance),
    content: toStringValue((row as { content?: unknown }).content),
  }));
}

async function queryById(db: Client, id: string): Promise<RetireCandidate[]> {
  const result = await db.execute({
    sql: `
      SELECT id, type, subject, importance, content
      FROM entries
      WHERE retired = 0 AND id = ?
    `,
    args: [id],
  });
  return result.rows.map((row) => ({
    id: toStringValue((row as { id?: unknown }).id),
    type: toStringValue((row as { type?: unknown }).type),
    subject: toStringValue((row as { subject?: unknown }).subject),
    importance: toNumber((row as { importance?: unknown }).importance),
    content: toStringValue((row as { content?: unknown }).content),
  }));
}

export async function runRetireCommand(
  subject: string,
  options: RetireCommandOptions,
  deps?: Partial<RetireCommandDeps>,
): Promise<{ exitCode: number }> {
  const resolvedDeps: RetireCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    retireEntriesFn: deps?.retireEntriesFn ?? retireEntries,
    confirmFn:
      deps?.confirmFn ??
      (async (message: string) => {
        const result = await clack.confirm({ message });
        return result === true;
      }),
    textInputFn:
      deps?.textInputFn ??
      (async (message: string) => {
        const result = await clack.text({ message });
        if (clack.isCancel(result)) {
          return null;
        }
        return String(result);
      }),
    logFn: deps?.logFn ?? ((line: string) => clack.log.info(line, { output: process.stderr })),
  };

  const querySubject = subject.trim();
  const queryId = options.id?.trim() ?? "";
  if (!queryId && !querySubject) {
    throw new Error("subject or id is required");
  }
  if (queryId && querySubject) {
    throw new Error("subject and id are mutually exclusive");
  }

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);
    const contains = options.contains === true;
    let candidates: RetireCandidate[];
    if (queryId) {
      candidates = await queryById(db, queryId);
    } else {
      candidates = await queryCandidates(db, querySubject, contains);
    }
    const queryDisplay = queryId || querySubject;

    if (candidates.length === 0) {
      clack.log.warn(`No active entries matching: ${queryDisplay}`, clackOutput);
      clack.outro(undefined, clackOutput);
      return { exitCode: 1 };
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (!candidate) {
        continue;
      }
      resolvedDeps.logFn(
        `[${i + 1}] ${candidate.type} (importance: ${candidate.importance}) "${candidate.subject}" - ${summarizeContent(candidate.content)}`,
      );
    }

    if (options.dryRun) {
      clack.log.success("Dry run complete. No entries were retired.", clackOutput);
      clack.outro(undefined, clackOutput);
      return { exitCode: 0 };
    }

    if (options.force !== true) {
      const requiresGuardrail = candidates.some((candidate) => candidate.importance >= 8);
      if (requiresGuardrail) {
        const typed = await resolvedDeps.textInputFn("Type CONFIRM to retire high-importance entries");
        if (typed !== "CONFIRM") {
          clack.log.warn("Retirement canceled.", clackOutput);
          clack.outro(undefined, clackOutput);
          return { exitCode: 1 };
        }
      } else {
        const confirmed = await resolvedDeps.confirmFn(
          `Retire ${candidates.length} matching entr${candidates.length === 1 ? "y" : "ies"}?`,
        );
        if (!confirmed) {
          clack.log.warn("Retirement canceled.", clackOutput);
          clack.outro(undefined, clackOutput);
          return { exitCode: 1 };
        }
      }
    }

    const retireSubject = queryId
      ? (candidates[0]?.subject ?? queryId)
      : querySubject;
    const retired = await resolvedDeps.retireEntriesFn({
      subjectPattern: retireSubject,
      matchType: queryId ? "exact" : (contains ? "contains" : "exact"),
      reason: options.reason?.trim() || undefined,
      writeLedger: options.persist === true,
      db,
      dbPath,
    });

    if (retired.count === 0) {
      clack.log.warn(`No active entries matching: ${queryDisplay}`, clackOutput);
      clack.outro(undefined, clackOutput);
      return { exitCode: 1 };
    }

    clack.log.success(`Retired ${retired.count} entr${retired.count === 1 ? "y" : "ies"}.`, clackOutput);
    if (options.persist) {
      clack.log.info("Suppression pattern saved. Retirement will survive database re-ingest.", clackOutput);
    }
    clack.outro(undefined, clackOutput);
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
