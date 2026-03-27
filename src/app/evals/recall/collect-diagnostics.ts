import type { RecallExecutionTraceSummary, RecallTraceSink } from "../../../core/recall/trace.js";
import type {
  RecallEvalCaseDiagnostics,
  RecallEvalCaseRequest,
  RecallEvalCaseTimings,
  RecallEvalFilteringDiagnostics,
  RecallEvalProvisionDiagnostics,
  RecallEvalRankingDiagnostics,
  RecallEvalRetrievalDiagnostics,
} from "./contracts.js";
import type { RecallEvalProvisioningResult } from "./provision-fixtures.js";

/**
 * App-level collector that assembles stable recall eval diagnostics and timings.
 */
export interface RecallEvalDiagnosticsCollector {
  /** Typed core trace sink used to collect algorithm-only recall facts. */
  readonly traceSink: RecallTraceSink;
  /**
   * Returns true when diagnostics or timings require port and core observation.
   *
   * @returns Whether the Phase 3 observation layer should be enabled.
   */
  isObservationEnabled(): boolean;
  /**
   * Records sandbox setup timing for the current case.
   *
   * @param durationMs - Elapsed time spent creating the isolated sandbox.
   */
  recordSandboxSetup(durationMs: number): void;
  /**
   * Records fixture-provision timing even when provisioning does not complete.
   *
   * @param durationMs - Elapsed time spent in the fixture provisioning step.
   */
  recordFixtureProvisionTiming(durationMs: number): void;
  /**
   * Records exact fixture provisioning diagnostics and timing.
   *
   * @param result - Provisioning summary returned by the exact-seed step.
   * @param durationMs - Elapsed time spent provisioning fixtures.
   */
  recordProvision(result: RecallEvalProvisioningResult, durationMs: number): void;
  /**
   * Records the end-to-end recall call timing.
   *
   * @param durationMs - Elapsed time spent inside the real recall call.
   */
  recordRecall(durationMs: number): void;
  /**
   * Records query-embedding timing and the observed embedding dimensionality.
   *
   * @param params - Observed stage timing and output shape.
   */
  recordQueryEmbedding(params: { durationMs: number; dimensions: number }): void;
  /**
   * Records vector-search timing, count, and effective candidate limit.
   *
   * @param params - Observed vector retrieval facts.
   */
  recordVectorSearch(params: { durationMs: number; count: number; limit: number }): void;
  /**
   * Records lexical-search timing, count, and effective candidate limit.
   *
   * @param params - Observed lexical retrieval facts.
   */
  recordLexicalSearch(params: { durationMs: number; count: number; limit: number }): void;
  /**
   * Records hydrate timing and the number of hydrated entries returned.
   *
   * @param params - Observed hydration facts.
   */
  recordHydrateEntries(params: { durationMs: number; count: number }): void;
  /**
   * Records telemetry timing and the number of entry IDs targeted for updates.
   *
   * @param params - Observed recall-telemetry facts.
   */
  recordRecallTelemetry(params: { durationMs: number; entryCount: number }): void;
  /**
   * Builds the stable diagnostics payload when the caller requested it.
   *
   * @returns Structured diagnostics, or undefined when diagnostics were not requested.
   */
  buildDiagnostics(): RecallEvalCaseDiagnostics | undefined;
  /**
   * Builds the stable timing payload when the caller requested it.
   *
   * @param totalMs - End-to-end service timing for the case.
   * @returns Structured timings, or undefined when timings were not requested.
   */
  buildTimings(totalMs: number): RecallEvalCaseTimings | undefined;
}

/**
 * Creates the app-level diagnostics collector used by the recall eval runner.
 *
 * @param request - Typed recall eval case request for the current execution.
 * @returns Collector that assembles stable diagnostics and timings.
 */
