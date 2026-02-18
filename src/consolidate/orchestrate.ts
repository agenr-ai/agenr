import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client, InValue } from "@libsql/client";
import { walCheckpoint } from "../db/client.js";
import { rebuildVectorIndex } from "../db/vector-index.js";
import type { KnowledgePlatform, LlmClient } from "../types.js";
import { buildClusters, type Cluster } from "./cluster.js";
import { mergeCluster } from "./merge.js";
import { consolidateRules, countActiveEntries, type ConsolidationStats } from "./rules.js";
import { isShutdownRequested } from "../shutdown.js";

export const CONSOLIDATION_CHECKPOINT_PATH = path.join(os.homedir(), ".agenr", "consolidation-checkpoint.json");

const DEFAULT_PHASE1_TYPES = ["fact", "decision", "preference", "lesson", "event", "todo", "relationship"] as const;
const DEFAULT_MIN_CLUSTER = 2;
const DEFAULT_PHASE1_SIM_THRESHOLD = 0.82;
const DEFAULT_PHASE2_SIM_THRESHOLD = 0.88;
const DEFAULT_PHASE1_MAX_CLUSTER_SIZE = 8;
const DEFAULT_PHASE2_MAX_CLUSTER_SIZE = 6;

interface ClusterProcessingStats {
  entries: number;
  clustersFound: number;
  skippedByResume: number;
  clustersProcessed: number;
  clustersMerged: number;
  mergesFlagged: number;
  llmCalls: number;
  entriesConsolidatedFrom: number;
  canonicalEntriesCreated: number;
}

export interface Phase1TypeStats extends ClusterProcessingStats {
  type: string;
}

export interface ConsolidationEstimate {
  totalClusters: number;
  estimatedLlmCalls: number;
  phase1ByType: Array<{ type: string; entries: number; clusters: number }>;
  phase2Clusters: number;
}

export interface ConsolidationProgress {
  resumed: boolean;
  checkpointPath: string;
  partial: boolean;
  batchLimit?: number;
  processedClusters: number;
  remainingClusters: number;
  resumeFrom?: {
    phase: number;
    typeIndex: number;
    clusterIndex: number;
  };
}

export interface ConsolidationOrchestratorReport extends ConsolidationStats {
  entriesAfterRules: number;
  entriesAfter: number;
  estimate: ConsolidationEstimate;
  phase1: {
    totals: ClusterProcessingStats;
    types: Phase1TypeStats[];
  };
  phase2?: ClusterProcessingStats;
  progress: ConsolidationProgress;
  summary: {
    totalLlmCalls: number;
    totalFlagged: number;
    totalCanonicalEntriesCreated: number;
    totalEntriesConsolidatedFrom: number;
  };
}

export interface ConsolidationOrchestratorOptions {
  dryRun?: boolean;
  verbose?: boolean;
  rulesOnly?: boolean;
  platform?: KnowledgePlatform;
  minCluster?: number;
  simThreshold?: number;
  maxClusterSize?: number;
  type?: string;
  idempotencyDays?: number;
  batch?: number;
  resume?: boolean;
  onLog?: (message: string) => void;
  onWarn?: (message: string) => void;
}

interface CheckpointPlan {
  phase1: Record<string, string[]>;
  phase2: string[];
  totalClusters: number;
  estimatedLlmCalls: number;
  phase1Counts: Array<{ type: string; entries: number; clusters: number }>;
}

interface ConsolidationCheckpoint {
  phase: number;
  typeIndex: number;
  clusterIndex: number;
  startedAt: string;
  dbPathSignature: string;
  optionsSignature: string;
  processed: {
    phase1: Record<string, string[]>;
    phase2: string[];
  };
  plan: CheckpointPlan;
}

interface RunContext {
  report: ConsolidationOrchestratorReport;
  checkpoint: ConsolidationCheckpoint;
  processedPhase1: Map<string, Set<string>>;
  processedPhase2: Set<string>;
  minCluster: number;
  phase1Threshold: number;
  phase2Threshold: number;
  phase1MaxClusterSize: number;
  phase2MaxClusterSize: number;
  batchLimit?: number;
  batchReached: boolean;
  processedClustersInRun: number;
}

