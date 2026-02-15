import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { recall, shapeRecallText, updateRecallMetadata } from "../db/recall.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { CONFIDENCE_LEVELS, EXPIRY_LEVELS, KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import type {
  ConfidenceLevel,
  Expiry,
  RecallCommandResponse,
  RecallCommandResult,
  RecallQuery,
  RecallResult,
  Scope,
} from "../types.js";
import { banner, ui } from "../ui.js";

const DEFAULT_LIMIT = 10;
const SESSION_CANDIDATE_LIMIT = 500;
const CORE_CANDIDATE_LIMIT = 5000;

type SessionCategory = "core" | "active" | "preferences" | "recent";

export interface RecallCommandOptions {
  limit?: number | string;
  type?: string;
  tags?: string;
  minConfidence?: string;
  since?: string;
  expiry?: string;
  json?: boolean;
  db?: string;
  budget?: number | string;
  context?: string;
  scope?: string;
  noBoost?: boolean;
  noUpdate?: boolean;
}

export interface RecallCommandDeps {
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  recallFn: typeof recall;
  updateRecallMetadataFn: typeof updateRecallMetadata;
  nowFn: () => Date;
}

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

function parseCsv(input: string | undefined): string[] {
  if (!input) {
    return [];
  }
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );
}

export function parseSinceToIso(since: string | undefined, now = new Date()): string | undefined {
  if (!since) {
    return undefined;
  }

  const trimmed = since.trim();
  if (!trimmed) {
    return undefined;
  }

  const duration = trimmed.match(/^(\d+)\s*([hdy])$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2]?.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0 || !unit) {
      throw new Error("Invalid --since duration. Use 1h, 7d, 30d, or 1y.");
    }

    let millis = 0;
    if (unit === "h") {
      millis = amount * 60 * 60 * 1000;
    } else if (unit === "d") {
      millis = amount * 24 * 60 * 60 * 1000;
    } else if (unit === "y") {
      millis = amount * 365 * 24 * 60 * 60 * 1000;
    }

    if (millis <= 0) {
      throw new Error("Invalid --since duration. Use 1h, 7d, 30d, or 1y.");
    }

    return new Date(now.getTime() - millis).toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid --since value. Use 1h, 7d, 30d, 1y, or an ISO date.");
  }
  return parsed.toISOString();
}

export function estimateEntryTokens(result: RecallResult): number {
  const tags = result.entry.tags.join(" ");
  const blob = [
    result.entry.type,
    result.entry.subject,
    result.entry.content,
    result.entry.confidence,
    result.entry.expiry,
    tags,
  ]
    .filter(Boolean)
    .join(" ");
  const words = blob
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0).length;
  return Math.ceil(words * 1.3);
}

function stripEmbedding<T extends RecallCommandResult>(result: T): T {
  const { embedding, ...entryWithoutEmbedding } = result.entry;
  return {
    ...result,
    entry: entryWithoutEmbedding,
  } as T;
}

function classifySessionCategory(result: RecallResult): SessionCategory {
  if (result.entry.expiry === "core") {
    return "core";
  }

  if (result.entry.type === "todo" && result.entry.expiry !== "session-only") {
    return "active";
  }

  if (result.entry.type === "preference" || result.entry.type === "decision") {
    return "preferences";
  }

  return "recent";
}

function compareResults(a: RecallResult, b: RecallResult, category: SessionCategory): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (category === "recent") {
    const aUpdated = Date.parse(a.entry.updated_at);
    const bUpdated = Date.parse(b.entry.updated_at);
    return (Number.isFinite(bUpdated) ? bUpdated : 0) - (Number.isFinite(aUpdated) ? aUpdated : 0);
  }

  return 0;
}

