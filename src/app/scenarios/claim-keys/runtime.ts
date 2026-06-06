import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDreamPort } from "../../../adapters/db/dreaming-port.js";
import { getLastDreamRun } from "../../../adapters/db/dreaming-run-log.js";
import { DURABLE_SELECT_COLUMNS, mapDurableRow } from "../../../adapters/db/row-mapping.js";
import { localTranscriptFiles } from "../../../adapters/files/transcript-files.js";
import { openClawTranscriptParser } from "../../../adapters/openclaw/transcript/parser.js";
import { resolveClaimExtractionConfig } from "../../../config.js";
import { isCurrentlyValidMemory } from "../../../core/temporal-validity.js";
import { ingestPath } from "../../ingestion/index.js";
import { storeDurablesDetailed } from "../../../core/store/pipeline.js";
import type { Durable, StoreResult } from "../../../core/types.js";
import { runDream } from "../../dreaming/service.js";
import { buildClaimKeyScenarioAssertions, summarizeClaimKeyScenarioDiffs } from "./assertions.js";
import { createDeterministicEmbeddingPort, createFixtureIngestionLlm, createFixtureLlm } from "./deterministic-fixtures.js";
import { loadClaimExtractionFixtureResponses, loadExtractionFixtureResponses, loadSeedFixtureEntries } from "./fixture-loader.js";
import { getDefaultClaimKeyScenarioRoot, loadClaimKeyScenarios } from "./load-scenarios.js";
import { createClaimKeyScenarioSandbox } from "./sandbox.js";
import { seedClaimKeyScenarioEntries } from "./seed.js";
import type {
  ClaimKeyScenario,
  ClaimKeyScenarioActualState,
  ClaimKeyScenarioProposalSnapshot,
  ClaimKeyScenarioRunOptions,
  ClaimKeyScenarioRunResult,
  ClaimKeyScenarioSummary,
  ClaimKeyScenarioDreamingSummarySnapshot,
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
      durables: 0,
      activeDurables: 0,
      entriesWithClaimKey: 0,
      proposals: 0,
    },
    proposals: [],
    storeResult: null,
    dreamingSummary: null,
  };
  let preservedSandboxPath: string | undefined;

  try {
    const sandbox = await createClaimKeyScenarioSandbox(sandboxRoot);

    try {
      await seedScenarioSetup(scenario, sandbox.database, options.rootDir);

      let storeResult: StoreResult | null = null;
      let dreamingSummary: ClaimKeyScenarioDreamingSummarySnapshot | null = null;

      switch (scenario.kind) {
        case "ingest":
          storeResult = await runIngestScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
        case "store":
          storeResult = await runStoreScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
        case "dreaming":
          dreamingSummary = await runDreamingScenario(scenario, sandbox.database, warnings, options.rootDir);
          break;
      }

      actual = await captureActualState(sandbox.database, warnings, storeResult, dreamingSummary);
    } catch (error) {
      actual = await captureActualState(
        sandbox.database,
        warnings,
        actual.storeResult,
        actual.dreamingSummary,
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
  const fixtureEntries = await loadSeedFixtureEntries(rootDir, scenario.setup?.seedFixtureFile);
  if (fixtureEntries) {
    seedEntries.push(...fixtureEntries);
  }

  if (seedEntries.length > 0) {
    await seedClaimKeyScenarioEntries(database, seedEntries);
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
  const extractionResponses = await loadExtractionFixtureResponses(rootDir, scenario.input.modelFixtures?.extractionResponsesFile);
  const claimExtractionResponses = await loadClaimExtractionFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);
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
  const claimExtractionResponses = await loadClaimExtractionFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);
  const result = await storeDurablesDetailed(scenario.input.entries, database, createDeterministicEmbeddingPort(), {
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
 * Runs one dreaming scenario through the real reconcile run path.
 *
 * @param scenario - Dreaming scenario definition.
 * @param database - Open scenario sandbox database.
 * @param warnings - Mutable warning sink.
 * @param rootDir - Scenario root used for fixture resolution.
 * @returns Structured dreaming summary snapshot from the latest run.
 */
async function runDreamingScenario(
  scenario: Extract<ClaimKeyScenario, { kind: "dreaming" }>,
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  _warnings: string[],
  rootDir: string,
): Promise<ClaimKeyScenarioDreamingSummarySnapshot | null> {
  const claimExtractionResponses = await loadClaimExtractionFixtureResponses(rootDir, scenario.input.modelFixtures?.claimExtractionResponsesFile);

  await runDream(
    {
      tier: "standard",
      project: scenario.input.dreamingOptions?.project ?? undefined,
      type: scenario.input.dreamingOptions?.type,
      claimKeyPrefix: scenario.input.dreamingOptions?.claimKeyPrefix,
      durableIds: scenario.input.dreamingOptions?.durableIds,
      includeInactive: scenario.input.dreamingOptions?.includeInactive === true,
      apply: scenario.input.dreamingOptions?.apply !== false,
      verbose: scenario.input.dreamingOptions?.verbose === true,
      json: false,
    },
    {
      port: createDreamPort(database),
      config: claimExtractionResponses ? { claimExtraction: resolveClaimExtractionConfig() } : null,
      ...(claimExtractionResponses ? { createClaimExtractionLlm: () => createFixtureLlm(claimExtractionResponses) } : {}),
      now: () => SCENARIO_NOW,
    },
  );

  return loadLatestDreamingSummary(database);
}

/**
 * Captures actual observable state after one scenario execution.
 *
 * @param database - Open sandbox database.
 * @param warnings - Ordered warning list accumulated during execution.
 * @param storeResult - Optional store result captured from the main flow.
 * @param dreamingSummary - Optional dreaming summary captured from the main flow.
 * @param executionError - Optional execution error message.
 * @returns Actual observable state used for assertions and artifacts.
 */
async function captureActualState(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  warnings: string[],
  storeResult: StoreResult | null,
  dreamingSummary: ClaimKeyScenarioDreamingSummarySnapshot | null,
  executionError?: string,
): Promise<ClaimKeyScenarioActualState> {
  const rows = await loadAllEntries(database);
  const latestDreamingSummary = dreamingSummary ?? (await loadLatestDreamingSummary(database));
  const proposals = latestDreamingSummary ? await loadLatestDreamProposals(database, latestDreamingSummary.runId) : [];

  return {
    warnings,
    rows,
    rowCount: {
      durables: rows.length,
      activeDurables: rows.filter((row) => isCurrentlyValidMemory(row, Date.now())).length,
      entriesWithClaimKey: rows.filter((row) => typeof row.claim_key === "string" && row.claim_key.length > 0).length,
      proposals: proposals.length,
    },
    proposals,
    storeResult,
    dreamingSummary: latestDreamingSummary,
    ...(executionError ? { executionError } : {}),
  };
}

/**
 * Loads every entry row from the sandbox database.
 *
 * @param database - Open sandbox database.
 * @returns Hydrated ordered entry rows.
 */
async function loadAllEntries(database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"]): Promise<Durable[]> {
  const rows = await database.execute({
    sql: `
      SELECT ${DURABLE_SELECT_COLUMNS}
      FROM durables
      ORDER BY created_at ASC, id ASC
    `,
  });

  return rows.rows.map((row) => mapDurableRow(row));
}

/**
 * Loads the latest persisted dreaming summary, when a dreaming run exists.
 *
 * @param database - Open sandbox database.
 * @returns Latest dreaming summary snapshot, or null when no run exists.
 */
async function loadLatestDreamingSummary(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
): Promise<ClaimKeyScenarioDreamingSummarySnapshot | null> {
  const latestRun = await getLastDreamRun(database);
  if (!latestRun) {
    return null;
  }

  return {
    runId: latestRun.id,
    status: latestRun.status,
    passType: latestRun.tier,
    summary: latestRun.summaryJson?.reconcile ?? null,
  };
}

/**
 * Loads structured dreaming proposals for the requested run ID.
 *
 * @param database - Open sandbox database.
 * @param runId - Run identifier whose proposals should be loaded.
 * @returns Ordered proposal snapshots.
 */
async function loadLatestDreamProposals(
  database: Awaited<ReturnType<typeof createClaimKeyScenarioSandbox>>["database"],
  runId: string,
): Promise<ClaimKeyScenarioProposalSnapshot[]> {
  const port = createDreamPort(database);
  const proposals = await port.getRunProposals(runId);

  return proposals.map((proposal) => ({
    id: proposal.id,
    runId: proposal.runId,
    groupId: proposal.groupId,
    issueKind: proposal.issueKind,
    scope: proposal.scope,
    durableIds: proposal.durableIds,
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

  if (actual.dreamingSummary) {
    await writeJson(path.join(scenarioArtifactRoot, "dreaming-summary.json"), actual.dreamingSummary);
  }

  if (actual.proposals.length > 0) {
    await writeJson(path.join(scenarioArtifactRoot, "proposals.json"), actual.proposals);
  }
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
