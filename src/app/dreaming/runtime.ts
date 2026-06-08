import { createDatabase } from "../../adapters/db/client.js";
import { createDreamPort } from "../../adapters/db/dreaming-port.js";
import { createEmbeddingClient, createLazyEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmCredentials, resolveModel } from "../../adapters/llm.js";
import { readConfig, type ResolvedAgenrConfig } from "../../config.js";
import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import type { DreamRunProposal } from "../../core/dreaming/types.js";
import type { Logger } from "../../logger.js";
import { applyProposalToDurables, loadActiveProposalDurables } from "./proposal-review.js";
import type { DreamHealthStats, DreamProfileSnapshot, DreamProposalBacklogItem, DreamProposalBacklogQuery, DreamRunRecord } from "./ports.js";
import type { DreamPort } from "./ports.js";
import type { Durable } from "../../core/types.js";
import type { DreamProgressReporter } from "./progress.js";
import { backupDatabaseFile, runDream, type DreamRunOptions, type DreamRunResult } from "./service.js";

/**
 * Runtime input accepted by the dreaming CLI and other top-level entry points.
 */
export interface DreamRuntimeOptions extends DreamRunOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: DreamProgressReporter;
  logger?: Logger;
}

/**
 * Resolves configuration and adapter instances, then runs one dreaming pipeline.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Final dreaming run result.
 */
export async function runDreamRuntime(input: DreamRuntimeOptions): Promise<DreamRunResult> {
  const runtime = loadRuntimeConfig(input);
  // Construction is deferred until the first insert so dry runs never need a credential.
  const embedding = createLazyEmbeddingClient(() => createEmbeddingClient(resolveEmbeddingApiKey(runtime.config), resolveEmbeddingModel(runtime.config)));
  const createExtractLlm = createConfiguredLlmFactory(runtime.config, input.env, "dreaming");
  const createClaimExtractionLlm = createConfiguredLlmFactory(runtime.config, input.env, "claim");
  return withDreamPort(runtime.dbPath, async (port) =>
    runDream(input, {
      port,
      dbPath: runtime.dbPath,
      config: runtime.config,
      createExtractLlm,
      createClaimExtractionLlm,
      embedding,
      backupDb: backupDatabaseFile,
      reportProgress: input.onProgress,
      logger: input.logger,
    }),
  );
}

/**
 * Loads the current dreaming status without starting a run.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Current health summary and the latest persisted dreaming run.
 */
export async function loadDreamStatusRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamStatusRuntimeView> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => {
    const [health, lastRun, recentLightApplyRunsWithoutBackup] = await Promise.all([
      port.getHealthStats(),
      port.getLastRun(),
      countRecentLightApplyRunsWithoutBackup(port),
    ]);

    return { health, lastRun, recentLightApplyRunsWithoutBackup };
  });
}

/** Dreaming health summary returned by `agenr dream status`. */
export interface DreamStatusRuntimeView {
  health: DreamHealthStats;
  lastRun: DreamRunRecord | null;
  recentLightApplyRunsWithoutBackup: number;
}

/** Active profile bundle returned by `agenr dream profile`. */
export interface DreamProfileRuntimeView {
  snapshot: DreamProfileSnapshot | null;
  profileDurables: Durable[];
  directiveDurables: Durable[];
}

/** Human-readable memory summary data returned by `agenr dream summary`. */
export interface DreamSummaryRuntimeView extends DreamProfileRuntimeView {
  health: DreamHealthStats;
  openProposalCount: number;
}

/**
 * Loads the active profile snapshot and its hydrated durable bundle.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Active profile bundle, or an empty view when none exists.
 */
export async function loadDreamProfileRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamProfileRuntimeView> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => loadDreamProfileView(port));
}

/**
 * Loads the operator-facing current-memory summary.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Summary view over the active profile and corpus health.
 */
export async function loadDreamSummaryRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamSummaryRuntimeView> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => {
    const [profile, health] = await Promise.all([loadDreamProfileView(port), port.getHealthStats()]);
    return {
      ...profile,
      health,
      openProposalCount: health.proposalBacklogCount,
    };
  });
}

