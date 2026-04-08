import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getModel } from "@mariozechner/pi-ai";

import { createSurgeonPort } from "../../../adapters/db/surgeon-port.js";
import { getLastSurgeonRun } from "../../../adapters/db/surgeon-run-log.js";
import { ENTRY_SELECT_COLUMNS, mapEntryRow } from "../../../adapters/db/row-mapping.js";
import { localTranscriptFiles } from "../../../adapters/files/transcript-files.js";
import { openClawTranscriptParser } from "../../../adapters/openclaw/transcript/parser.js";
import { resolveClaimExtractionConfig } from "../../../config.js";
import { ingestPath } from "../../ingestion/index.js";
import { storeEntriesDetailed } from "../../../core/store/pipeline.js";
import { computeContentHash, computeNormContentHash } from "../../../core/store/hashing.js";
import type { Entry, StoreResult } from "../../../core/types.js";
import { runSurgeon } from "../../surgeon/service.js";
import { buildClaimKeyScenarioAssertions, summarizeClaimKeyScenarioDiffs } from "./assertions.js";
import { createDeterministicEmbeddingPort, createFixtureIngestionLlm, createFixtureLlm } from "./deterministic-fixtures.js";
import { getDefaultClaimKeyScenarioRoot, loadClaimKeyScenarios } from "./load-scenarios.js";
import { createClaimKeyScenarioSandbox } from "./sandbox.js";
import type {
  ClaimKeyScenario,
  ClaimKeyScenarioActualState,
  ClaimKeyScenarioProposalSnapshot,
  ClaimKeyScenarioRunOptions,
  ClaimKeyScenarioRunResult,
  ClaimKeyScenarioSeedEntry,
  ClaimKeyScenarioSummary,
  ClaimKeyScenarioSurgeonSummarySnapshot,
} from "./types.js";

const DEFAULT_ARTIFACT_ROOT = ".hermes/scenario-artifacts";
const SCENARIO_NOW = new Date("2026-04-07T12:00:00.000Z");

/**
 * Error raised when the scenario runtime cannot load or validate its inputs.
 */
export class ClaimKeyScenarioConfigurationError extends Error {}

/**
 * Loads, filters, and returns claim-key scenarios for CLI listing.
 *
 * @param options - Optional root path and list filters.
 * @returns Sorted loaded scenarios matching the requested filters.
 */
export async function listClaimKeyScenariosRuntime(
  options: Pick<ClaimKeyScenarioRunOptions, "rootDir" | "ids" | "kind" | "tags"> = {},
): Promise<ClaimKeyScenario[]> {
  try {
    const scenarios = await loadClaimKeyScenarios(options.rootDir ?? getDefaultClaimKeyScenarioRoot());
    return filterClaimKeyScenarios(scenarios, options);
  } catch (error) {
    throw toConfigurationError(error);
  }
}

/**
 * Executes the matching claim-key scenario set and captures artifacts.
 *
 * @param options - Root path, filters, preserve policy, and verbosity flags.
 * @returns Aggregate runtime summary for the matched scenario set.
 */
export async function runClaimKeyScenariosRuntime(options: ClaimKeyScenarioRunOptions = {}): Promise<ClaimKeyScenarioSummary> {
  const runId = buildRunId();
  const artifactRoot = path.resolve(DEFAULT_ARTIFACT_ROOT, runId);
  await mkdir(artifactRoot, { recursive: true });

  let scenarios: ClaimKeyScenario[];
  try {
    scenarios = await listClaimKeyScenariosRuntime(options);
  } catch (error) {
    throw toConfigurationError(error);
  }

  const results: ClaimKeyScenarioRunResult[] = [];

  for (const scenario of scenarios) {
    const result = await runOneClaimKeyScenario(scenario, {
      artifactRoot,
      rootDir: options.rootDir ?? getDefaultClaimKeyScenarioRoot(),
      preserveAlways: options.preserveAlways === true,
      preserveOnFailure: options.preserveOnFailure === true,
      verbose: options.verbose === true,
    });
    results.push(result);

    if (options.failFast === true && result.status === "failed") {
      break;
    }
  }

  return {
    runId,
    matchedCount: scenarios.length,
    passedCount: results.filter((result) => result.status === "passed").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    artifactRoot,
    results,
  };
}

