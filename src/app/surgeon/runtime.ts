import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

import { createDatabase } from "../../adapters/db/client.js";
import { createSurgeonPort } from "../../adapters/db/surgeon-port.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmCredentials, resolveModel } from "../../adapters/llm.js";
import {
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  type AgenrConfig,
  readConfig,
  resolveClaimExtractionConfig,
} from "../../config.js";
import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import { resolveSurgeonPassSequence, type ImplementedSurgeonPass, type SurgeonRunPreset } from "../../core/surgeon/domain/run-presets.js";
import type { SurgeonHealthStats, SurgeonRunRecord } from "./ports.js";
import type { SurgeonProgressReporter } from "./progress.js";
import {
  runSurgeon,
  runSurgeonPreset,
  type SurgeonPresetRunOptions,
  type SurgeonPresetRunResult,
  type SurgeonRunOptions,
  type SurgeonRunResult,
} from "./service.js";

const DEFAULT_SURGEON_PROVIDER = "openai";
const DEFAULT_SURGEON_MODEL = "gpt-5.4-mini";

/** Stringly-typed pi-ai model resolver used by the surgeon runtime. */
type GetModelWithStrings = (provider: string, modelId: string) => Model<Api>;

const getModelWithStrings = getModel as unknown as GetModelWithStrings;

/**
 * Runtime input accepted by the surgeon CLI and other top-level entry points.
 */
export interface SurgeonRuntimeOptions extends Omit<SurgeonRunOptions, "pass"> {
  pass?: ImplementedSurgeonPass;
  preset?: SurgeonRunPreset;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: SurgeonProgressReporter;
}

/**
 * Runtime result for either a single pass or a composed preset.
 */
export type SurgeonRuntimeResult = SurgeonRunResult | SurgeonPresetRunResult;

/**
 * Resolves configuration and adapter instances, then runs one surgeon pass or preset.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Final surgeon run or preset result.
 */
export async function runSurgeonRuntime(input: SurgeonRuntimeOptions): Promise<SurgeonRuntimeResult> {
  const runtime = loadRuntimeConfig(input);
  const database = await createDatabase(runtime.dbPath);
  const port = createSurgeonPort(database);

  try {
    const selection = resolveRuntimeSelection(input);
    const modelSelection = resolveSurgeonModel(runtime.config, input);
    const claimExtractionConfig = selection.includesClaimKeyQuality ? resolveClaimExtractionConfig(runtime.config) : { enabled: false };
    const claimModelSelection = claimExtractionConfig.enabled ? resolveModel(runtime.config, "claim") : null;
    const model = getModelWithStrings(modelSelection.provider, modelSelection.modelId);
    const credentials = resolveLlmCredentials(runtime.config, modelSelection.provider, input.env ?? process.env);
    const claimCredentials =
      claimModelSelection && claimModelSelection.provider === modelSelection.provider
        ? credentials
        : claimModelSelection
          ? resolveLlmCredentials(runtime.config, claimModelSelection.provider, input.env ?? process.env)
          : null;

    let recallPorts: ReturnType<typeof createRecallAdapter> | undefined;
    try {
      const embeddingKey = resolveEmbeddingApiKey(runtime.config);
      const embeddingModel = resolveEmbeddingModel(runtime.config);
      recallPorts = createRecallAdapter(database, createEmbeddingClient(embeddingKey, embeddingModel));
    } catch {
      recallPorts = undefined;
    }

    const workflowDeps = {
      port,
      dbPath: runtime.dbPath,
      config: runtime.config,
      model,
      getApiKey: async () => credentials.apiKey,
      createClaimExtractionLlm:
        claimModelSelection && claimCredentials
          ? () => createLlmClient(claimModelSelection.provider, claimModelSelection.modelId, { apiKey: claimCredentials.apiKey })
          : undefined,
      recallPorts,
      backupDb: backupDatabaseFile,
      reportProgress: input.onProgress,
    };
    const sharedOptions = {
      model: modelSelection.modelId,
      provider: modelSelection.provider,
      project: input.project,
      type: input.type,
      claimKeyPrefix: input.claimKeyPrefix,
      entryIds: input.entryIds,
      includeInactive: input.includeInactive,
      budget: input.budget,
      contextLimit: input.contextLimit,
      apply: input.apply,
      skipEvaluatedDays: input.skipEvaluatedDays,
      verbose: input.verbose,
      tracePath: input.tracePath,
      json: input.json,
      signal: input.signal,
    };

    if (selection.kind === "preset") {
      const presetOptions: SurgeonPresetRunOptions = {
        ...sharedOptions,
        preset: selection.preset,
      };

      return await runSurgeonPreset(presetOptions, workflowDeps);
    }

    const runOptions: SurgeonRunOptions = {
      ...sharedOptions,
      pass: selection.pass,
    };

    return await runSurgeon(runOptions, workflowDeps);
  } finally {
    await database.close();
  }
}

