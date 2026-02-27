import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { getTagsForEntryIds, mapStoredEntry, recall, scoreEntry } from "../db/recall.js";
import { sessionStartRecall } from "../db/session-start.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import type { StoredEntry } from "../types.js";
import { APP_VERSION } from "../version.js";

const DEFAULT_LIMIT = 10;
const DEFAULT_BUDGET = 2000;
const DEFAULT_QUERIES_PATH = "~/.agenr/eval-queries.json";
const BASELINE_PATH = "~/.agenr/eval-baseline.json";

interface DbRow {
  [key: string]: unknown;
}

export interface EvalRecallQuery {
  id: string;
  query: string;
}

export interface EvalRecallCommandOptions {
  saveBaseline?: boolean;
  compare?: boolean;
  queries?: string;
  limit?: number | string;
  budget?: number | string;
}

export interface EvalRecallCommandDeps {
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  recallFn: typeof recall;
  sessionStartRecallFn: typeof sessionStartRecall;
  scoreEntryFn: typeof scoreEntry;
  readFileFn: typeof fs.readFile;
  writeFileFn: typeof fs.writeFile;
  mkdirFn: typeof fs.mkdir;
  accessFn: typeof fs.access;
  homedirFn: () => string;
  nowFn: () => Date;
}

interface EvalResultRow {
  entry: StoredEntry;
  score: number;
}

interface BaselineRow {
  entry_id: string;
  score: number;
  type: StoredEntry["type"];
  importance: number;
  created_at: string;
  updated_at: string;
  subject: string;
  content: string;
}

interface EvalBaseline {
  saved_at: string;
  version: string;
  limit: number;
  queries: Array<{ id: string; query: string; results: BaselineRow[] }>;
}

const DEFAULT_QUERIES: EvalRecallQuery[] = [
  { id: "session-start", query: "session context startup recall" },
  { id: "recent-decisions", query: "recent decisions" },
  { id: "active-todos", query: "active todos tasks" },
  { id: "preferences", query: "user preferences configuration" },
  { id: "architecture", query: "architecture technical decisions" },
];

function parsePositiveInt(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function resolveTildePath(inputPath: string, homedirFn: () => string): string {
  return inputPath.replace(/^~(?=$|\/)/, homedirFn());
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function formatPreview(entry: StoredEntry): string {
  const blob = `${entry.subject}: ${entry.content}`.replace(/\s+/g, " ").trim();
  if (blob.length <= 120) return blob;
  return `${blob.slice(0, 117)}...`;
}

function ageDays(now: Date, iso: string): number {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24)));
}