function consumeByBudget(results: RecallResult[], budget: number): { selected: RecallResult[]; used: number } {
  if (budget <= 0) {
    return { selected: [], used: 0 };
  }

  const selected: RecallResult[] = [];
  let used = 0;
  for (const result of results) {
    const estimate = estimateEntryTokens(result);
    if (used + estimate > budget) {
      break;
    }
    selected.push(result);
    used += estimate;
  }

  return { selected, used };
}

function assignCategory(results: RecallResult[], category: SessionCategory): RecallCommandResult[] {
  return results.map((result) => ({
    ...result,
    category,
  }));
}

function buildSessionStartResults(
  coreResults: RecallResult[],
  nonCoreResults: RecallResult[],
  budget: number | undefined,
  nonCoreLimit: number,
): { results: RecallCommandResult[]; budgetUsed: number } {
  const grouped: Record<Exclude<SessionCategory, "core">, RecallResult[]> = {
    active: [],
    preferences: [],
    recent: [],
  };

  for (const result of nonCoreResults) {
    const category = classifySessionCategory(result);
    if (category === "core") {
      continue;
    }
    grouped[category].push(result);
  }

  grouped.active.sort((a, b) => compareResults(a, b, "active"));
  grouped.preferences.sort((a, b) => compareResults(a, b, "preferences"));
  grouped.recent.sort((a, b) => compareResults(a, b, "recent"));

  const normalizedCore = assignCategory(coreResults, "core");

  if (budget === undefined) {
    const allNonCore = [
      ...assignCategory(grouped.active, "active"),
      ...assignCategory(grouped.preferences, "preferences"),
      ...assignCategory(grouped.recent, "recent"),
    ].slice(0, nonCoreLimit);
    const results = [...normalizedCore, ...allNonCore];
    const budgetUsed = allNonCore.reduce((sum, result) => sum + estimateEntryTokens(result), 0);
    return { results, budgetUsed };
  }

  const activeQuota = Math.floor(budget * 0.3);
  const preferencesQuota = Math.floor(budget * 0.3);
  const recentQuota = Math.max(0, budget - activeQuota - preferencesQuota);

  const activePass = consumeByBudget(grouped.active, activeQuota);
  const preferencesPass = consumeByBudget(grouped.preferences, preferencesQuota);
  const recentPass = consumeByBudget(grouped.recent, recentQuota);

  const selectedIds = new Set<string>([
    ...activePass.selected.map((item) => item.entry.id),
    ...preferencesPass.selected.map((item) => item.entry.id),
    ...recentPass.selected.map((item) => item.entry.id),
  ]);

  let budgetUsed = activePass.used + preferencesPass.used + recentPass.used;
  const budgetLeft = Math.max(0, budget - budgetUsed);
  const leftovers = [...grouped.active, ...grouped.preferences, ...grouped.recent]
    .filter((result) => !selectedIds.has(result.entry.id))
    .sort((a, b) => b.score - a.score);

  const overflowPick = consumeByBudget(leftovers, budgetLeft);
  budgetUsed += overflowPick.used;

  const byId = new Map<string, RecallCommandResult>();
  for (const result of assignCategory(activePass.selected, "active")) {
    byId.set(result.entry.id, result);
  }
  for (const result of assignCategory(preferencesPass.selected, "preferences")) {
    byId.set(result.entry.id, result);
  }
  for (const result of assignCategory(recentPass.selected, "recent")) {
    byId.set(result.entry.id, result);
  }
  for (const result of overflowPick.selected) {
    byId.set(result.entry.id, {
      ...result,
      category: classifySessionCategory(result),
    });
  }

  const ordered = [
    ...normalizedCore,
    ...grouped.active.map((result) => byId.get(result.entry.id)).filter((item): item is RecallCommandResult => Boolean(item)),
    ...grouped.preferences
      .map((result) => byId.get(result.entry.id))
      .filter((item): item is RecallCommandResult => Boolean(item)),
    ...grouped.recent.map((result) => byId.get(result.entry.id)).filter((item): item is RecallCommandResult => Boolean(item)),
  ];

  return { results: ordered, budgetUsed };
}