/**
 * Filters one scenario list using CLI-selected identifiers, kind, and tags.
 *
 * @param scenarios - Loaded scenarios in sorted order.
 * @param options - Optional filter options.
 * @returns Matching sorted scenarios.
 */
function filterClaimKeyScenarios(scenarios: ClaimKeyScenario[], options: Pick<ClaimKeyScenarioRunOptions, "ids" | "kind" | "tags">): ClaimKeyScenario[] {
  const idFilter = new Set((options.ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const tagFilter = new Set((options.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0));

  return scenarios.filter((scenario) => {
    if (idFilter.size > 0 && !idFilter.has(scenario.id)) {
      return false;
    }

    if (options.kind && scenario.kind !== options.kind) {
      return false;
    }

    if (tagFilter.size > 0) {
      const scenarioTags = new Set(scenario.tags ?? []);
      if (![...tagFilter].some((tag) => scenarioTags.has(tag))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Executes one scenario inside its own sandbox and artifact directory.
 *
 * @param scenario - Scenario definition to execute.
 * @param options - Artifact-root and preservation policy.
 * @returns Per-scenario runtime result for CLI rendering.
 */
async function runOneClaimKeyScenario(
  scenario: ClaimKeyScenario,
  options: {
    artifactRoot: string;
    rootDir: string;
    preserveAlways: boolean;
    preserveOnFailure: boolean;
    verbose: boolean;
  },
): Promise<ClaimKeyScenarioRunResult> {
  const startedAt = Date.now();
  const scenarioArtifactRoot = path.join(options.artifactRoot, scenario.id);
  const sandboxRoot = path.join(scenarioArtifactRoot, "sandbox");
  const warnings: string[] = [];

  await mkdir(scenarioArtifactRoot, { recursive: true });
  await writeJson(path.join(scenarioArtifactRoot, "scenario.json"), scenario);

  let actual: ClaimKeyScenarioActualState = {
    warnings: [],
    rows: [],
    rowCount: {
      entries: 0,
      activeEntries: 0,
      entriesWithClaimKey: 0,
      proposals: 0,
    },
    proposals: [],
    storeResult: null,
    surgeonSummary: null,
  };
  let preservedSandboxPath: string | undefined;

  try {
    const sandbox = await createClaimKeyScenarioSandbox(sandboxRoot);

    try {
      await seedScenarioSetup(scenario, sandbox.database, options.rootDir);

      let storeResult: StoreResult | null = null;
      let surgeonSummary: ClaimKeyScenarioSurgeonSummarySnapshot | null = null;

      switch (scenario.kind) {
        case "ingest":
          storeResult = await runIngestScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
        case "store":
          storeResult = await runStoreScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
        case "surgeon":
          surgeonSummary = await runSurgeonScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
      }

      actual = await captureActualState(sandbox.database, warnings, storeResult, surgeonSummary);
    } catch (error) {
      actual = await captureActualState(
        sandbox.database,
        warnings,
        actual.storeResult,
        actual.surgeonSummary,
        error instanceof Error ? error.message : String(error),
      );
    }

    const assertionResults = buildClaimKeyScenarioAssertions(scenario, actual);
    const diffSummary = summarizeClaimKeyScenarioDiffs(assertionResults);
    const status = assertionResults.every((result) => result.passed) ? "passed" : "failed";
    const shouldPreserve =
      options.preserveAlways ||
      scenario.sandbox?.preserveAlways === true ||
      (status === "failed" && (options.preserveOnFailure || scenario.sandbox?.preserveOnFailure !== false));

    preservedSandboxPath = shouldPreserve ? sandbox.root : undefined;

    await writeScenarioArtifacts(scenarioArtifactRoot, actual, assertionResults, diffSummary);
    await sandbox.cleanup(shouldPreserve);

    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      filePath: scenario.filePath,
      status,
      durationMs: Date.now() - startedAt,
      ...(preservedSandboxPath ? { preservedSandboxPath } : {}),
      assertionResults,
      warnings: actual.warnings,
      diffSummary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actual.executionError = message;
    await writeScenarioArtifacts(
      scenarioArtifactRoot,
      actual,
      [
        {
          label: "execution",
          passed: false,
          actual: message,
          message,
        },
      ],
      [message],
    );

    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      filePath: scenario.filePath,
      status: "failed",
      durationMs: Date.now() - startedAt,
      assertionResults: [
        {
          label: "execution",
          passed: false,
          actual: message,
          message,
        },
      ],
      warnings: actual.warnings,
      diffSummary: [message],
    };
  }
}

/**
 * Seeds scenario preconditions directly into the sandbox database.
 *
 * @param scenario - Scenario whose setup block may declare seed entries.
 * @param database - Open scenario sandbox database.
 * @param rootDir - Scenario root used for fixture resolution.
 */
async function seedScenarioSetup(
  scenario: ClaimKeyScenario,
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  rootDir: string,
): Promise<void> {
  const seedEntries = [...(scenario.setup?.seedEntries ?? [])];

  if (scenario.setup?.seedFixtureFile) {
    const fixtureEntries = JSON.parse(await readFile(path.join(rootDir, scenario.setup.seedFixtureFile), "utf8")) as unknown;
    if (!Array.isArray(fixtureEntries)) {
      throw new Error(`Seed fixture ${scenario.setup.seedFixtureFile} must contain an array.`);
    }

    for (const entry of fixtureEntries) {
      seedEntries.push(entry as never);
    }
  }

  for (const seedEntry of seedEntries) {
    const entry = buildSeedEntry(seedEntry);
    await database.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          tags,
          source_file,
          source_context,
          embedding,
          content_hash,
          norm_content_hash,
          minhash_sig,
          quality_score,
          recall_count,
          last_recalled_at,
          superseded_by,
          valid_from,
          valid_to,
          claim_key,
          claim_key_raw,
          claim_key_status,
          claim_key_source,
          claim_key_confidence,
          claim_key_rationale,
          claim_support_source_kind,
          claim_support_locator,
          claim_support_observed_at,
          claim_support_mode,
          supersession_kind,
          supersession_reason,
          cluster_id,
          user_id,
          project,
          retired,
          retired_at,
          retired_reason,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        entry.id,
        entry.type,
        entry.subject,
        entry.content,
        entry.importance,
        entry.expiry,
        JSON.stringify(entry.tags),
        entry.source_file ?? null,
        entry.source_context ?? null,
        null,
        entry.content_hash ?? null,
        entry.norm_content_hash ?? null,
        null,
        entry.quality_score,
        entry.recall_count,
        entry.last_recalled_at ?? null,
        entry.superseded_by ?? null,
        entry.valid_from ?? null,
        entry.valid_to ?? null,
        entry.claim_key ?? null,
        entry.claim_key_raw ?? null,
        entry.claim_key_status ?? null,
        entry.claim_key_source ?? null,
        entry.claim_key_confidence ?? null,
        entry.claim_key_rationale ?? null,
        entry.claim_support_source_kind ?? null,
        entry.claim_support_locator ?? null,
        entry.claim_support_observed_at ?? null,
        entry.claim_support_mode ?? null,
        entry.supersession_kind ?? null,
        entry.supersession_reason ?? null,
        entry.cluster_id ?? null,
        entry.user_id ?? null,
        entry.project ?? null,
        entry.retired ? 1 : 0,
        entry.retired_at ?? null,
        entry.retired_reason ?? null,
        entry.created_at,
        entry.updated_at,
      ],
    });
  }
}

/**
 * Runs one ingest scenario through the real application-layer ingest flow.
 *
 * @param scenario - Ingest scenario definition.
 * @param database - Open scenario sandbox database.
 * @param warnings - Mutable warning sink.
 * @param rootDir - Scenario root used for fixture resolution.
 * @returns Aggregate scenario-level store result.
 */
async function runIngestScenario(
  scenario: Extract<ClaimKeyScenario, { kind: "ingest" }>,
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  warnings: string[],
  rootDir: string,
): Promise<StoreResult> {
  const embedding = createDeterministicEmbeddingPort();
  const extractionResponses = await loadFixtureResponses(rootDir, scenario.input.modelFixtures?.extractionResponsesFile);
  const claimExtractionResponses = await loadFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);
  if (!extractionResponses) {
    throw new Error(`Scenario ${scenario.id} is missing extraction fixture responses.`);
  }

  const result = await ingestPath(
    path.join(rootDir, scenario.input.transcriptFile),
    {
      files: localTranscriptFiles,
      transcript: openClawTranscriptParser,
      db: database,
      embedding,
      createExtractionLlm: () => createFixtureIngestionLlm(extractionResponses),
      ...(claimExtractionResponses
        ? {
            createClaimExtractionLlm: () => createFixtureLlm(claimExtractionResponses),
          }
        : {}),
    },
    {
      wholeFile: "never",
      skipDedup: false,
      verbose: scenario.input.ingestOptions?.verbose === true,
      ...(claimExtractionResponses ? { claimExtractionConfig: resolveClaimExtractionConfig() } : {}),
      onWarning: (warning) => {
        warnings.push(warning);
      },
    },
  );

  for (const fileResult of result.storeResults.values()) {
    warnings.push(...fileResult.warnings);
  }

  return Array.from(result.storeResults.values()).reduce<StoreResult>(
    (totals, fileResult) => ({
      stored: totals.stored + (fileResult.storeResult?.stored ?? 0),
      skipped: totals.skipped + (fileResult.storeResult?.skipped ?? 0),
      rejected: totals.rejected + (fileResult.storeResult?.rejected ?? 0),
    }),
    { stored: 0, skipped: 0, rejected: 0 },
  );
}

/**
 * Runs one store scenario through the real store pipeline.
 *
 * @param scenario - Store scenario definition.
 * @param database - Open scenario sandbox database.
 * @param warnings - Mutable warning sink.
 * @param rootDir - Scenario root used for fixture resolution.
 * @returns Store result returned by the pipeline.
 */
async function runStoreScenario(
  scenario: Extract<ClaimKeyScenario, { kind: "store" }>,
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  warnings: string[],
  rootDir: string,
): Promise<StoreResult> {
  const claimExtractionResponses = await loadFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);
  const result = await storeEntriesDetailed(scenario.input.entries, database, createDeterministicEmbeddingPort(), {
    ...(scenario.input.storeOptions?.claimExtraction === true && claimExtractionResponses
      ? {
          claimExtraction: {
            llm: createFixtureLlm(claimExtractionResponses),
            db: database,
            config: resolveClaimExtractionConfig(),
          },
        }
      : {}),
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });

  return {
    stored: result.stored,
    skipped: result.skipped,
    rejected: result.rejected,
  };
}

/**
 * Runs one surgeon scenario through the real claim-key-quality run path.
 *
 * @param scenario - Surgeon scenario definition.
 * @param database - Open scenario sandbox database.
 * @param warnings - Mutable warning sink.
 * @param rootDir - Scenario root used for fixture resolution.
 * @returns Structured surgeon summary snapshot from the latest run.
 */
async function runSurgeonScenario(
  scenario: Extract<ClaimKeyScenario, { kind: "surgeon" }>,
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  _warnings: string[],
  rootDir: string,
): Promise<ClaimKeyScenarioSurgeonSummarySnapshot | null> {
  const claimExtractionResponses = await loadFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);

  await runSurgeon(
    {
      pass: "claim_key_quality",
      project: scenario.input.surgeonOptions?.project ?? undefined,
      type: scenario.input.surgeonOptions?.type,
      claimKeyPrefix: scenario.input.surgeonOptions?.claimKeyPrefix,
      entryIds: scenario.input.surgeonOptions?.entryIds,
      includeInactive: scenario.input.surgeonOptions?.includeInactive === true,
      budget: 0,
      apply: scenario.input.surgeonOptions?.apply !== false,
      skipEvaluatedDays: 0,
      verbose: scenario.input.surgeonOptions?.verbose === true,
      json: false,
    },
    {
      port: createSurgeonPort(database),
      config: null,
      model: getModel("openai", "gpt-5.4-mini"),
      now: () => SCENARIO_NOW,
      ...(claimExtractionResponses
        ? {
            createClaimExtractionLlm: () => createFixtureLlm(claimExtractionResponses),
          }
        : {}),
    },
  );

  return loadLatestSurgeonSummary(database);
}

