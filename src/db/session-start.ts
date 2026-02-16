import type { Client } from "@libsql/client";
import type { RecallCommandResult, RecallQuery, RecallResult } from "../types.js";
import { recall } from "./recall.js";

export const DEFAULT_SESSION_CANDIDATE_LIMIT = 500;
export const DEFAULT_CORE_CANDIDATE_LIMIT = 5000;

export type SessionCategory = "core" | "active" | "preferences" | "recent";

export interface SessionStartRecallOptions {
  query: RecallQuery;
  apiKey: string;
  nonCoreLimit: number;
  budget?: number;
  recallFn?: typeof recall;
  nonCoreCandidateLimit?: number;
  coreCandidateLimit?: number;
}

export interface SessionStartRecallResult {
  results: RecallCommandResult[];
  budgetUsed: number;
}

export function estimateEntryTokens(result: RecallResult): number {
  const tags = result.entry.tags.join(" ");
  const blob = [
    result.entry.type,
    result.entry.subject,
    result.entry.content,
    result.entry.importance,
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

function classifySessionCategory(result: RecallResult): SessionCategory {
  if (result.entry.expiry === "core") {
    return "core";
  }

  if (result.entry.type === "todo") {
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
): SessionStartRecallResult {
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

export async function sessionStartRecall(db: Client, options: SessionStartRecallOptions): Promise<SessionStartRecallResult> {
  const recallFn = options.recallFn ?? recall;
  const baseQuery: RecallQuery = {
    ...options.query,
    context: "session-start",
    noUpdate: true,
  };

  const coreResults = await recallFn(
    db,
    {
      ...baseQuery,
      limit: options.coreCandidateLimit ?? DEFAULT_CORE_CANDIDATE_LIMIT,
      expiry: "core",
    },
    options.apiKey,
  );

  const nonCoreResults = await recallFn(
    db,
    {
      ...baseQuery,
      limit: options.nonCoreCandidateLimit ?? DEFAULT_SESSION_CANDIDATE_LIMIT,
      expiry: undefined,
    },
    options.apiKey,
  );

  const coreIds = new Set(coreResults.map((item) => item.entry.id));
  const filteredNonCore = nonCoreResults.filter((item) => item.entry.expiry !== "core" && !coreIds.has(item.entry.id));
  return buildSessionStartResults(coreResults, filteredNonCore, options.budget, options.nonCoreLimit);
}