async function fileExists(filePath: string, accessFn: typeof fs.access): Promise<boolean> {
  try {
    await accessFn(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadQueries(
  rawPath: string,
  deps: Pick<EvalRecallCommandDeps, "readFileFn" | "accessFn" | "homedirFn">,
): Promise<EvalRecallQuery[]> {
  const resolved = path.resolve(resolveTildePath(rawPath, deps.homedirFn));
  const exists = await fileExists(resolved, deps.accessFn);
  if (!exists) {
    return DEFAULT_QUERIES;
  }

  const content = await deps.readFileFn(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse --queries JSON at ${resolved}: ${message}`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--queries must be a JSON array of { id, query }.");
  }

  const queries: EvalRecallQuery[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = toStringValue((item as Record<string, unknown>).id).trim();
    const query = toStringValue((item as Record<string, unknown>).query).trim();
    if (!id || !query) {
      continue;
    }
    queries.push({ id, query });
  }

  return queries.length > 0 ? queries : DEFAULT_QUERIES;
}

async function runTypedEval(
  db: Client,
  params: {
    type: "decision" | "todo";
    orderBy: "created_at_desc" | "importance_created_desc";
    now: Date;
    limit: number;
    scoreEntryFn: typeof scoreEntry;
  },
): Promise<EvalResultRow[]> {
  const orderClause =
    params.orderBy === "created_at_desc" ? "e.created_at DESC" : "e.importance DESC, e.created_at DESC";
  const result = await db.execute({
    sql: `
      SELECT
        e.id,
        e.type,
        e.subject,
        e.canonical_key,
        e.content,
        e.importance,
        e.expiry,
        e.scope,
        e.platform,
        e.project,
        e.source_file,
        e.source_context,
        e.created_at,
        e.updated_at,
        e.last_recalled_at,
        e.recall_count,
        e.confirmations,
        e.contradictions,
        e.quality_score,
        e.superseded_by
      FROM entries AS e
      WHERE e.type = ?
        AND e.superseded_by IS NULL
      ORDER BY ${orderClause}
      LIMIT ?
    `,
    args: [params.type, params.limit],
  });

  const ids = result.rows.map((row) => toStringValue((row as DbRow).id)).filter((id) => id.length > 0);
  const tagsById = await getTagsForEntryIds(db, ids);

  const scored = result.rows
    .map((row) => mapStoredEntry(row, tagsById.get(toStringValue((row as DbRow).id)) ?? []))
    .map((entry) => ({ entry, score: params.scoreEntryFn(entry, 1.0, false, params.now) }))
    .sort((a, b) => b.score - a.score);

  return scored;
}

async function runSemanticEval(
  db: Client,
  text: string,
  params: {
    now: Date;
    limit: number;
    apiKey: string;
    recallFn: typeof recall;
  },
): Promise<EvalResultRow[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const rows = await params.recallFn(
    db,
    {
      text: trimmed,
      context: "default",
      scope: "private",
      noUpdate: true,
      limit: params.limit,
    },
    params.apiKey,
    { now: params.now },
  );
  return rows.map((row) => ({ entry: row.entry, score: row.score }));
}

async function runSessionStartEval(
  db: Client,
  now: Date,
  limit: number,
  budget: number,
  deps: Pick<EvalRecallCommandDeps, "sessionStartRecallFn">,
): Promise<EvalResultRow[]> {
  const query = {
    context: "session-start" as const,
    text: "",
    noUpdate: true,
    scope: "private" as const,
    budget,
  };

  const grouped = await deps.sessionStartRecallFn(db, {
    query,
    apiKey: "",
    budget,
    nonCoreLimit: limit * 3,
    coreCandidateLimit: limit,
  });

  return grouped.results
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => ({ entry: row.entry, score: row.score }));
}

function printQueryResults(params: { id: string; query: string; rows: EvalResultRow[]; now: Date }): void {
  process.stdout.write(`${params.id}\n`);
  const header = `query="${params.query}"`;
  process.stdout.write(`${header}\n`);
  if (params.rows.length === 0) {
    process.stdout.write("(no results)\n\n");
    return;
  }

  let rank = 1;
  for (const row of params.rows) {
    const days = ageDays(params.now, row.entry.created_at);
    process.stdout.write(
      `${rank}. ${row.score.toFixed(4)} ${row.entry.type} importance=${row.entry.importance} age=${days}d ${formatPreview(row.entry)}\n`,
    );
    rank += 1;
  }
  process.stdout.write("\n");
}

function diffBaseline(baseline: BaselineRow[], current: EvalResultRow[]): {
  up: Array<{ id: string; delta: number }>;
  down: Array<{ id: string; delta: number }>;
  fresh: string[];
  dropped: string[];
} {
  const baselineRank = new Map<string, number>();
  for (let i = 0; i < baseline.length; i += 1) {
    baselineRank.set(baseline[i]!.entry_id, i + 1);
  }

  const currentRank = new Map<string, number>();
  for (let i = 0; i < current.length; i += 1) {
    currentRank.set(current[i]!.entry.id, i + 1);
  }

  const up: Array<{ id: string; delta: number }> = [];
  const down: Array<{ id: string; delta: number }> = [];
  const fresh: string[] = [];
  const dropped: string[] = [];

  for (const [id, rank] of currentRank.entries()) {
    const prior = baselineRank.get(id);
    if (!prior) {
      fresh.push(id);
      continue;
    }
    const delta = prior - rank;
    if (delta > 0) up.push({ id, delta });
    if (delta < 0) down.push({ id, delta: Math.abs(delta) });
  }

  for (const [id] of baselineRank.entries()) {
    if (!currentRank.has(id)) {
      dropped.push(id);
    }
  }

  up.sort((a, b) => b.delta - a.delta);
  down.sort((a, b) => b.delta - a.delta);
  return { up, down, fresh, dropped };
}

function printDiff(params: {
  id: string;
  query: string;
  baseline: BaselineRow[];
  current: EvalResultRow[];
}): { up: number; down: number; fresh: number; dropped: number } {
  const diff = diffBaseline(params.baseline, params.current);

  process.stdout.write(`${params.id}\n`);
  process.stdout.write(`query="${params.query}"\n`);

  const printIds = (label: string, ids: string[], prefix: string) => {
    if (ids.length === 0) return;
    process.stdout.write(`${label}:\n`);
    for (const id of ids) {
      process.stdout.write(`${prefix}${id}\n`);
    }
  };

  if (diff.up.length > 0) {
    process.stdout.write("Up:\n");
    for (const item of diff.up) {
      process.stdout.write(`+${item.delta} ${item.id}\n`);
    }
  }
  if (diff.down.length > 0) {
    process.stdout.write("Down:\n");
    for (const item of diff.down) {
      process.stdout.write(`-${item.delta} ${item.id}\n`);
    }
  }
  printIds("New", diff.fresh, "+ ");
  printIds("Dropped", diff.dropped, "- ");

  process.stdout.write("\n");

  return { up: diff.up.length, down: diff.down.length, fresh: diff.fresh.length, dropped: diff.dropped.length };
}

export async function runEvalRecallCommand(
  options: EvalRecallCommandOptions,
  deps?: Partial<EvalRecallCommandDeps>,
): Promise<{ exitCode: number }> {
  if (options.saveBaseline && options.compare) {
    throw new Error("Use either --save-baseline or --compare, not both.");
  }

  const resolvedDeps: EvalRecallCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps?.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    recallFn: deps?.recallFn ?? recall,
    sessionStartRecallFn: deps?.sessionStartRecallFn ?? sessionStartRecall,
    scoreEntryFn: deps?.scoreEntryFn ?? scoreEntry,
    readFileFn: deps?.readFileFn ?? fs.readFile,
    writeFileFn: deps?.writeFileFn ?? fs.writeFile,
    mkdirFn: deps?.mkdirFn ?? fs.mkdir,
    accessFn: deps?.accessFn ?? fs.access,
    homedirFn: deps?.homedirFn ?? os.homedir,
    nowFn: deps?.nowFn ?? (() => new Date()),
  };

  const now = resolvedDeps.nowFn();
  const limit = parsePositiveInt(options.limit, DEFAULT_LIMIT, "--limit");
  const budget = parsePositiveInt(options.budget, DEFAULT_BUDGET, "--budget");
  const queriesPath = (options.queries?.trim() || DEFAULT_QUERIES_PATH).trim();
  const baselinePath = path.resolve(resolveTildePath(BASELINE_PATH, resolvedDeps.homedirFn));

  const queries = await loadQueries(queriesPath, resolvedDeps);

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);

    const resultsByQueryId = new Map<string, EvalResultRow[]>();
    const needsSemanticRecall = queries.some((q) => !["session-start", "recent-decisions", "active-todos"].includes(q.id));
    const semanticApiKey = needsSemanticRecall ? resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env) : "";

    for (const q of queries) {
      if (q.id === "session-start") {
        resultsByQueryId.set(q.id, await runSessionStartEval(db, now, limit, budget, resolvedDeps));
        continue;
      }

      if (q.id === "recent-decisions") {
        resultsByQueryId.set(
          q.id,
          await runTypedEval(db, {
            type: "decision",
            orderBy: "created_at_desc",
            now,
            limit,
            scoreEntryFn: resolvedDeps.scoreEntryFn,
          }),
        );
        continue;
      }

      if (q.id === "active-todos") {
        resultsByQueryId.set(
          q.id,
          await runTypedEval(db, {
            type: "todo",
            orderBy: "importance_created_desc",
            now,
            limit,
            scoreEntryFn: resolvedDeps.scoreEntryFn,
          }),
        );
        continue;
      }

      resultsByQueryId.set(
        q.id,
        await runSemanticEval(db, q.query, {
          now,
          limit,
          apiKey: semanticApiKey,
          recallFn: resolvedDeps.recallFn,
        }),
      );
    }

    if (options.compare) {
      const baselineExists = await fileExists(baselinePath, resolvedDeps.accessFn);
      if (!baselineExists) {
        throw new Error(`Baseline not found: ${baselinePath}`);
      }
      const baselineRaw = await resolvedDeps.readFileFn(baselinePath, "utf8");
      let baselineParsed: unknown;
      try {
        baselineParsed = JSON.parse(baselineRaw) as unknown;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse baseline JSON at ${baselinePath}: ${message}`, {
          cause: err,
        });
      }

      if (!baselineParsed || typeof baselineParsed !== "object") {
        throw new Error(
          `Invalid baseline at ${baselinePath}: expected an EvalBaseline baseline object. Cannot build baselineById from baselineRaw.`,
        );
      }
      const baselineQueries = (baselineParsed as Record<string, unknown>).queries;
      if (!Array.isArray(baselineQueries)) {
        throw new Error(
          `Invalid baseline at ${baselinePath}: expected EvalBaseline baseline.queries to be an array. Cannot build baselineById from baselineRaw.`,
        );
      }

      const baseline = baselineParsed as EvalBaseline;
      const baselineById = new Map(baseline.queries.map((q) => [q.id, q] as const));

      let totalUp = 0;
      let totalDown = 0;
      let totalNew = 0;
      let totalDropped = 0;

      for (const q of queries) {
        const base = baselineById.get(q.id);
        const current = resultsByQueryId.get(q.id) ?? [];
        const summary = printDiff({
          id: q.id,
          query: q.query,
          baseline: base?.results ?? [],
          current,
        });
        totalUp += summary.up;
        totalDown += summary.down;
        totalNew += summary.fresh;
        totalDropped += summary.dropped;
      }

      process.stdout.write(
        `${totalUp} up, ${totalDown} down, ${totalNew} new, ${totalDropped} dropped across ${queries.length} queries\n`,
      );
      return { exitCode: 0 };
    }

    for (const q of queries) {
      printQueryResults({
        id: q.id,
        query: q.query,
        rows: resultsByQueryId.get(q.id) ?? [],
        now,
      });
    }

    if (options.saveBaseline) {
      const baseline: EvalBaseline = {
        saved_at: now.toISOString(),
        version: APP_VERSION,
        limit,
        queries: queries.map((q) => {
          const rows = resultsByQueryId.get(q.id) ?? [];
          const results: BaselineRow[] = rows.map((row) => ({
            entry_id: row.entry.id,
            score: row.score,
            type: row.entry.type,
            importance: row.entry.importance,
            created_at: row.entry.created_at,
            updated_at: row.entry.updated_at,
            subject: row.entry.subject,
            content: row.entry.content,
          }));
          return { id: q.id, query: q.query, results };
        }),
      };

      await resolvedDeps.mkdirFn(path.dirname(baselinePath), { recursive: true, mode: 0o700 });
      await resolvedDeps.writeFileFn(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      const totalResults = baseline.queries.reduce((sum, q) => sum + q.results.length, 0);
      process.stdout.write(`Baseline saved: ${baseline.queries.length} queries, ${totalResults} total results\n`);
    }

    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