/**
 * Captures actual observable state after one scenario execution.
 *
 * @param database - Open sandbox database.
 * @param warnings - Ordered warning list accumulated during execution.
 * @param storeResult - Optional store result captured from the main flow.
 * @param surgeonSummary - Optional surgeon summary captured from the main flow.
 * @param executionError - Optional execution error message.
 * @returns Actual observable state used for assertions and artifacts.
 */
async function captureActualState(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  warnings: string[],
  storeResult: StoreResult | null,
  surgeonSummary: ClaimKeyScenarioSurgeonSummarySnapshot | null,
  executionError?: string,
): Promise<ClaimKeyScenarioActualState> {
  const rows = await loadAllEntries(database);
  const latestSurgeonSummary = surgeonSummary ?? (await loadLatestSurgeonSummary(database));
  const proposals = latestSurgeonSummary ? await loadLatestSurgeonProposals(database, latestSurgeonSummary.runId) : [];

  return {
    warnings,
    rows,
    rowCount: {
      entries: rows.length,
      activeEntries: rows.filter((row) => row.retired !== true && !row.superseded_by).length,
      entriesWithClaimKey: rows.filter((row) => typeof row.claim_key === "string" && row.claim_key.length > 0).length,
      proposals: proposals.length,
    },
    proposals,
    storeResult,
    surgeonSummary: latestSurgeonSummary,
    ...(executionError ? { executionError } : {}),
  };
}