function formatAge(isoDate: string, now: Date): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown age";
  }
  const days = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24)));
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "1 day ago";
  }
  return `${days} days ago`;
}

function formatRecallCount(count: number): string {
  if (count <= 0) {
    return "never recalled";
  }
  if (count === 1) {
    return "recalled 1 time";
  }
  return `recalled ${count} times`;
}

function printHumanResults(results: RecallCommandResult[], elapsedMs: number, now: Date, isSessionStart: boolean): void {
  const clackOutput = { output: process.stderr };
  clack.log.info(`${ui.bold(String(results.length))} results (${elapsedMs}ms)`, clackOutput);

  if (results.length === 0) {
    clack.log.info("No matching entries found.", clackOutput);
    return;
  }

  if (isSessionStart) {
    const sections: Array<{ title: string; key: SessionCategory }> = [
      { title: "Core", key: "core" },
      { title: "Active", key: "active" },
      { title: "Preferences", key: "preferences" },
      { title: "Recent", key: "recent" },
    ];

    let index = 1;
    for (const section of sections) {
      const rows = results.filter((result) => result.category === section.key);
      if (rows.length === 0) {
        continue;
      }
      clack.log.info(`\n${ui.bold(section.title)}`, clackOutput);
      for (const result of rows) {
        clack.log.info(
          `${index}. [${result.entry.type}] ${result.entry.subject}: ${result.entry.content}`,
          clackOutput,
        );
        clack.log.info(
          `   confidence=${result.entry.confidence} | ${formatAge(result.entry.created_at, now)} | ${formatRecallCount(result.entry.recall_count)}`,
          clackOutput,
        );
        clack.log.info(`   tags: ${result.entry.tags.length > 0 ? result.entry.tags.join(", ") : "none"}`, clackOutput);
        index += 1;
      }
    }
    return;
  }

  let index = 1;
  for (const result of results) {
    clack.log.info(`${index}. [${result.entry.type}] ${result.entry.subject}: ${result.entry.content}`, clackOutput);
    clack.log.info(
      `   confidence=${result.entry.confidence} | ${formatAge(result.entry.created_at, now)} | ${formatRecallCount(result.entry.recall_count)}`,
      clackOutput,
    );
    clack.log.info(`   tags: ${result.entry.tags.length > 0 ? result.entry.tags.join(", ") : "none"}`, clackOutput);
    index += 1;
  }
}