/**
 * Loads recent dreaming run history for CLI inspection.
 *
 * @param input - Runtime input with optional db-path and row limit.
 * @returns Recent persisted dreaming runs ordered newest first.
 */
export async function loadDreamHistoryRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv; limit?: number }): Promise<DreamRunRecord[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunHistory(input.limit));
}

/**
 * Loads the action audit trail for one dreaming run.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded dreaming actions for the requested run.
 */
export async function loadDreamActionsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamRunAction[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunActions(input.runId));
}

/**
 * Loads the action audit trail for one dreaming run with affected durable previews.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded actions plus hydrated durables for each action.
 */
export async function loadDreamActionViewsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamRunActionView[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => {
    const actions = await port.getRunActions(input.runId);
    const durableIds = Array.from(new Set(actions.flatMap((action) => action.durableIds)));
    const durables = await port.getDurables(durableIds, { includeInactive: true });
    const byId = new Map(durables.map((durable) => [durable.id, durable]));
    return actions.map((action) => ({
      ...action,
      details: action.details ?? null,
      durables: action.durableIds.flatMap((durableId) => {
        const durable = byId.get(durableId);
        return durable ? [durable] : [];
      }),
    }));
  });
}

/**
 * Operator-facing dreaming action view with affected durable previews.
 */
export interface DreamRunActionView extends DreamRunAction {
  /** Structured action details, when persisted by the dreaming stage. */
  details: Record<string, unknown> | null;
  /** Hydrated affected durables, including rows later staled by the same run. */
  durables: Durable[];
}

/**
 * Loads the unresolved proposal trail for one dreaming run.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded unresolved proposals for the requested run.
 */
export async function loadDreamProposalsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamRunProposal[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunProposals(input.runId));
}

/**
 * Loads the global proposal backlog across runs for operator review.
 *
 * @param input - Runtime input with optional db-path and backlog filters.
 * @returns Joined backlog rows ordered for review.
 */
export async function loadDreamBacklogRuntime(
  input: { dbPath?: string; env?: NodeJS.ProcessEnv } & DreamProposalBacklogQuery,
): Promise<DreamProposalBacklogItem[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.listProposalBacklog(input));
}

/**
 * Result of one dreaming proposal review decision.
 */
export interface DreamProposalReviewResult {
  proposal: DreamRunProposal;
  updatedDurableIds: string[];
  backupPath: string | null;
}

/**
 * Applies or rejects one open dreaming proposal using the claim-key mutation path.
 *
 * @param input - Runtime input with the target proposal, decision, and review reason.
 * @returns Final proposal state plus any affected durable IDs and backup path.
 */