/**
 * Loads every entry row from the sandbox database.
 *
 * @param database - Open sandbox database.
 * @returns Hydrated ordered entry rows.
 */
async function loadAllEntries(database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"]): Promise<Entry[]> {
  const rows = await database.execute({
    sql: `
      SELECT ${ENTRY_SELECT_COLUMNS}
      FROM entries
      ORDER BY created_at ASC, id ASC
    `,
  });

  return rows.rows.map((row) => mapEntryRow(row));
}

/**
 * Loads the latest persisted surgeon summary, when a surgeon run exists.
 *
 * @param database - Open sandbox database.
 * @returns Latest surgeon summary snapshot, or null when no run exists.
 */
async function loadLatestSurgeonSummary(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
): Promise<ClaimKeyScenarioSurgeonSummarySnapshot | null> {
  const latestRun = await getLastSurgeonRun(database);
  if (!latestRun) {
    return null;
  }

  return {
    runId: latestRun.id,
    status: latestRun.status,
    passType: latestRun.passType,
    summary: latestRun.summaryJson?.claim_key_quality ?? null,
  };
}

/**
 * Loads structured surgeon proposals for the requested run ID.
 *
 * @param database - Open sandbox database.
 * @param runId - Run identifier whose proposals should be loaded.
 * @returns Ordered proposal snapshots.
 */