export async function runRecallCommand(
  queryInput: string | undefined,
  options: RecallCommandOptions,
  deps?: Partial<RecallCommandDeps>,
): Promise<{ exitCode: number; payload: RecallCommandResponse }> {
  const resolvedDeps: RecallCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps?.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    recallFn: deps?.recallFn ?? recall,
    updateRecallMetadataFn: deps?.updateRecallMetadataFn ?? updateRecallMetadata,
    nowFn: deps?.nowFn ?? (() => new Date()),
  };

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const now = resolvedDeps.nowFn();
  const queryText = queryInput?.trim() ?? "";
  const context = options.context?.trim() || "default";
  const isSessionStart = context === "session-start";

  if (!queryText && !isSessionStart) {
    throw new Error("Provide a query or use --context session-start.");
  }

  if (options.noBoost && !queryText) {
    throw new Error("--no-boost requires a query.");
  }

  const limit = parsePositiveInt(options.limit, DEFAULT_LIMIT, "--limit");
  const budget = options.budget !== undefined ? parsePositiveInt(options.budget, DEFAULT_LIMIT, "--budget") : undefined;

  const parsedTypes = parseCsv(options.type);
  if (parsedTypes.some((type) => !(KNOWLEDGE_TYPES as readonly string[]).includes(type))) {
    throw new Error(`--type must be comma-separated values from: ${KNOWLEDGE_TYPES.join(", ")}`);
  }

  const types = parsedTypes;
  const tags = parseCsv(options.tags);

  let minConfidence: ConfidenceLevel | undefined;
  if (options.minConfidence) {
    const normalized = options.minConfidence.trim().toLowerCase();
    if (!(CONFIDENCE_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error(`--min-confidence must be one of: ${CONFIDENCE_LEVELS.join(", ")}`);
    }
    minConfidence = normalized as ConfidenceLevel;
  }

  let expiry: Expiry | undefined;
  if (options.expiry) {
    const normalized = options.expiry.trim().toLowerCase();
    if (!(EXPIRY_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error(`--expiry must be one of: ${EXPIRY_LEVELS.join(", ")}`);
    }
    expiry = normalized as Expiry;
  }

  let scope: Scope | undefined;
  if (options.scope) {
    const normalized = options.scope.trim().toLowerCase();
    if (!(SCOPE_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error(`--scope must be one of: ${SCOPE_LEVELS.join(", ")}`);
    }
    scope = normalized as Scope;
  }

  const sinceIso = parseSinceToIso(options.since, now);
  const queryForRecall: RecallQuery = {
    text: queryText ? shapeRecallText(queryText, context) : undefined,
    limit: isSessionStart ? SESSION_CANDIDATE_LIMIT : limit,
    types: types.length > 0 ? (types as RecallQuery["types"]) : undefined,
    tags: tags.length > 0 ? tags : undefined,
    minConfidence,
    since: sinceIso,
    expiry,
    scope: scope ?? "private",
    noBoost: options.noBoost === true,
    noUpdate: true,
    context,
    budget,
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);

    const apiKey = queryText ? resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env) : "";
    const startedAt = Date.now();

    let finalResults: RecallCommandResult[] = [];
    let budgetUsed = 0;

    if (isSessionStart) {
      const coreResults = await resolvedDeps.recallFn(
        db,
        {
          ...queryForRecall,
          limit: CORE_CANDIDATE_LIMIT,
          expiry: "core",
        },
        apiKey,
      );

      const nonCoreResults = await resolvedDeps.recallFn(
        db,
        {
          ...queryForRecall,
          limit: SESSION_CANDIDATE_LIMIT,
          expiry: undefined,
        },
        apiKey,
      );

      const coreIds = new Set(coreResults.map((item) => item.entry.id));
      const filteredNonCore = nonCoreResults.filter((item) => item.entry.expiry !== "core" && !coreIds.has(item.entry.id));
      const grouped = buildSessionStartResults(coreResults, filteredNonCore, budget, limit);
      finalResults = grouped.results;
      budgetUsed = grouped.budgetUsed;
    } else {
      const baseResults = await resolvedDeps.recallFn(db, queryForRecall, apiKey);
      const consumed = budget === undefined ? null : consumeByBudget(baseResults, budget);
      const budgeted = budget === undefined ? baseResults : consumed.selected;
      budgetUsed =
        budget === undefined ? budgeted.reduce((sum, item) => sum + estimateEntryTokens(item), 0) : consumed.used;
      finalResults = budgeted.map((result) => ({ ...result }));
    }

    if (!options.noUpdate && finalResults.length > 0) {
      const ids = finalResults.map((result) => result.entry.id);
      await resolvedDeps.updateRecallMetadataFn(db, ids, now);
      const nowIso = now.toISOString();
      for (const result of finalResults) {
        result.entry.recall_count += 1;
        result.entry.last_recalled_at = nowIso;
      }
    }

    const stripped = finalResults.map((result) => stripEmbedding(result));
    const payload: RecallCommandResponse = {
      query: queryText,
      results: stripped,
      total: stripped.length,
      budget_used: budgetUsed,
      budget_limit: budget ?? null,
    };

    const elapsedMs = Date.now() - startedAt;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      printHumanResults(stripped, elapsedMs, now, isSessionStart);
    }

    clack.outro(undefined, clackOutput);
    return {
      exitCode: 0,
      payload,
    };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