export interface ConsolidationOrchestratorDeps {
  buildClustersFn: typeof buildClusters;
  consolidateRulesFn: typeof consolidateRules;
  mergeClusterFn: typeof mergeCluster;
  rebuildVectorIndexFn: typeof rebuildVectorIndex;
  walCheckpointFn: typeof walCheckpoint;
  countActiveEntriesFn: (db: Client, platform?: KnowledgePlatform) => Promise<number>;
  countActiveEmbeddedEntriesFn: (db: Client, typeFilter?: string, platform?: KnowledgePlatform) => Promise<number>;
}

function toNumber(value: InValue | undefined): number {
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

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clusterFingerprint(cluster: Cluster): string {
  const ids = cluster.entries.map((entry) => entry.id).sort();
  return hashValue(ids.join("|"));
}

function defaultClusterStats(): ClusterProcessingStats {
  return {
    entries: 0,
    clustersFound: 0,
    skippedByResume: 0,
    clustersProcessed: 0,
    clustersMerged: 0,
    mergesFlagged: 0,
    llmCalls: 0,
    entriesConsolidatedFrom: 0,
    canonicalEntriesCreated: 0,
  };
}

async function countActiveEmbeddedEntries(db: Client, typeFilter?: string, platform?: KnowledgePlatform): Promise<number> {
  const platformCondition = platform ? "AND platform = ?" : "";

  if (typeFilter?.trim()) {
    const args: unknown[] = [typeFilter.trim()];
    if (platform) {
      args.push(platform);
    }

    const result = await db.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM entries
        WHERE superseded_by IS NULL
          AND embedding IS NOT NULL
          AND type = ?
          ${platformCondition}
      `,
      args,
    });
    const count = toNumber(result.rows[0]?.count);
    return Number.isFinite(count) ? count : 0;
  }

  const args: unknown[] = [];
  if (platform) {
    args.push(platform);
  }

  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        AND embedding IS NOT NULL
        ${platformCondition}
    `,
    args,
  });
  const count = toNumber(result.rows[0]?.count);
  return Number.isFinite(count) ? count : 0;
}

function resolvedOptionsSignature(options: ConsolidationOrchestratorOptions): string {
  return hashValue(
    JSON.stringify({
      dryRun: options.dryRun === true,
      rulesOnly: options.rulesOnly === true,
      platform: options.platform ?? null,
      minCluster: options.minCluster ?? DEFAULT_MIN_CLUSTER,
      simThreshold: options.simThreshold ?? DEFAULT_PHASE1_SIM_THRESHOLD,
      maxClusterSize: options.maxClusterSize ?? null,
      type: options.type?.trim() ?? null,
      idempotencyDays: options.idempotencyDays ?? null,
    }),
  );
}

function resolveDbPathSignature(dbPath: string): string {
  return hashValue(path.resolve(dbPath));
}