async function loadLatestSurgeonProposals(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  runId: string,
): Promise<ClaimKeyScenarioProposalSnapshot[]> {
  const port = createSurgeonPort(database);
  const proposals = await port.getRunProposals(runId);

  return proposals.map((proposal) => ({
    id: proposal.id,
    runId: proposal.runId,
    groupId: proposal.groupId,
    issueKind: proposal.issueKind,
    scope: proposal.scope,
    entryIds: proposal.entryIds,
    currentClaimKeys: proposal.currentClaimKeys,
    proposedClaimKeys: proposal.proposedClaimKeys,
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    source: proposal.source,
    eligibleForApply: proposal.eligibleForApply,
    createdAt: proposal.createdAt,
  }));
}

/**
 * Writes the standard artifact set for one scenario run.
 *
 * @param scenarioArtifactRoot - Artifact directory dedicated to one scenario.
 * @param actual - Actual observable state.
 * @param assertionResults - Assertion results emitted for the scenario.
 * @param diffSummary - Human-readable failure summary.
 */
async function writeScenarioArtifacts(
  scenarioArtifactRoot: string,
  actual: ClaimKeyScenarioActualState,
  assertionResults: ClaimKeyScenarioRunResult["assertionResults"],
  diffSummary: string[],
): Promise<void> {
  await writeJson(path.join(scenarioArtifactRoot, "actual.json"), actual);
  await writeJson(path.join(scenarioArtifactRoot, "diff.json"), {
    assertions: assertionResults,
    diffSummary,
  });
  await writeJson(path.join(scenarioArtifactRoot, "warnings.json"), actual.warnings);

  if (actual.storeResult) {
    await writeJson(path.join(scenarioArtifactRoot, "store-result.json"), actual.storeResult);
  }

  if (actual.surgeonSummary) {
    await writeJson(path.join(scenarioArtifactRoot, "surgeon-summary.json"), actual.surgeonSummary);
  }

  if (actual.proposals.length > 0) {
    await writeJson(path.join(scenarioArtifactRoot, "proposals.json"), actual.proposals);
  }
}