/**
 * Loads the current surgeon status without starting a run.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Current health summary and the latest persisted surgeon run.
 */
export async function loadSurgeonStatusRuntime(input: {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ health: SurgeonHealthStats; lastRun: SurgeonRunRecord | null }> {
  const runtime = loadRuntimeConfig(input);
  const database = await createDatabase(runtime.dbPath);
  const port = createSurgeonPort(database);

  try {
    const protection = resolveProtectionConfig(runtime.config);
    const [health, lastRun] = await Promise.all([
      port.getHealthStats({
        protectRecalledDays: protection.protectRecalledDays,
        protectMinImportance: protection.protectMinImportance,
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      }),
      port.getLastRun(),
    ]);

    return { health, lastRun };
  } finally {
    await database.close();
  }
}

/**
 * Loads recent surgeon run history for CLI inspection.
 *
 * @param input - Runtime input with optional db-path and row limit.
 * @returns Recent persisted surgeon runs ordered newest first.
 */
export async function loadSurgeonHistoryRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv; limit?: number }): Promise<SurgeonRunRecord[]> {
  const runtime = loadRuntimeConfig(input);
  const database = await createDatabase(runtime.dbPath);
  const port = createSurgeonPort(database);

  try {
    return await port.getRunHistory(input.limit);
  } finally {
    await database.close();
  }
}

/**
 * Loads the action audit trail for one surgeon run.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded surgeon actions for the requested run.
 */
export async function loadSurgeonActionsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<SurgeonRunAction[]> {
  const runtime = loadRuntimeConfig(input);
  const database = await createDatabase(runtime.dbPath);
  const port = createSurgeonPort(database);

  try {
    return await port.getRunActions(input.runId);
  } finally {
    await database.close();
  }
}

/**
 * Resolves config and db-path overrides for surgeon runtime helpers.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Loaded config and the effective database path.
 */
function loadRuntimeConfig(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): { config: AgenrConfig; dbPath: string } {
  const dbPathOverride = normalizeOptionalString(input.dbPath) ?? normalizeOptionalString(input.env?.AGENR_DB_PATH);
  const configPathOverride = normalizeOptionalString(input.env?.AGENR_CONFIG_PATH);
  const config = readConfig({
    configPath: configPathOverride,
    dbPath: dbPathOverride,
  });

  return {
    config,
    dbPath: dbPathOverride ?? config.dbPath,
  };
}

/**
 * Resolves provider and model precedence for the surgeon runtime.
 *
 * @param config - Loaded agenr configuration.
 * @param input - One-shot surgeon run input.
 * @returns Provider and model ID used for the run.
 */
function resolveSurgeonModel(config: AgenrConfig, input: { provider?: string; model?: string }): { provider: string; modelId: string } {
  const surgeonModel = config.surgeon?.model;

  return {
    provider:
      normalizeOptionalString(input.provider) ??
      normalizeOptionalString(surgeonModel?.provider) ??
      normalizeOptionalString(config.provider) ??
      DEFAULT_SURGEON_PROVIDER,
    modelId:
      normalizeOptionalString(input.model) ?? normalizeOptionalString(surgeonModel?.model) ?? normalizeOptionalString(config.model) ?? DEFAULT_SURGEON_MODEL,
  };
}

