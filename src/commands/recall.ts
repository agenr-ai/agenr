import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { recall, shapeRecallText, updateRecallMetadata } from "../db/recall.js";
import { estimateEntryTokens, sessionStartRecall } from "../db/session-start.js";
import type { SessionCategory } from "../db/session-start.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { normalizeKnowledgePlatform } from "../platform.js";
import { parseProjectList } from "../project.js";
import { EXPIRY_LEVELS, IMPORTANCE_MAX, IMPORTANCE_MIN, KNOWLEDGE_PLATFORMS, KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import type {
  Expiry,
  KnowledgePlatform,
  RecallCommandResponse,
  RecallCommandResult,
  RecallQuery,
  Scope,
} from "../types.js";
import { banner, ui } from "../ui.js";

const DEFAULT_LIMIT = 10;

export { estimateEntryTokens } from "../db/session-start.js";

export interface RecallCommandOptions {
  limit?: number | string;
  type?: string;
  tags?: string;
  minImportance?: string;
  since?: string;
  expiry?: string;
  platform?: string;
  project?: string | string[];
  excludeProject?: string | string[];
  strict?: boolean;
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

function hasAnyProjectParts(input: string | string[] | undefined): boolean {
  const rawItems = Array.isArray(input) ? input : input ? [input] : [];
  return rawItems.some((value) => String(value).split(",").some((part) => part.trim().length > 0));
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

function stripEmbedding<T extends RecallCommandResult>(result: T): T {
  const { embedding, ...entryWithoutEmbedding } = result.entry;
  return {
    ...result,
    entry: entryWithoutEmbedding,
  } as T;
}

function consumeByBudget<T extends RecallCommandResult>(results: T[], budget: number): { selected: T[]; used: number } {
  if (budget <= 0) {
    return { selected: [], used: 0 };
  }

  const selected: T[] = [];
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
          `   importance=${result.entry.importance} | ${formatAge(result.entry.created_at, now)} | ${formatRecallCount(result.entry.recall_count)}`,
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
      `   importance=${result.entry.importance} | ${formatAge(result.entry.created_at, now)} | ${formatRecallCount(result.entry.recall_count)}`,
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

  let minImportance: number | undefined;
  if (options.minImportance !== undefined && String(options.minImportance).trim().length > 0) {
    const parsed = Number(options.minImportance);
    if (!Number.isInteger(parsed) || parsed < IMPORTANCE_MIN || parsed > IMPORTANCE_MAX) {
      throw new Error(`--min-importance must be an integer between ${IMPORTANCE_MIN} and ${IMPORTANCE_MAX}`);
    }
    minImportance = parsed;
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

  let platform: KnowledgePlatform | undefined;
  if (options.platform) {
    const normalized = normalizeKnowledgePlatform(options.platform);
    if (!normalized) {
      throw new Error(`--platform must be one of: ${KNOWLEDGE_PLATFORMS.join(", ")}`);
    }
    platform = normalized;
  }

  const parsedProject = parseProjectList(options.project);
  const parsedExcludeProject = parseProjectList(options.excludeProject);
  if (hasAnyProjectParts(options.project) && parsedProject.length === 0) {
    throw new Error("--project must be a non-empty string (or comma-separated list).");
  }
  if (hasAnyProjectParts(options.excludeProject) && parsedExcludeProject.length === 0) {
    throw new Error("--exclude-project must be a non-empty string (or comma-separated list).");
  }

  const project = parsedProject.length > 0 ? parsedProject : undefined;
  const excludeProject = parsedExcludeProject.length > 0 ? parsedExcludeProject : undefined;
  const projectStrict = options.strict === true && Boolean(project && project.length > 0);

  const sinceIso = parseSinceToIso(options.since, now);
  const queryForRecall: RecallQuery = {
    text: queryText ? shapeRecallText(queryText, context) : undefined,
    limit,
    types: types.length > 0 ? (types as RecallQuery["types"]) : undefined,
    tags: tags.length > 0 ? tags : undefined,
    minImportance,
    since: sinceIso,
    expiry,
    scope: scope ?? "private",
    platform,
    project,
    excludeProject,
    projectStrict: projectStrict ? true : undefined,
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
      const grouped = await sessionStartRecall(db, {
        query: queryForRecall,
        apiKey,
        recallFn: resolvedDeps.recallFn,
        budget,
        nonCoreLimit: limit,
      });
      finalResults = grouped.results;
      budgetUsed = grouped.budgetUsed;
    } else {
      const baseResults = await resolvedDeps.recallFn(db, queryForRecall, apiKey);
      if (budget === undefined) {
        budgetUsed = baseResults.reduce((sum, item) => sum + estimateEntryTokens(item), 0);
        finalResults = baseResults.map((result) => ({ ...result }));
      } else {
        const consumed = consumeByBudget(baseResults, budget);
        budgetUsed = consumed.used;
        finalResults = consumed.selected.map((result) => ({ ...result }));
      }
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
      budget_limit: budget,
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