/**
 * Loads one ordered JSON-array fixture file.
 *
 * @param rootDir - Scenario root used to resolve relative paths.
 * @param relativePath - Root-relative fixture path, when present.
 * @returns Ordered fixture responses, or null when no fixture file was declared.
 */
async function loadFixtureResponses(rootDir: string, relativePath: string | undefined): Promise<unknown[] | null> {
  if (!relativePath) {
    return null;
  }

  const parsed = JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file ${relativePath} must contain a JSON array.`);
  }

  return parsed;
}

/**
 * Builds a canonical seed entry with defaults applied.
 *
 * @param seedEntry - Raw scenario seed entry.
 * @returns Canonical entry row ready for direct SQL insertion.
 */
function buildSeedEntry(seedEntry: ClaimKeyScenarioSeedEntry): Entry {
  const createdAt = seedEntry.created_at ?? "2026-04-01T10:00:00.000Z";
  const updatedAt = seedEntry.updated_at ?? createdAt;

  return {
    id: seedEntry.id ?? randomUUID(),
    type: seedEntry.type,
    subject: seedEntry.subject,
    content: seedEntry.content,
    importance: seedEntry.importance ?? 7,
    expiry: seedEntry.expiry ?? "permanent",
    tags: seedEntry.tags ?? [],
    source_file: seedEntry.source_file,
    source_context: seedEntry.source_context,
    embedding: undefined,
    content_hash: computeContentHash(seedEntry.content, seedEntry.source_file),
    norm_content_hash: computeNormContentHash(seedEntry.content),
    quality_score: 0.5,
    recall_count: 0,
    last_recalled_at: undefined,
    superseded_by: seedEntry.superseded_by,
    valid_from: seedEntry.valid_from,
    valid_to: seedEntry.valid_to,
    claim_key: seedEntry.claim_key,
    claim_key_raw: seedEntry.claim_key_raw,
    claim_key_status: seedEntry.claim_key_status,
    claim_key_source: seedEntry.claim_key_source,
    claim_key_confidence: seedEntry.claim_key_confidence,
    claim_key_rationale: seedEntry.claim_key_rationale,
    claim_support_source_kind: seedEntry.claim_support_source_kind,
    claim_support_locator: seedEntry.claim_support_locator,
    claim_support_observed_at: seedEntry.claim_support_observed_at,
    claim_support_mode: seedEntry.claim_support_mode,
    supersession_kind: undefined,
    supersession_reason: undefined,
    cluster_id: undefined,
    user_id: seedEntry.user_id,
    project: seedEntry.project,
    retired: seedEntry.retired ?? false,
    retired_at: seedEntry.retired_at,
    retired_reason: seedEntry.retired_reason,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Writes one JSON artifact with stable indentation and a trailing newline.
 *
 * @param filePath - Output artifact file path.
 * @param value - JSON-serializable value to write.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Builds the unique run ID used by the artifact directory.
 *
 * @returns Stable run identifier safe for filesystem paths.
 */
function buildRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Converts unknown loader/runtime failures into configuration errors when appropriate.
 *
 * @param error - Unknown thrown value.
 * @returns Configuration error instance.
 */
function toConfigurationError(error: unknown): ClaimKeyScenarioConfigurationError {
  if (error instanceof ClaimKeyScenarioConfigurationError) {
    return error;
  }

  return new ClaimKeyScenarioConfigurationError(error instanceof Error ? error.message : String(error));
}