export async function reviewDreamProposalRuntime(input: {
  proposalId: string;
  decision: "apply" | "reject";
  reason: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DreamProposalReviewResult> {
  const runtime = loadRuntimeConfig(input);
  const database = await createDatabase(runtime.dbPath);
  const port = createDreamPort(database);

  try {
    const proposal = await port.getProposal(input.proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${input.proposalId}.`);
    }
    if (proposal.reviewStatus !== "open") {
      throw new Error(`Proposal ${proposal.id} was already reviewed as ${proposal.reviewStatus}.`);
    }

    const reviewReason = input.reason.trim();
    if (reviewReason.length === 0) {
      throw new Error("Review reason is required.");
    }

    const reviewedAt = new Date().toISOString();
    const backupPath = input.decision === "apply" && runtime.dbPath !== ":memory:" ? await backupDatabaseFile(runtime.dbPath) : null;
    const updatedDurableIds: string[] = [];

    await database.execute("BEGIN IMMEDIATE");
    try {
      if (input.decision === "apply") {
        const { activeDurables, inactiveDurableIds } = await loadActiveProposalDurables(proposal, (durableId) => port.getDurable(durableId));
        if (inactiveDurableIds.length > 0) {
          throw new Error(`Proposal ${proposal.id} can no longer update missing or inactive durable ${inactiveDurableIds[0]}.`);
        }
        const applied = await applyProposalToDurables(
          {
            proposal,
            activeDurables,
            reviewReason,
            reviewedAt,
            actionReviewStatus: "applied",
            requireAllUpdates: true,
          },
          {
            updateDurable: (durableId, fields) => port.updateDurable(durableId, fields),
            logRunAction: (action) => port.logRunAction(action),
          },
        );
        updatedDurableIds.push(...applied.updatedDurableIds);
      }

      const reviewed = await port.reviewProposal({
        proposalId: proposal.id,
        status: input.decision === "apply" ? "applied" : "rejected",
        reason: reviewReason,
        reviewedAt,
        appliedActionCount: input.decision === "apply" ? 1 : 0,
      });
      if (!reviewed) {
        throw new Error(`Proposal ${proposal.id} could not be marked ${input.decision} because it is no longer open.`);
      }

      await database.execute("COMMIT");
    } catch (error) {
      await database.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const reviewedProposal = await port.getProposal(proposal.id);
    if (!reviewedProposal) {
      throw new Error(`Proposal ${proposal.id} disappeared after review.`);
    }

    return {
      proposal: reviewedProposal,
      updatedDurableIds,
      backupPath,
    };
  } finally {
    await database.close();
  }
}

/**
 * Opens one database session and exposes the dreaming port to a callback.
 *
 * @param dbPath - Database path to open.
 * @param fn - Callback that receives the dreaming port.
 * @returns Callback result after the database is closed.
 */
async function withDreamPort<T>(dbPath: string, fn: (port: DreamPort) => Promise<T>): Promise<T> {
  const database = await createDatabase(dbPath);
  const port = createDreamPort(database);

  try {
    return await fn(port);
  } finally {
    await database.close();
  }
}

/** Loads the active profile snapshot and its durable contents. */
async function loadDreamProfileView(port: DreamPort): Promise<DreamProfileRuntimeView> {
  const snapshot = await port.getActiveProfileSnapshot();
  if (!snapshot) {
    return {
      snapshot: null,
      profileDurables: [],
      directiveDurables: [],
    };
  }

  const [profileDurables, directiveDurables] = await Promise.all([port.getDurables(snapshot.durableIds), port.getDurables(snapshot.directiveIds)]);
  return {
    snapshot,
    profileDurables,
    directiveDurables,
  };
}

/** Loads resolved runtime config and applies command/environment db overrides. */
function loadRuntimeConfig(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): { dbPath: string; config: ResolvedAgenrConfig } {
  const dbPathOverride = normalizeOptionalString(input.dbPath) ?? normalizeOptionalString(input.env?.AGENR_DB_PATH);
  const configPathOverride = normalizeOptionalString(input.env?.AGENR_CONFIG_PATH);
  const config = readConfig({
    ...(input.env ? { env: input.env } : {}),
    ...(configPathOverride ? { configPath: configPathOverride } : {}),
    ...(dbPathOverride ? { dbPath: dbPathOverride } : {}),
  });
  const dbPath = dbPathOverride ?? config.dbPath;
  return { dbPath, config };
}

/** Creates an LLM client factory for the configured dreaming or claim stage model. */
function createConfiguredLlmFactory(
  config: ResolvedAgenrConfig,
  env: NodeJS.ProcessEnv | undefined,
  stage: "dreaming" | "claim",
): () => ReturnType<typeof createLlmClient> {
  return () => {
    const { provider, modelId } = resolveModel(config, stage);
    const credentials = resolveLlmCredentials(config, provider, env ?? process.env);
    return createLlmClient(provider, modelId, { apiKey: credentials.apiKey });
  };
}

/** Normalizes an optional runtime string override. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Number of most-recent applied light runs inspected for the backup warning. */
const RECENT_LIGHT_APPLY_SAMPLE_SIZE = 5;

/** Counts, within the most recent applied light runs, how many skipped the pre-apply backup. */
async function countRecentLightApplyRunsWithoutBackup(port: DreamPort): Promise<number> {
  const runs = await port.getRecentAppliedLightRuns(RECENT_LIGHT_APPLY_SAMPLE_SIZE);
  return runs.filter((run) => run.summaryJson?.backupSkipped === true).length;
}