export function createRecallEvalDiagnosticsCollector(request: RecallEvalCaseRequest): RecallEvalDiagnosticsCollector {
  const diagnosticsRequested = wantsRecallEvalDiagnostics(request);
  const timingsRequested = request.options?.includeTimings === true;
  const observationEnabled = diagnosticsRequested || timingsRequested;

  const execution: RecallEvalCaseDiagnostics["execution"] = {
    mode: "isolated-case",
    provisioning: "exact-fixture-seed",
    memoryPoolCount: request.memoryPool.length,
    provisionedCount: 0,
    requestedDiagnostics: request.options?.includeDiagnostics === true,
    requestedCandidates: request.options?.includeCandidates === true,
  };
  const stageTimings = {
    sandboxSetupMs: 0,
    fixtureProvisionMs: 0,
    recallMs: 0,
    queryEmbeddingMs: 0,
    vectorSearchMs: 0,
    lexicalSearchMs: 0,
    mergeCandidatesMs: 0,
    scoreCandidatesMs: 0,
    thresholdMs: 0,
    budgetMs: 0,
    hydrateEntriesMs: 0,
    shapeResultsMs: 0,
    recordRecallEventsMs: 0,
  };
  const retrieval: RecallEvalRetrievalDiagnostics = {
    queryEmbeddingDimensions: 0,
    vectorSearchLimit: 0,
    lexicalSearchLimit: 0,
  };
  const candidateCounts: RecallEvalCaseDiagnostics["candidateCounts"] = {
    vectorRetrieved: 0,
    lexicalRetrieved: 0,
    merged: 0,
    thresholdQualified: 0,
    budgetAccepted: 0,
    finalRanked: 0,
    hydrated: 0,
    returned: 0,
    telemetryAttempted: 0,
  };
  let provision: RecallEvalProvisionDiagnostics | undefined;
  let ranking: RecallEvalRankingDiagnostics | undefined;
  let filtering: RecallEvalFilteringDiagnostics | undefined;
  let provisionObserved = false;
  let retrievalObserved = false;
  let traceObserved = false;

  const traceSink: RecallTraceSink = {
    reportSummary(summary: RecallExecutionTraceSummary): void {
      traceObserved = true;
      ranking = {
        limit: summary.ranking.limit,
        threshold: summary.ranking.threshold,
        budget: summary.ranking.budget,
        noResultReason: summary.ranking.noResultReason,
      };
      filtering = {
        types: [...summary.filtering.types],
        tags: [...summary.filtering.tags],
        since: summary.filtering.since,
        until: summary.filtering.until,
        around: summary.filtering.around
          ? {
              source: summary.filtering.around.source,
              anchor: summary.filtering.around.anchor,
              radiusDays: summary.filtering.around.radiusDays,
            }
          : undefined,
      };
      candidateCounts.merged = summary.candidateCounts.merged;
      candidateCounts.thresholdQualified = summary.candidateCounts.thresholdQualified;
      candidateCounts.budgetAccepted = summary.candidateCounts.budgetAccepted;
      candidateCounts.finalRanked = summary.candidateCounts.finalRanked;
      candidateCounts.returned = summary.candidateCounts.returned;
      stageTimings.mergeCandidatesMs = summary.timings.mergeCandidatesMs;
      stageTimings.scoreCandidatesMs = summary.timings.scoreCandidatesMs;
      stageTimings.thresholdMs = summary.timings.thresholdMs;
      stageTimings.budgetMs = summary.timings.budgetMs;
      stageTimings.shapeResultsMs = summary.timings.shapeResultsMs;
    },
  };

  return {
    traceSink,
    isObservationEnabled(): boolean {
      return observationEnabled;
    },
    recordSandboxSetup(durationMs: number): void {
      stageTimings.sandboxSetupMs = durationMs;
    },
    recordFixtureProvisionTiming(durationMs: number): void {
      stageTimings.fixtureProvisionMs = durationMs;
    },
    recordProvision(result: RecallEvalProvisioningResult, durationMs: number): void {
      provisionObserved = true;
      execution.provisionedCount = result.provisionedCount;
      stageTimings.fixtureProvisionMs = durationMs;
      provision = {
        requestedCount: request.memoryPool.length,
        provisionedCount: result.provisionedCount,
        providedIdCount: result.providedIdCount,
        generatedIdCount: result.generatedIdCount,
        retiredCount: result.retiredCount,
        supersededCount: result.supersededCount,
        createdAtDefaultedCount: result.createdAtDefaultedCount,
        updatedAtDefaultedCount: result.updatedAtDefaultedCount,
        seededEntries: result.seededEntries.map((entry) => ({
          id: entry.id,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
          retired: entry.retired,
          superseded_by: entry.superseded_by,
        })),
      };
    },
    recordRecall(durationMs: number): void {
      stageTimings.recallMs = durationMs;
    },
    recordQueryEmbedding(params: { durationMs: number; dimensions: number }): void {
      retrievalObserved = true;
      stageTimings.queryEmbeddingMs = params.durationMs;
      retrieval.queryEmbeddingDimensions = params.dimensions;
    },
    recordVectorSearch(params: { durationMs: number; count: number; limit: number }): void {
      retrievalObserved = true;
      stageTimings.vectorSearchMs = params.durationMs;
      retrieval.vectorSearchLimit = params.limit;
      candidateCounts.vectorRetrieved = params.count;
    },
    recordLexicalSearch(params: { durationMs: number; count: number; limit: number }): void {
      retrievalObserved = true;
      stageTimings.lexicalSearchMs = params.durationMs;
      retrieval.lexicalSearchLimit = params.limit;
      candidateCounts.lexicalRetrieved = params.count;
    },
    recordHydrateEntries(params: { durationMs: number; count: number }): void {
      retrievalObserved = true;
      stageTimings.hydrateEntriesMs = params.durationMs;
      candidateCounts.hydrated = params.count;
    },
    recordRecallTelemetry(params: { durationMs: number; entryCount: number }): void {
      retrievalObserved = true;
      stageTimings.recordRecallEventsMs = params.durationMs;
      candidateCounts.telemetryAttempted = params.entryCount;
    },
    buildDiagnostics(): RecallEvalCaseDiagnostics | undefined {
      if (!diagnosticsRequested) {
        return undefined;
      }

      return {
        execution,
        provision: provisionObserved ? provision : undefined,
        retrieval: retrievalObserved ? retrieval : undefined,
        ranking: traceObserved ? ranking : undefined,
        filtering: traceObserved ? filtering : undefined,
        candidateCounts: retrievalObserved || traceObserved ? candidateCounts : undefined,
      };
    },
    buildTimings(totalMs: number): RecallEvalCaseTimings | undefined {
      if (!timingsRequested) {
        return undefined;
      }

      return {
        totalMs,
        sandboxSetupMs: stageTimings.sandboxSetupMs,
        fixtureProvisionMs: stageTimings.fixtureProvisionMs,
        recallMs: stageTimings.recallMs,
        queryEmbeddingMs: stageTimings.queryEmbeddingMs,
        vectorSearchMs: stageTimings.vectorSearchMs,
        lexicalSearchMs: stageTimings.lexicalSearchMs,
        mergeCandidatesMs: stageTimings.mergeCandidatesMs,
        scoreCandidatesMs: stageTimings.scoreCandidatesMs,
        thresholdMs: stageTimings.thresholdMs,
        budgetMs: stageTimings.budgetMs,
        hydrateEntriesMs: stageTimings.hydrateEntriesMs,
        shapeResultsMs: stageTimings.shapeResultsMs,
        recordRecallEventsMs: stageTimings.recordRecallEventsMs,
      };
    },
  };
}

/** Returns true when diagnostics were requested directly or via candidate visibility. */
function wantsRecallEvalDiagnostics(request: RecallEvalCaseRequest): boolean {
  return request.options?.includeDiagnostics === true || request.options?.includeCandidates === true;
}