async function readCheckpoint(): Promise<ConsolidationCheckpoint | null> {
  try {
    const raw = await fs.readFile(CONSOLIDATION_CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw) as ConsolidationCheckpoint;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function saveCheckpoint(checkpoint: ConsolidationCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(CONSOLIDATION_CHECKPOINT_PATH), { recursive: true });
  const tempPath = `${CONSOLIDATION_CHECKPOINT_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, CONSOLIDATION_CHECKPOINT_PATH);
}

async function clearCheckpoint(): Promise<void> {
  try {
    await fs.unlink(CONSOLIDATION_CHECKPOINT_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function checkpointToProcessedMaps(checkpoint: ConsolidationCheckpoint): {
  phase1: Map<string, Set<string>>;
  phase2: Set<string>;
} {
  const phase1 = new Map<string, Set<string>>();
  for (const [type, fingerprints] of Object.entries(checkpoint.processed.phase1 ?? {})) {
    phase1.set(type, new Set(fingerprints));
  }
  return {
    phase1,
    phase2: new Set(checkpoint.processed.phase2 ?? []),
  };
}

function processedMapsToCheckpoint(
  phase1: Map<string, Set<string>>,
  phase2: Set<string>,
): ConsolidationCheckpoint["processed"] {
  const serializedPhase1: Record<string, string[]> = {};
  for (const [type, fingerprints] of phase1.entries()) {
    serializedPhase1[type] = [...fingerprints];
  }
  return {
    phase1: serializedPhase1,
    phase2: [...phase2],
  };
}

function createEmptyPlan(types: readonly string[]): CheckpointPlan {
  const phase1: Record<string, string[]> = {};
  for (const type of types) {
    phase1[type] = [];
  }
  return {
    phase1,
    phase2: [],
    totalClusters: 0,
    estimatedLlmCalls: 0,
    phase1Counts: [],
  };
}

function createDefaultCheckpoint(
  dbPathSignature: string,
  optionsSignature: string,
  types: readonly string[],
): ConsolidationCheckpoint {
  return {
    phase: 0,
    typeIndex: 0,
    clusterIndex: 0,
    startedAt: new Date().toISOString(),
    dbPathSignature,
    optionsSignature,
    processed: {
      phase1: {},
      phase2: [],
    },
    plan: createEmptyPlan(types),
  };
}

function resolvePhase1Types(typeFilter?: string): string[] {
  const trimmed = typeFilter?.trim();
  if (!trimmed) {
    return [...DEFAULT_PHASE1_TYPES];
  }
  return [trimmed];
}

function updateAggregateStats(
  target: ClusterProcessingStats,
  source: ClusterProcessingStats,
): void {
  target.entries += source.entries;
  target.clustersFound += source.clustersFound;
  target.skippedByResume += source.skippedByResume;
  target.clustersProcessed += source.clustersProcessed;
  target.clustersMerged += source.clustersMerged;
  target.mergesFlagged += source.mergesFlagged;
  target.llmCalls += source.llmCalls;
  target.entriesConsolidatedFrom += source.entriesConsolidatedFrom;
  target.canonicalEntriesCreated += source.canonicalEntriesCreated;
}

async function runFinalization(
  db: Client,
  dryRun: boolean,
  onWarn: (message: string) => void,
  deps: ConsolidationOrchestratorDeps,
): Promise<void> {
  if (dryRun) {
    return;
  }

  try {
    await deps.rebuildVectorIndexFn(db);
  } catch (error) {
    onWarn(`[consolidate] Vector index rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await deps.walCheckpointFn(db);
  } catch (error) {
    onWarn(`[consolidate] WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function processPhaseClusters(
  params: {
    db: Client;
    clusters: Cluster[];
    phase: 1 | 2;
    type: string;
    typeIndex: number;
    llmClient: LlmClient;
    embeddingApiKey: string;
    options: ConsolidationOrchestratorOptions;
    checkpoint: ConsolidationCheckpoint;
    processedSet: Set<string>;
    context: RunContext;
  },
  deps: ConsolidationOrchestratorDeps,
): Promise<ClusterProcessingStats> {
  const stats = defaultClusterStats();
  stats.clustersFound = params.clusters.length;

  const pending: Array<{ cluster: Cluster; index: number; fingerprint: string }> = [];
  for (let i = 0; i < params.clusters.length; i += 1) {
    const cluster = params.clusters[i];
    const fingerprint = clusterFingerprint(cluster);
    if (params.processedSet.has(fingerprint)) {
      stats.skippedByResume += 1;
      continue;
    }
    pending.push({ cluster, index: i, fingerprint });
  }

  for (const item of pending) {
    if (isShutdownRequested()) {
      params.context.batchReached = true;
      break;
    }
    if (params.context.batchLimit && params.context.processedClustersInRun >= params.context.batchLimit) {
      params.context.batchReached = true;
      break;
    }

    const outcome = await deps.mergeClusterFn(params.db, item.cluster, params.llmClient, params.embeddingApiKey, {
      dryRun: params.options.dryRun,
      verbose: params.options.verbose,
      onLog: params.options.verbose ? params.options.onLog : undefined,
    });

    stats.clustersProcessed += 1;
    stats.llmCalls += 1;
    params.context.processedClustersInRun += 1;
    params.processedSet.add(item.fingerprint);

    if (outcome.flagged) {
      stats.mergesFlagged += 1;
    } else {
      stats.clustersMerged += 1;
      stats.entriesConsolidatedFrom += item.cluster.entries.length;
      stats.canonicalEntriesCreated += 1;
    }

    params.checkpoint.phase = params.phase;
    params.checkpoint.typeIndex = params.typeIndex;
    params.checkpoint.clusterIndex = item.index + 1;
    params.checkpoint.processed = processedMapsToCheckpoint(params.context.processedPhase1, params.context.processedPhase2);
    await saveCheckpoint(params.checkpoint);

    if (isShutdownRequested()) {
      params.context.batchReached = true;
      break;
    }
  }

  return stats;
}

export async function runConsolidationOrchestrator(
  db: Client,
  dbPath: string,
  llmClient: LlmClient | undefined,
  embeddingApiKey: string | undefined,
  options: ConsolidationOrchestratorOptions = {},
  deps: Partial<ConsolidationOrchestratorDeps> = {},
): Promise<ConsolidationOrchestratorReport> {
  const resolvedDeps: ConsolidationOrchestratorDeps = {
    buildClustersFn: deps.buildClustersFn ?? buildClusters,
    consolidateRulesFn: deps.consolidateRulesFn ?? consolidateRules,
    mergeClusterFn: deps.mergeClusterFn ?? mergeCluster,
    rebuildVectorIndexFn: deps.rebuildVectorIndexFn ?? rebuildVectorIndex,
    walCheckpointFn: deps.walCheckpointFn ?? walCheckpoint,
    countActiveEntriesFn: deps.countActiveEntriesFn ?? countActiveEntries,
    countActiveEmbeddedEntriesFn: deps.countActiveEmbeddedEntriesFn ?? countActiveEmbeddedEntries,
  };

  const onLog = options.onLog ?? (() => undefined);
  const onWarn = options.onWarn ?? onLog;
  const dryRun = options.dryRun === true;
  const rulesOnly = options.rulesOnly === true;
  const platform = options.platform;
  const minCluster = options.minCluster ?? DEFAULT_MIN_CLUSTER;
  const phase1Threshold = options.simThreshold ?? DEFAULT_PHASE1_SIM_THRESHOLD;
  const phase2Threshold = Math.max(options.simThreshold ?? DEFAULT_PHASE1_SIM_THRESHOLD, DEFAULT_PHASE2_SIM_THRESHOLD);
  const phase1MaxClusterSize = options.maxClusterSize ?? DEFAULT_PHASE1_MAX_CLUSTER_SIZE;
  const phase2MaxClusterSize = options.maxClusterSize ?? DEFAULT_PHASE2_MAX_CLUSTER_SIZE;
  const batchLimit = options.batch && options.batch > 0 ? Math.floor(options.batch) : undefined;
  const phase1Types = resolvePhase1Types(options.type);
  const progressPhase1Types = phase1Types.length === 1 ? phase1Types : [...DEFAULT_PHASE1_TYPES];

  const checkpointResumeEnabled = options.resume !== false;
  const dbPathSignature = resolveDbPathSignature(dbPath);
  const optionsSignature = resolvedOptionsSignature(options);

  const checkpointFromDisk = checkpointResumeEnabled ? await readCheckpoint() : null;
  let resumed = false;
  let checkpoint = createDefaultCheckpoint(dbPathSignature, optionsSignature, progressPhase1Types);

  if (!checkpointResumeEnabled) {
    await clearCheckpoint();
  } else if (checkpointFromDisk) {
    const dbPathMatches = checkpointFromDisk.dbPathSignature === dbPathSignature;
    if (dbPathMatches) {
      checkpoint = checkpointFromDisk;
      resumed = true;
      if (checkpointFromDisk.optionsSignature !== optionsSignature) {
        onWarn("[consolidate] Checkpoint options differ from current run. Attempting best-effort resume.");
      }
      const typeLabel = progressPhase1Types[checkpoint.typeIndex] ?? "n/a";
      onLog(
        `Resuming from checkpoint (Phase ${checkpoint.phase}, type: ${typeLabel}, cluster ${checkpoint.clusterIndex}).`,
      );
    } else {
      await clearCheckpoint();
      onWarn("[consolidate] Existing checkpoint does not match current database/options, starting fresh.");
    }
  }

  const processedMaps = checkpointToProcessedMaps(checkpoint);
  const context: RunContext = {
    report: {
      entriesBefore: 0,
      entriesAfter: 0,
      expiredCount: 0,
      mergedCount: 0,
      orphanedRelationsCleaned: 0,
      backupPath: "",
      entriesAfterRules: 0,
      estimate: {
        totalClusters: 0,
        estimatedLlmCalls: 0,
        phase1ByType: [],
        phase2Clusters: 0,
      },
      phase1: {
        totals: defaultClusterStats(),
        types: [],
      },
      progress: {
        resumed,
        checkpointPath: CONSOLIDATION_CHECKPOINT_PATH,
        partial: false,
        batchLimit,
        processedClusters: 0,
        remainingClusters: 0,
        resumeFrom: resumed
          ? {
              phase: checkpoint.phase,
              typeIndex: checkpoint.typeIndex,
              clusterIndex: checkpoint.clusterIndex,
            }
          : undefined,
      },
      summary: {
        totalLlmCalls: 0,
        totalFlagged: 0,
        totalCanonicalEntriesCreated: 0,
        totalEntriesConsolidatedFrom: 0,
      },
    },
    checkpoint,
    processedPhase1: processedMaps.phase1,
    processedPhase2: processedMaps.phase2,
    minCluster,
    phase1Threshold,
    phase2Threshold,
    phase1MaxClusterSize,
    phase2MaxClusterSize,
    batchLimit,
    batchReached: false,
    processedClustersInRun: 0,
  };

  if (isShutdownRequested()) {
    onWarn("[consolidate] Shutdown requested; exiting before starting consolidation.");
    context.batchReached = true;
    await runFinalization(db, dryRun, onWarn, resolvedDeps);
    return context.report;
  }

  onLog("Phase 0: Rules-based cleanup...");
  const phase0Stats = await resolvedDeps.consolidateRulesFn(db, dbPath, {
    dryRun,
    verbose: options.verbose,
    platform,
    rebuildIndex: false,
    onLog: options.verbose ? onLog : undefined,
  });
  context.report.entriesBefore = phase0Stats.entriesBefore;
  context.report.expiredCount = phase0Stats.expiredCount;
  context.report.mergedCount = phase0Stats.mergedCount;
  context.report.orphanedRelationsCleaned = phase0Stats.orphanedRelationsCleaned;
  context.report.backupPath = phase0Stats.backupPath;
  context.report.entriesAfterRules = phase0Stats.entriesAfter;
  context.report.entriesAfter = phase0Stats.entriesAfter;

  if (isShutdownRequested()) {
    onWarn("[consolidate] Shutdown requested; stopping after Phase 0.");
    context.batchReached = true;
    await runFinalization(db, dryRun, onWarn, resolvedDeps);
    context.report.entriesAfter = await resolvedDeps.countActiveEntriesFn(db, platform);
    context.report.progress.partial = true;
    return context.report;
  }

  if (!rulesOnly) {
    if (!llmClient || !embeddingApiKey) {
      throw new Error("LLM client and embedding API key are required for non-rules-only consolidation.");
    }

    const phase1Plan: Array<{ type: string; entries: number; clusters: Cluster[] }> = [];
    for (const type of phase1Types) {
      if (isShutdownRequested()) {
        context.batchReached = true;
        break;
      }
      const entries = await resolvedDeps.countActiveEmbeddedEntriesFn(db, type, platform);
      const clusters = await resolvedDeps.buildClustersFn(db, {
        simThreshold: phase1Threshold,
        minCluster,
        maxClusterSize: phase1MaxClusterSize,
        typeFilter: type,
        platform,
        idempotencyDays: options.idempotencyDays,
        verbose: options.verbose,
        onLog: options.verbose ? onLog : undefined,
      });
      phase1Plan.push({ type, entries, clusters });
    }

    if (context.batchReached) {
      await runFinalization(db, dryRun, onWarn, resolvedDeps);
      context.report.entriesAfter = await resolvedDeps.countActiveEntriesFn(db, platform);
      context.report.progress.partial = true;
      return context.report;
    }

    const shouldRunPhase2 = !options.type?.trim();
    const phase2Entries = shouldRunPhase2 ? await resolvedDeps.countActiveEmbeddedEntriesFn(db, undefined, platform) : 0;
    const phase2Clusters = shouldRunPhase2
      ? await resolvedDeps.buildClustersFn(db, {
          simThreshold: phase2Threshold,
          minCluster,
          maxClusterSize: phase2MaxClusterSize,
          platform,
          idempotencyDays: options.idempotencyDays,
          verbose: options.verbose,
          onLog: options.verbose ? onLog : undefined,
        })
      : [];

    context.report.estimate.phase1ByType = phase1Plan.map((item) => ({
      type: item.type,
      entries: item.entries,
      clusters: item.clusters.length,
    }));
    context.report.estimate.phase2Clusters = phase2Clusters.length;
    context.report.estimate.totalClusters =
      phase1Plan.reduce((sum, item) => sum + item.clusters.length, 0) + phase2Clusters.length;
    context.report.estimate.estimatedLlmCalls = context.report.estimate.totalClusters;

    context.checkpoint.plan = {
      phase1: Object.fromEntries(phase1Plan.map((item) => [item.type, item.clusters.map(clusterFingerprint)])),
      phase2: phase2Clusters.map(clusterFingerprint),
      totalClusters: context.report.estimate.totalClusters,
      estimatedLlmCalls: context.report.estimate.estimatedLlmCalls,
      phase1Counts: context.report.estimate.phase1ByType,
    };
    await saveCheckpoint(context.checkpoint);

    onLog(
      `Found ${context.report.estimate.totalClusters} clusters across ${phase1Plan.length} type(s), estimated ${context.report.estimate.estimatedLlmCalls} LLM calls.`,
    );

    for (let i = 0; i < phase1Plan.length; i += 1) {
      if (isShutdownRequested()) {
        context.batchReached = true;
        break;
      }
      const item = phase1Plan[i];
      const processedSet = context.processedPhase1.get(item.type) ?? new Set<string>();
      context.processedPhase1.set(item.type, processedSet);

      onLog(`Phase 1: Consolidating ${item.type}s (${item.entries} entries, ${item.clusters.length} clusters)...`);

      const typeStats = await processPhaseClusters(
        {
          db,
          clusters: item.clusters,
          phase: 1,
          type: item.type,
          typeIndex: i,
          llmClient,
          embeddingApiKey,
          options,
          checkpoint: context.checkpoint,
          processedSet,
          context,
        },
        resolvedDeps,
      );
      context.report.phase1.types.push({ type: item.type, ...typeStats });
      updateAggregateStats(context.report.phase1.totals, typeStats);
      if (context.batchReached) {
        break;
      }
    }

    if (!context.batchReached && shouldRunPhase2) {
      if (isShutdownRequested()) {
        context.batchReached = true;
      } else {
        onLog(`Phase 2: Cross-subject catch-all (${phase2Entries} entries, ${phase2Clusters.length} clusters)...`);
        const phase2Stats = await processPhaseClusters(
          {
            db,
            clusters: phase2Clusters,
            phase: 2,
            type: "all",
            typeIndex: 0,
            llmClient,
            embeddingApiKey,
            options,
            checkpoint: context.checkpoint,
            processedSet: context.processedPhase2,
            context,
          },
          resolvedDeps,
        );
        context.report.phase2 = phase2Stats;
      }
    }
  }

  await runFinalization(db, dryRun, onWarn, resolvedDeps);

  context.report.entriesAfter = await resolvedDeps.countActiveEntriesFn(db, platform);
  context.report.progress.partial = context.batchReached;
  context.report.progress.processedClusters =
    context.report.phase1.totals.clustersProcessed + (context.report.phase2?.clustersProcessed ?? 0);
  context.report.progress.remainingClusters = Math.max(
    context.report.estimate.totalClusters -
      context.report.phase1.totals.skippedByResume -
      (context.report.phase2?.skippedByResume ?? 0) -
      context.report.progress.processedClusters,
    0,
  );

  context.report.summary.totalLlmCalls = context.report.phase1.totals.llmCalls + (context.report.phase2?.llmCalls ?? 0);
  context.report.summary.totalFlagged =
    context.report.phase1.totals.mergesFlagged + (context.report.phase2?.mergesFlagged ?? 0);
  context.report.summary.totalCanonicalEntriesCreated =
    context.report.phase1.totals.canonicalEntriesCreated + (context.report.phase2?.canonicalEntriesCreated ?? 0);
  context.report.summary.totalEntriesConsolidatedFrom =
    context.report.phase1.totals.entriesConsolidatedFrom + (context.report.phase2?.entriesConsolidatedFrom ?? 0);

  if (context.batchReached) {
    context.checkpoint.phase = context.report.phase2 ? 2 : 1;
    context.checkpoint.processed = processedMapsToCheckpoint(context.processedPhase1, context.processedPhase2);
    await saveCheckpoint(context.checkpoint);
  } else {
    await clearCheckpoint();
  }

  return context.report;
}