/**
 * Resolves whether the runtime should execute one pass or a composed preset.
 *
 * @param input - Raw runtime selection fields.
 * @returns Discriminated run selection plus claim-key-quality availability.
 */
function resolveRuntimeSelection(input: {
  pass?: ImplementedSurgeonPass;
  preset?: SurgeonRunPreset;
}):
  | { kind: "pass"; pass: ImplementedSurgeonPass; includesClaimKeyQuality: boolean }
  | { kind: "preset"; preset: SurgeonRunPreset; includesClaimKeyQuality: boolean } {
  if (input.preset && input.pass) {
    throw new Error("Specify either a surgeon pass or a preset, not both.");
  }

  if (input.preset) {
    const sequence = resolveSurgeonPassSequence(input.preset);
    return {
      kind: "preset",
      preset: input.preset,
      includesClaimKeyQuality: sequence.includes("claim_key_quality"),
    };
  }

  const pass = input.pass ?? "retirement";
  return {
    kind: "pass",
    pass,
    includesClaimKeyQuality: pass === "claim_key_quality",
  };
}

/**
 * Resolves the protection settings used by status queries.
 *
 * @param config - Loaded agenr configuration.
 * @returns Hard-retirement protection thresholds.
 */
function resolveProtectionConfig(config: AgenrConfig): { protectRecalledDays: number; protectMinImportance: number; skipRecentlyEvaluatedDays: number } {
  const passConfig = config.surgeon?.passes?.retirement;

  return {
    protectRecalledDays: normalizeNonNegativeInteger(passConfig?.protectRecalledDays) ?? DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
    protectMinImportance: normalizeNonNegativeInteger(passConfig?.protectMinImportance) ?? DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
    skipRecentlyEvaluatedDays: normalizeNonNegativeInteger(passConfig?.skipRecentlyEvaluatedDays) ?? DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  };
}

/**
 * Creates a timestamped filesystem backup of the SQLite database and sidecars.
 *
 * @param dbPath - SQLite database path or file URL.
 * @returns Absolute path to the copied backup database.
 */
async function backupDatabaseFile(dbPath: string): Promise<string> {
  if (dbPath === ":memory:") {
    throw new Error("Cannot back up in-memory databases.");
  }

  const sourcePath = resolveFilesystemPath(dbPath);
  const backupPath = `${sourcePath}.surgeon-backup-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;

  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath);
  await copySidecarIfPresent(`${sourcePath}-wal`, `${backupPath}-wal`);
  await copySidecarIfPresent(`${sourcePath}-shm`, `${backupPath}-shm`);

  return backupPath;
}

/**
 * Copies one SQLite sidecar file when it exists.
 *
 * @param sourcePath - Existing sidecar file path.
 * @param targetPath - Backup sidecar file path.
 */
async function copySidecarIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

/**
 * Resolves raw filesystem or file-URL database paths into disk paths.
 *
 * @param value - Raw SQLite database path.
 * @returns Absolute or already-normalized filesystem path.
 */
function resolveFilesystemPath(value: string): string {
  if (!value.startsWith("file:")) {
    return path.resolve(value);
  }

  try {
    return fileURLToPath(value);
  } catch {
    return path.resolve(value.slice("file:".length));
  }
}

/**
 * Narrows an unknown error to a missing-file condition.
 *
 * @param error - Unknown error thrown by a filesystem operation.
 * @returns True when the error represents a missing file.
 */
function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Trims optional strings and drops empty values.
 *
 * @param value - Raw optional string input.
 * @returns Trimmed string or undefined.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalizes an optional non-negative integer.
 *
 * @param value - Raw numeric value.
 * @returns Integer when valid, otherwise undefined.
 */
function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (!Number.isFinite(value) || (value as number) < 0) {
    return undefined;
  }

  return Math.floor(value as number);
}
