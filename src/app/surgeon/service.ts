import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runAgentLoop, type AfterToolCallContext, type AgentEvent, type AgentMessage, type BeforeToolCallContext } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@mariozechner/pi-ai";

import {
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  type AgenrConfig,
} from "../../config.js";
import { buildClaimKeyLifecycleUpdateFields, buildSurgeonAppliedClaimKeyLifecycleBundle } from "../../core/claim-key-lifecycle.js";
import type { Logger } from "../../logger.js";
import type { LlmPort, RecallPorts } from "../../core/ports.js";
import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import type { SurgeonPassType } from "../../core/surgeon/domain/pass-types.js";
import { getAutonomousSurgeonPassSequence, type ImplementedSurgeonPass } from "../../core/surgeon/domain/run-presets.js";
import type { SurgeonCompletionSummary, SurgeonRunStatus } from "../../core/surgeon/types.js";
import { createBudgetTracker } from "./budget.js";
import { runClaimKeyQualityPass } from "./claim-key-quality.js";
import { createSurgeonCompletionGuardState } from "./completion-guard.js";
import { emitSurgeonProgress, type SurgeonProgressReporter } from "./progress.js";
import { createTraceLogger, type SurgeonTraceLogger } from "./trace-logger.js";
import { getSurgeonClaimKeyQualityPassPrompt, getSurgeonRetirementPassPrompt, getSurgeonSupersessionPassPrompt, getSurgeonSystemPrompt } from "./prompts.js";
import type { SurgeonPort } from "./ports.js";
import { createSupersessionTools, createSurgeonTools, type SurgeonToolCompletionState } from "./tools/index.js";

/**
 * Safety valve for continuation prompts. Prevents infinite loops when the
 * model repeatedly stops without completing. This is a last resort - the
 * primary constraints are budget and candidate exhaustion.
 */
const MAX_AGENT_SLICES = 24;
const MAX_STALLED_SLICES = 2;
const USER_ABORT_ERROR = "Run aborted by user (SIGINT).";
const USER_ABORT_SUMMARY = "Run aborted by user.";

/**
 * CLI and runtime options accepted by one surgeon run.
 */
export interface SurgeonRunOptions {
  pass: ImplementedSurgeonPass;
  project?: string;
  type?: string;
  claimKeyPrefix?: string;
  entryIds?: string[];
  includeInactive?: boolean;
  budget: number;
  contextLimit?: number;
  apply: boolean;
  model?: string;
  provider?: string;
  skipEvaluatedDays?: number;
  verbose: boolean;
  tracePath?: string;
  json: boolean;
  signal?: AbortSignal;
  skipBackup?: boolean;
}

/**
 * Persisted summary returned after a surgeon run completes or fails.
 */
export interface SurgeonRunResult {
  runId: string;
  status: SurgeonRunStatus;
  passType: string;
  actionsTaken: number;
  actionsSkipped?: number;
  entriesRetired: number;
  reviewedEntries?: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  summary: string | null;
  completionSummary?: SurgeonCompletionSummary | null;
}

/**
 * Options accepted by one autonomous multi-pass surgeon run.
 */
export type SurgeonAutonomousRunOptions = Omit<SurgeonRunOptions, "pass">;

/**
 * Aggregate summary returned after an autonomous surgeon run completes.
 */
export interface SurgeonAutonomousRunResult {
  cyclesCompleted: number;
  passes: SurgeonRunResult[];
  status: SurgeonRunStatus;
  actionsTaken: number;
  entriesRetired: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  summary: string | null;
}

/**
 * Resolved infrastructure dependencies for the surgeon workflow.
 */
export interface SurgeonWorkflowDeps {
  port: SurgeonPort;
  dbPath?: string;
  config: AgenrConfig | null;
  model: Model<Api>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
  recallPorts?: RecallPorts;
  now?: () => Date;
  backupDb?: (dbPath: string) => Promise<string>;
  reportProgress?: SurgeonProgressReporter;
  logger?: Logger;
}

/**
 * Preflight counts captured before one surgeon pass starts.
 */
interface SurgeonPassStartContext {
  retirementRawActionableCandidates: number;
  retirementAvailableActionableCandidates: number;
  retirementAvailableAllCandidates: number;
  retirementRecentlyEvaluatedCandidates: number;
  supersessionClaimKeyClusters: number;
  supersessionSubjectClusters: number;
}

/** Agent-loop surgeon passes that use bounded continuation slices. */
type AgentSurgeonPass = Extract<SurgeonPassType, "retirement" | "supersession">;

/**
 * Runs the full autonomous surgeon sequence until no direct work remains or the run stops early.
 *
 * @param options - Shared run options for all passes in the autonomous loop.
 * @param deps - Resolved database, model, config, and optional recall runtime dependencies.
 * @returns Aggregate autonomous run summary plus per-pass results.
 */
export async function runAutonomousSurgeon(options: SurgeonAutonomousRunOptions, deps: SurgeonWorkflowDeps): Promise<SurgeonAutonomousRunResult> {
  const results: SurgeonRunResult[] = [];
  let cyclesCompleted = 0;
  let remainingBudget = resolveRunCostCap(options, deps.config);
  let backupCreated = false;
  const protection = resolveProtectionConfig(options, deps.config);
  const autonomousSequence = getAutonomousSurgeonPassSequence();

  while (remainingBudget > 0) {
    const includeClaimKeyQuality = cyclesCompleted === 0;
    const cycleWork = await loadAutonomousCycleWork(deps.port, {
      includeClaimKeyQuality,
      protectRecalledDays: protection.protectRecalledDays,
      protectMinImportance: protection.protectMinImportance,
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: deps.now ? deps.now() : new Date(),
    });
    const nextPasses = autonomousSequence.filter((pass) => cycleWork[pass] > 0);

    if (nextPasses.length === 0) {
      return finalizeAutonomousRun({
        cyclesCompleted,
        passes: results,
        status: "completed",
        summaryOverride: results.length === 0 ? "No direct surgeon work remained." : null,
      });
    }

    cyclesCompleted += 1;
    const repeatableCycleWork = normalizeRepeatableAutonomousCycleWork(cycleWork, includeClaimKeyQuality);
    const cycleResults: SurgeonRunResult[] = [];
    const executedPasses = new Set<ImplementedSurgeonPass>();
    let pendingWork = cycleWork;

    while (true) {
      const workBeforePass = pendingWork;
      const pass = findNextAutonomousPass({
        autonomousSequence,
        cycleWork: workBeforePass,
        executedPasses,
      });
      if (!pass) {
        break;
      }

      const retirementContextBefore =
        pass === "retirement"
          ? await loadPassStartContext("retirement", deps.port, {
              protectRecalledDays: protection.protectRecalledDays,
              protectMinImportance: protection.protectMinImportance,
              skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
              now: deps.now ? deps.now() : new Date(),
            })
          : null;
      const skipBackup = backupCreated;
      if (!skipBackup && options.apply && deps.dbPath && deps.dbPath !== ":memory:" && deps.backupDb) {
        backupCreated = true;
      }
      const result = await runSurgeon(
        {
          ...options,
          budget: remainingBudget,
          includeInactive: true,
          pass,
          skipBackup,
        },
        deps,
      );
      results.push(result);
      cycleResults.push(result);
      executedPasses.add(pass);
      remainingBudget = Math.max(0, remainingBudget - result.estimatedCostUsd);

      if (result.status === "stalled") {
        return finalizeAutonomousRun({
          cyclesCompleted,
          passes: results,
          status: result.status,
        });
      }

      if (result.status !== "completed" && result.status !== "no_work") {
        return finalizeAutonomousRun({
          cyclesCompleted,
          passes: results,
          status: result.status,
        });
      }

      pendingWork = await loadAutonomousCycleWork(deps.port, {
        includeClaimKeyQuality: false,
        protectRecalledDays: protection.protectRecalledDays,
        protectMinImportance: protection.protectMinImportance,
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        now: deps.now ? deps.now() : new Date(),
      });

      if (pass === "retirement" && retirementContextBefore) {
        const retirementTailDisposition = await shouldStopAfterLowYieldRetirementPass({
          result,
          cycleWorkBefore: workBeforePass,
          cycleWorkAfter: pendingWork,
          retirementContextBefore,
          port: deps.port,
          protection: {
            protectRecalledDays: protection.protectRecalledDays,
            protectMinImportance: protection.protectMinImportance,
            skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
            now: deps.now ? deps.now() : new Date(),
          },
        });
        if (retirementTailDisposition) {
          return finalizeAutonomousRun({
            cyclesCompleted,
            passes: results,
            status: retirementTailDisposition,
            summaryOverride:
              retirementTailDisposition === "completed"
                ? "Autonomous retirement review exhausted after conservative no-op coverage."
                : "Autonomous retirement tail stopped making direct progress.",
          });
        }
      }
    }

    if (!hasAutonomousWork(pendingWork)) {
      return finalizeAutonomousRun({
        cyclesCompleted,
        passes: results,
        status: "completed",
      });
    }

    if (
      shouldStopAfterNonActionableSupersessionCycle({
        cycleResults,
        cycleWorkBefore: repeatableCycleWork,
        cycleWorkAfter: pendingWork,
      })
    ) {
      return finalizeAutonomousRun({
        cyclesCompleted,
        passes: results,
        status: "completed",
        summaryOverride: "Autonomous supersession review exhausted with only non-actionable clusters remaining.",
      });
    }

    if (
      !autonomousCycleMadeDirectProgress({
        apply: options.apply,
        cycleResults,
        cycleWorkBefore: repeatableCycleWork,
        cycleWorkAfter: pendingWork,
      })
    ) {
      return finalizeAutonomousRun({
        cyclesCompleted,
        passes: results,
        status: "stalled",
        summaryOverride: "Autonomous surgeon cycle stopped making direct progress.",
      });
    }

    if (remainingBudget <= 0) {
      return finalizeAutonomousRun({
        cyclesCompleted,
        passes: results,
        status: hasAutonomousWork(pendingWork) ? "cost_capped" : "completed",
      });
    }
  }

  return finalizeAutonomousRun({
    cyclesCompleted,
    passes: results,
    status: "completed",
  });
}

/**
 * Runs one implemented surgeon pass and persists the run lifecycle.
 *
 * @param options - One-shot surgeon run options.
 * @param deps - Resolved database, model, config, and optional recall runtime dependencies.
 * @returns Final persisted run summary.
 */
export async function runSurgeon(options: SurgeonRunOptions, deps: SurgeonWorkflowDeps): Promise<SurgeonRunResult> {
  const nowFn = deps.now ?? (() => new Date());
  const signal = options.signal;
  const runCostCap = resolveRunCostCap(options, deps.config);
  const dailyCostCap = resolveDailyCostCap(deps.config);
  const contextLimit = resolveContextLimit(options, deps.config, deps.model);
  const protection = resolveProtectionConfig(options, deps.config);

  emitSurgeonProgress(deps.reportProgress, {
    kind: "phase",
    phase: "start",
    passType: options.pass,
    apply: options.apply,
  });

  const dailyCost = dailyCostCap > 0 ? await deps.port.getDailyCost(nowFn()) : 0;
  if (dailyCostCap > 0 && dailyCost >= dailyCostCap) {
    throw new Error(`Surgeon daily cost cap exceeded. Cost in the last 24 hours is ${formatUsd(dailyCost)} and the cap is ${formatUsd(dailyCostCap)}.`);
  }

  if (!options.skipBackup && options.apply && deps.dbPath && deps.dbPath !== ":memory:" && deps.backupDb) {
    emitSurgeonProgress(deps.reportProgress, {
      kind: "phase",
      phase: "backup_start",
      passType: options.pass,
      apply: options.apply,
    });
    const backupPath = await deps.backupDb(deps.dbPath);
    emitSurgeonProgress(deps.reportProgress, {
      kind: "phase",
      phase: "backup_complete",
      passType: options.pass,
      apply: options.apply,
      backupPath,
    });
  }

  const budgetTracker = createBudgetTracker({
    contextLimit,
    costCapUsd: runCostCap,
  });
  const completionState = createCompletionState();
  const actionMetrics = {
    actionsTaken: 0,
    entriesRetired: 0,
  };

  if (options.pass === "claim_key_quality") {
    const runId = await deps.port.createRun({
      passType: options.pass,
      project: options.project,
      model: typeof deps.model.id === "string" ? deps.model.id : (options.model ?? null),
      dryRun: !options.apply,
      startedAt: nowFn().toISOString(),
      config: {
        project: options.project ?? null,
        apply: options.apply,
        budget: runCostCap,
        contextLimit: contextLimit || null,
        model: options.model ?? null,
        provider: options.provider ?? null,
        skipEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        verbose: options.verbose,
      },
    });

    try {
      emitSurgeonProgress(deps.reportProgress, {
        kind: "phase",
        phase: "load_working_set_start",
        passType: options.pass,
        apply: options.apply,
      });
      const deterministicResult = await runClaimKeyQualityPass(
        {
          runId,
          apply: options.apply,
          project: options.project,
          type: options.type,
          claimKeyPrefix: options.claimKeyPrefix,
          entryIds: options.entryIds,
          includeInactive: options.includeInactive,
          signal,
          now: nowFn,
          costCapUsd: runCostCap,
          verbose: options.verbose,
          reportProgress: deps.reportProgress,
        },
        {
          port: deps.port,
          config: deps.config,
          createClaimExtractionLlm: deps.createClaimExtractionLlm,
        },
      );
      completionState.setComplete(deterministicResult.completion);
      actionMetrics.actionsTaken = deterministicResult.completion.actions_taken;
      actionMetrics.entriesRetired = deterministicResult.entriesRetired;

      return finalizeRun({
        runId,
        status: deterministicResult.status,
        passType: options.pass,
        completionState,
        actionMetrics,
        usageTotals: deterministicResult.usage,
        error: deterministicResult.error,
        port: deps.port,
        now: nowFn,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        return finalizeRun({
          runId,
          status: "aborted",
          passType: options.pass,
          completionState,
          actionMetrics,
          budgetTracker,
          error: USER_ABORT_ERROR,
          summaryOverride: USER_ABORT_SUMMARY,
          port: deps.port,
          now: nowFn,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      return finalizeRun({
        runId,
        status: "failed",
        passType: options.pass,
        completionState,
        actionMetrics,
        budgetTracker,
        error: message,
        port: deps.port,
        now: nowFn,
      });
    }
  }

  emitSurgeonProgress(deps.reportProgress, {
    kind: "phase",
    phase: "load_pass_context_start",
    passType: options.pass,
    apply: options.apply,
  });
  const [health, passStartContext, lastRun] = await Promise.all([
    deps.port.getHealthStats({
      protectRecalledDays: protection.protectRecalledDays,
      protectMinImportance: protection.protectMinImportance,
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: nowFn(),
    }),
    loadPassStartContext(options.pass, deps.port, {
      protectRecalledDays: protection.protectRecalledDays,
      protectMinImportance: protection.protectMinImportance,
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: nowFn(),
    }),
    deps.port.getLastRun(),
  ]);
  emitSurgeonProgress(deps.reportProgress, {
    kind: "phase",
    phase: "load_pass_context_complete",
    passType: options.pass,
    apply: options.apply,
    workingSetSize: health.total,
  });
  emitSurgeonProgress(deps.reportProgress, {
    kind: "phase",
    phase: "pass_start",
    passType: options.pass,
    apply: options.apply,
  });

  const runId = await deps.port.createRun({
    passType: options.pass,
    project: options.project,
    model: typeof deps.model.id === "string" ? deps.model.id : (options.model ?? null),
    dryRun: !options.apply,
    startedAt: nowFn().toISOString(),
    config: {
      project: options.project ?? null,
      apply: options.apply,
      budget: runCostCap,
      contextLimit: contextLimit || null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      skipEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      verbose: options.verbose,
    },
  });

  if (options.pass === "proposal_resolution") {
    try {
      const proposalResult = await runProposalResolutionPass(
        {
          runId,
          apply: options.apply,
          now: nowFn,
          reportProgress: deps.reportProgress,
        },
        {
          port: deps.port,
          recordRunAction: async (action) => {
            await deps.port.logRunAction(action);
            if (action.actionType !== "skip") {
              actionMetrics.actionsTaken += 1;
            }
          },
        },
      );
      if (proposalResult.completion) {
        completionState.setComplete(proposalResult.completion);
      }

      return finalizeRun({
        runId,
        status: proposalResult.status,
        passType: options.pass,
        completionState,
        actionMetrics,
        budgetTracker,
        error: proposalResult.error,
        summaryOverride: proposalResult.summaryOverride,
        port: deps.port,
        now: nowFn,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalizeRun({
        runId,
        status: signal?.aborted === true ? "aborted" : "failed",
        passType: options.pass,
        completionState,
        actionMetrics,
        budgetTracker,
        error: signal?.aborted === true ? USER_ABORT_ERROR : message,
        summaryOverride: signal?.aborted === true ? USER_ABORT_SUMMARY : undefined,
        port: deps.port,
        now: nowFn,
      });
    }
  }

  const agentPass: AgentSurgeonPass = options.pass;
  const noDirectWork =
    agentPass === "retirement"
      ? passStartContext.retirementAvailableAllCandidates === 0
      : passStartContext.supersessionClaimKeyClusters + passStartContext.supersessionSubjectClusters === 0;
  if (noDirectWork) {
    return finalizeRun({
      runId,
      status: "no_work",
      passType: options.pass,
      completionState,
      actionMetrics,
      budgetTracker,
      error: null,
      summaryOverride:
        agentPass === "retirement"
          ? "No retirement candidates were available after applying current filters."
          : "No supersession clusters were available after applying current filters.",
      port: deps.port,
      now: nowFn,
    });
  }

  const usageSeen = new Set<string>();
  let terminalStatus: SurgeonRunStatus | null = null;
  let terminalError: string | null = null;
  let traceLogger: SurgeonTraceLogger | null = null;
  let completionGuards: ReturnType<typeof createSurgeonCompletionGuardState> | null = null;

  try {
    const systemPrompt = buildSystemPrompt(options.pass, deps.config);
    completionGuards = createSurgeonCompletionGuardState({
      totalEntries: health.total,
      retirementCandidates: passStartContext.retirementRawActionableCandidates,
      retirementAvailableActionableCandidates: passStartContext.retirementAvailableActionableCandidates,
      retirementAvailableAllCandidates: passStartContext.retirementAvailableAllCandidates,
      supersessionClaimKeyClusters: passStartContext.supersessionClaimKeyClusters,
      supersessionSubjectClusters: passStartContext.supersessionSubjectClusters,
    });
    traceLogger = createTraceLogger({
      verbose: options.verbose,
      tracePath: resolveTracePath(options.tracePath, agentPass, runId),
      budgetTracker,
      logger: deps.logger,
    });

    const tools = createToolsForPass(agentPass, {
      passType: agentPass,
      port: deps.port,
      runId,
      project: options.project,
      apply: options.apply,
      protection: {
        protectRecalledDays: protection.protectRecalledDays,
        protectMinImportance: protection.protectMinImportance,
      },
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: nowFn,
      recordRunAction: async (action) => {
        await deps.port.logRunAction(action);
        traceLogger?.logAction(action);
        if (action.actionType !== "skip") {
          actionMetrics.actionsTaken += 1;
        }
      },
      completionState,
      budgetTracker,
      costCap: runCostCap,
      completionGuards,
      recallPorts: deps.recallPorts,
    });

    const initialPrompt = buildInitialUserPrompt({
      pass: agentPass,
      project: options.project,
      totalEntries: health.total,
      typeMix: health.byType,
      claimKeyLifecycle: health.claimKeyLifecycle,
      retirementCandidates: passStartContext.retirementAvailableActionableCandidates,
      supersessionClaimKeyClusters: passStartContext.supersessionClaimKeyClusters,
      supersessionSubjectClusters: passStartContext.supersessionSubjectClusters,
      lastRun,
      costCapUsd: runCostCap,
      contextLimit,
    });

    let sliceAttempt = 0;
    let stalledSlices = 0;
    let previousFingerprint: string | null = null;

    while (!completionState.isComplete && terminalStatus === null) {
      if (signal?.aborted === true) {
        terminalStatus = "aborted";
        terminalError = USER_ABORT_ERROR;
        break;
      }
      if (budgetTracker.isExhausted()) {
        terminalStatus = "budget_exhausted";
        terminalError = "Context limit exhausted.";
        break;
      }
      if (budgetTracker.isCostCapExceeded()) {
        terminalStatus = "cost_capped";
        terminalError = "Cost cap exceeded.";
        break;
      }
      if (sliceAttempt >= MAX_AGENT_SLICES) {
        terminalStatus = "stalled";
        terminalError = `${agentPass} pass exhausted ${MAX_AGENT_SLICES} bounded slices without reaching complete_pass.`;
        break;
      }

      const prompt =
        sliceAttempt === 0
          ? initialPrompt
          : buildContinuationPrompt({
              pass: agentPass,
              currentContextTokens: budgetTracker.remaining().currentContextTokens,
              contextLimit: budgetTracker.remaining().contextLimit,
              remainingCostUsd: budgetTracker.remaining().remainingCostUsd,
              attempt: sliceAttempt,
              completionGuards,
              actionMetrics,
            });
      sliceAttempt += 1;

      await runAgentLoop(
        [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
        {
          systemPrompt,
          messages: [],
          tools,
        },
        {
          model: deps.model,
          convertToLlm,
          toolExecution: "sequential",
          getApiKey: deps.getApiKey,
          getFollowUpMessages: async () => [],
          beforeToolCall: async (context: BeforeToolCallContext) => {
            registerUsage(context.assistantMessage, usageSeen, budgetTracker);

            if (signal?.aborted === true) {
              terminalStatus = terminalStatus ?? "aborted";
              terminalError = terminalError ?? USER_ABORT_ERROR;

              if (context.toolCall.name !== "complete_pass") {
                return {
                  block: true,
                  reason: USER_ABORT_SUMMARY,
                };
              }
            }

            if (budgetTracker.isExhausted()) {
              terminalStatus = terminalStatus ?? "budget_exhausted";
              terminalError = terminalError ?? "Context limit exhausted.";

              if (context.toolCall.name !== "complete_pass") {
                return {
                  block: true,
                  reason: terminalError,
                };
              }
            }

            if (budgetTracker.isCostCapExceeded()) {
              terminalStatus = terminalStatus ?? "cost_capped";
              terminalError = terminalError ?? "Cost cap exceeded.";

              if (context.toolCall.name !== "complete_pass") {
                return {
                  block: true,
                  reason: terminalError,
                };
              }
            }

            if (completionState.isComplete && context.toolCall.name !== "complete_pass") {
              return {
                block: true,
                reason: "Pass already completed.",
              };
            }

            return undefined;
          },
          afterToolCall: async (context: AfterToolCallContext) => {
            try {
              const actionType = toolNameToActionType(context.toolCall.name);
              if (!actionType || context.isError || !shouldAuditAction(actionType, context.result.details)) {
                return undefined;
              }

              const entryIds = extractEntryIds(context.args);
              const reasoning = extractActionReasoning(context.assistantMessage, context.args, context.result.details, context.toolCall.name);
              const action: SurgeonRunAction = {
                id: randomUUID(),
                runId,
                actionType,
                entryIds,
                reasoning,
                recallDelta: null,
                createdAt: nowFn().toISOString(),
              };

              await deps.port.logRunAction(action);
              traceLogger?.logAction(action);
              actionMetrics.actionsTaken += 1;

              if (actionType === "retire") {
                actionMetrics.entriesRetired += 1;
              }
            } catch {
              // afterToolCall must never throw
            }

            return undefined;
          },
        },
        (event: AgentEvent) => {
          if (event.type === "message_end" && isAssistantMessage(event.message)) {
            registerUsage(event.message, usageSeen, budgetTracker);
          }

          traceLogger?.onEvent(event);
        },
        signal,
      );

      if (completionState.isComplete || terminalStatus !== null) {
        continue;
      }

      const fingerprint = createPassProgressFingerprint(agentPass, completionGuards, actionMetrics, completionState);
      if (previousFingerprint !== null && previousFingerprint === fingerprint) {
        stalledSlices += 1;
      } else {
        stalledSlices = 0;
      }
      previousFingerprint = fingerprint;

      if (stalledSlices >= MAX_STALLED_SLICES) {
        terminalStatus = "stalled";
        terminalError = `${agentPass} pass stopped making semantic progress across bounded slices.`;
      }
    }

    const finalStatus = completionState.summary ? (terminalStatus ?? "completed") : (terminalStatus ?? "stalled");
    return finalizeRun({
      runId,
      status: finalStatus,
      passType: options.pass,
      completionState,
      actionMetrics,
      budgetTracker,
      error: terminalError,
      reviewedEntries: agentPass === "retirement" ? completionGuards?.retirement.snapshot().reviewedEntryCount : undefined,
      summaryOverride:
        finalStatus === "aborted" ? USER_ABORT_SUMMARY : finalStatus === "stalled" ? buildStalledRunSummary(agentPass, actionMetrics) : undefined,
      port: deps.port,
      now: nowFn,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      return finalizeRun({
        runId,
        status: "aborted",
        passType: options.pass,
        completionState,
        actionMetrics,
        budgetTracker,
        error: USER_ABORT_ERROR,
        summaryOverride: USER_ABORT_SUMMARY,
        reviewedEntries: agentPass === "retirement" ? completionGuards?.retirement.snapshot().reviewedEntryCount : undefined,
        port: deps.port,
        now: nowFn,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return finalizeRun({
      runId,
      status: terminalStatus ?? "failed",
      passType: options.pass,
      completionState,
      actionMetrics,
      budgetTracker,
      error: terminalError ?? message,
      reviewedEntries: agentPass === "retirement" ? completionGuards?.retirement.snapshot().reviewedEntryCount : undefined,
      port: deps.port,
      now: nowFn,
    });
  } finally {
    traceLogger?.close();
  }
}

/**
 * Resolves the effective per-run cost cap.
 *
 * @param options - One-shot surgeon run options.
 * @param config - Optional persisted agenr configuration.
 * @returns Positive cost cap in USD.
 */
function resolveRunCostCap(options: { budget: number }, config: AgenrConfig | null): number {
  if (Number.isFinite(options.budget) && options.budget > 0) {
    return options.budget;
  }

  return normalizePositiveNumber(config?.surgeon?.costCap) ?? DEFAULT_SURGEON_COST_CAP;
}

/**
 * Resolves the effective 24-hour surgeon cost cap.
 *
 * @param config - Optional persisted agenr configuration.
 * @returns Daily cost cap in USD. Zero disables the check.
 */
function resolveDailyCostCap(config: AgenrConfig | null): number {
  return normalizeNonNegativeNumber(config?.surgeon?.dailyCostCap) ?? DEFAULT_SURGEON_DAILY_COST_CAP;
}

/**
 * Resolves the per-turn context limit used by the budget tracker.
 *
 * @param options - One-shot surgeon run options.
 * @param config - Optional persisted agenr configuration.
 * @param model - Resolved pi-ai model.
 * @returns Context limit in tokens, or zero when unknown.
 */
function resolveContextLimit(options: SurgeonRunOptions, config: AgenrConfig | null, model: Model<Api>): number {
  const cliLimit = normalizePositiveInteger(options.contextLimit);
  if (cliLimit !== undefined) {
    return cliLimit;
  }

  const configuredLimit = normalizePositiveInteger(config?.surgeon?.contextLimit);
  if (configuredLimit !== undefined) {
    return configuredLimit;
  }

  const detectedLimit = normalizePositiveInteger(typeof model.contextWindow === "number" ? Math.floor(model.contextWindow * 0.85) : undefined);
  return detectedLimit ?? DEFAULT_SURGEON_CONTEXT_LIMIT;
}

/**
 * Resolves the retirement-protection settings used by tools and health queries.
 *
 * @param options - One-shot surgeon run options.
 * @param config - Optional persisted agenr configuration.
 * @returns Hard-protection thresholds for the retirement pass.
 */
function resolveProtectionConfig(
  options: { skipEvaluatedDays?: number },
  config: AgenrConfig | null,
): {
  protectRecalledDays: number;
  protectMinImportance: number;
  skipRecentlyEvaluatedDays: number;
} {
  const passConfig = config?.surgeon?.passes?.retirement;

  return {
    protectRecalledDays: normalizeNonNegativeInteger(passConfig?.protectRecalledDays) ?? DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
    protectMinImportance: normalizeNonNegativeInteger(passConfig?.protectMinImportance) ?? DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
    skipRecentlyEvaluatedDays:
      normalizeNonNegativeInteger(options.skipEvaluatedDays) ??
      normalizeNonNegativeInteger(passConfig?.skipRecentlyEvaluatedDays) ??
      DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  };
}

/**
 * Resolves one pass trace destination to a concrete file path.
 *
 * Existing directories receive one per-pass JSONL file so `--trace <dir>` can
 * be used without changing current file-path semantics.
 *
 * @param tracePath - Raw trace path supplied by the caller.
 * @param passType - Pass currently running.
 * @param runId - Persisted run identifier for this pass.
 * @returns Concrete trace file path.
 */
function resolveTracePath(tracePath: string | undefined, passType: Extract<SurgeonPassType, "retirement" | "supersession">, runId: string): string | undefined {
  if (!tracePath) {
    return undefined;
  }

  try {
    if (fs.statSync(tracePath).isDirectory()) {
      return path.join(tracePath, `surgeon-${passType}-${runId}.jsonl`);
    }
  } catch {
    return tracePath;
  }

  return tracePath;
}

/**
 * Joins the shared and pass-specific prompt blocks into one system prompt.
 *
 * @param pass - Surgeon pass being executed.
 * @param config - Optional persisted agenr configuration.
 * @returns Full system prompt text for the run.
 */
function buildSystemPrompt(pass: ImplementedSurgeonPass, config: AgenrConfig | null): string {
  return [getSurgeonSystemPrompt().trim(), getPassPrompt(pass).trim(), config?.surgeon?.customInstructions?.trim() ?? ""]
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/**
 * Builds the first user message that starts the surgeon run.
 *
 * @param input - Run facts known before the first model turn.
 * @returns Initial user prompt.
 */
function buildInitialUserPrompt(input: {
  pass: Extract<SurgeonPassType, "retirement" | "supersession">;
  project?: string;
  totalEntries: number;
  typeMix: Record<string, number>;
  claimKeyLifecycle: {
    trusted: number;
    tentative: number;
    unresolved: number;
    legacy: number;
    noKey: number;
  };
  retirementCandidates: number;
  supersessionClaimKeyClusters: number;
  supersessionSubjectClusters: number;
  lastRun: {
    passType: string;
    status: string;
    startedAt: string;
    dryRun: boolean;
  } | null;
  costCapUsd: number;
  contextLimit: number;
}): string {
  const lines =
    input.pass === "supersession"
      ? [
          "Begin supersession pass.",
          formatRequestedScope(input.project),
          `Entries: ${input.totalEntries}.`,
          `Observed type mix: ${formatTypeMix(input.typeMix)}.`,
          `Claim-key coverage: ${formatClaimKeyCoverage(input.claimKeyLifecycle)}.`,
          `Claim-key clusters: ${input.supersessionClaimKeyClusters}.`,
          `Subject clusters: ${input.supersessionSubjectClusters}.`,
          `Last surgeon run: ${formatLastRun(input.lastRun)}.`,
          input.contextLimit > 0
            ? `Your cost budget is ${formatUsd(input.costCapUsd)}. Your context window is ${input.contextLimit} tokens.`
            : `Your cost budget is ${formatUsd(input.costCapUsd)}. Context limit auto-detection was unavailable.`,
          "Work conservatively, finish the claim_key sweep first, and use complete_pass when you are done.",
        ]
      : [
          "Begin retirement pass.",
          formatRequestedScope(input.project),
          `Entries: ${input.totalEntries}.`,
          `Observed type mix: ${formatTypeMix(input.typeMix)}.`,
          `Claim-key coverage: ${formatClaimKeyCoverage(input.claimKeyLifecycle)}.`,
          `Actionable cleanup pool: ${input.retirementCandidates}.`,
          `Last surgeon run: ${formatLastRun(input.lastRun)}.`,
          input.contextLimit > 0
            ? `Your cost budget is ${formatUsd(input.costCapUsd)}. Your context window is ${input.contextLimit} tokens.`
            : `Your cost budget is ${formatUsd(input.costCapUsd)}. Context limit auto-detection was unavailable.`,
          "Work conservatively and use complete_pass when you are done.",
        ];

  return lines.join(" ");
}

/**
 * Formats the requested run scope for startup prompts.
 *
 * @param project - Optional project filter supplied by the operator.
 * @returns User-facing scope label.
 */
function formatRequestedScope(project: string | undefined): string {
  const normalized = project?.trim();
  return normalized ? `Requested scope: project = ${normalized}.` : "Requested scope: corpus-wide.";
}

/**
 * Formats the observed entry-type distribution for startup prompts.
 *
 * @param typeMix - Aggregate per-type entry counts from health stats.
 * @returns Stable human-readable type-mix summary.
 */
function formatTypeMix(typeMix: Record<string, number>): string {
  const populated = Object.entries(typeMix)
    .filter(([, count]) => count > 0)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    });

  if (populated.length === 0) {
    return "none";
  }

  return populated.map(([type, count]) => `${type}=${count}`).join(", ");
}

/**
 * Formats claim-key lifecycle coverage for startup prompts.
 *
 * @param lifecycle - Aggregate claim-key lifecycle counts from health stats.
 * @returns Stable human-readable lifecycle summary.
 */
function formatClaimKeyCoverage(input: { trusted: number; tentative: number; unresolved: number; legacy: number; noKey: number }): string {
  return `trusted=${input.trusted}, tentative=${input.tentative}, unresolved=${input.unresolved}, legacy=${input.legacy}, noKey=${input.noKey}`;
}

/**
 * Builds the continuation prompt injected when the model stops early.
 *
 * @param input - Remaining budget snapshot and continuation attempt count.
 * @returns Follow-up prompt that tells the model to continue the pass.
 */
function buildContinuationPrompt(input: {
  pass: Extract<SurgeonPassType, "retirement" | "supersession">;
  currentContextTokens: number;
  contextLimit: number;
  remainingCostUsd: number;
  attempt: number;
  completionGuards: ReturnType<typeof createSurgeonCompletionGuardState>;
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  };
}): string {
  const progressReminder = buildContinuationProgressReminder(input.pass, input.completionGuards, input.actionMetrics);
  const lines =
    input.pass === "supersession"
      ? [
          input.contextLimit > 0
            ? `You stopped without calling complete_pass and the latest turn used ${input.currentContextTokens}/${input.contextLimit} context tokens, with about ${formatUsd(input.remainingCostUsd)} of run budget remaining.`
            : `You stopped without calling complete_pass and still have about ${formatUsd(input.remainingCostUsd)} of run budget remaining. The latest turn context size was ${input.currentContextTokens} tokens.`,
          "Continue the supersession pass.",
          progressReminder,
          "Keep paginating claim_key clusters while any remain. Once the claim_key sweep returns no remaining clusters, query scope = 'subject' to confirm whether lower-confidence work remains.",
          "If both claim_key and subject sweeps are exhausted, call complete_pass and include any reviewed but intentionally unlinked clusters in entries_skipped.",
          "Avoid no-op metadata actions that do not change persisted state.",
        ]
      : [
          input.contextLimit > 0
            ? `You stopped without calling complete_pass and the latest turn used ${input.currentContextTokens}/${input.contextLimit} context tokens, with about ${formatUsd(input.remainingCostUsd)} of run budget remaining.`
            : `You stopped without calling complete_pass and still have about ${formatUsd(input.remainingCostUsd)} of run budget remaining. The latest turn context size was ${input.currentContextTokens} tokens.`,
          "Continue the retirement pass.",
          progressReminder,
          "Resume from the next unpaged candidate window instead of restarting earlier offsets. If the actionable scope is exhausted and meaningful budget remains, widen to scope = 'all'.",
          "Do not call complete_pass until candidates are genuinely exhausted or budget constraints force you to stop.",
        ];

  return lines.join(" ");
}

/**
 * Resolves automatically eligible proposal backlog entries without invoking the agent loop.
 *
 * @param input - Run metadata and progress reporter.
 * @param deps - Backlog storage and action-recording dependencies.
 * @returns Terminal proposal-resolution outcome for this pass.
 */
async function runProposalResolutionPass(
  input: {
    runId: string;
    apply: boolean;
    now: () => Date;
    reportProgress?: SurgeonProgressReporter;
  },
  deps: {
    port: SurgeonPort;
    recordRunAction(action: SurgeonRunAction): Promise<void>;
  },
): Promise<{
  status: SurgeonRunStatus;
  completion: SurgeonCompletionSummary | null;
  error: string | null;
  summaryOverride?: string;
}> {
  const backlog = await deps.port.listProposalBacklog({
    state: "open",
    eligibleOnly: true,
    limit: 100,
    offset: 0,
  });

  let appliedCount = 0;
  let rejectedInactiveCount = 0;
  let noChangeCount = 0;
  const updatedEntryIds = new Set<string>();

  emitProposalResolutionProgress(input.reportProgress, {
    apply: input.apply,
    status: backlog.length === 0 ? "no_work" : "started",
    totalProposals: backlog.length,
    processedProposals: 0,
    appliedCount,
    rejectedInactiveCount,
    noChangeCount,
    targetedEntryCount: updatedEntryIds.size,
  });

  if (backlog.length === 0) {
    return {
      status: "no_work",
      completion: null,
      error: null,
      summaryOverride: "No eligible surgeon proposals were available for autonomous resolution.",
    };
  }

  for (const [index, item] of backlog.entries()) {
    const proposal = item.proposal;
    const targetClaimKey = normalizeProposalApplyTarget(proposal);
    const reasoning = buildProposalReviewReason(proposal, "Autonomous eligible proposal resolution.");
    const proposalEntryIds: string[] = [];
    let sawActiveEntry = false;

    if (input.apply) {
      for (const entryId of proposal.entryIds) {
        const entry = await deps.port.getEntry(entryId);
        if (!entry) {
          continue;
        }
        sawActiveEntry = true;

        const lifecycle = buildSurgeonAppliedClaimKeyLifecycleBundle({
          targetClaimKey,
          priorClaimKey: entry.claim_key ?? null,
          priorClaimKeyRaw: entry.claim_key_raw,
          source: proposal.source,
          confidence: proposal.confidence,
          rationale: reasoning,
        });
        const updated = await deps.port.updateEntry(entry.id, buildClaimKeyLifecycleUpdateFields(lifecycle));
        if (updated) {
          proposalEntryIds.push(entry.id);
          updatedEntryIds.add(entry.id);
        }
      }

      if (proposalEntryIds.length === 0) {
        if (!sawActiveEntry) {
          await deps.port.reviewProposal({
            proposalId: proposal.id,
            status: "rejected",
            reason: "Autonomous eligible proposal could not be applied because all target entries are inactive or retired.",
            reviewedAt: input.now().toISOString(),
            appliedActionCount: 0,
          });
          rejectedInactiveCount += 1;
          emitProposalResolutionProgress(input.reportProgress, {
            apply: input.apply,
            status: "proposal_processed",
            totalProposals: backlog.length,
            processedProposals: index + 1,
            appliedCount,
            rejectedInactiveCount,
            noChangeCount,
            targetedEntryCount: updatedEntryIds.size,
            proposalId: proposal.id,
            issueKind: proposal.issueKind,
            outcome: "rejected_inactive",
          });
        } else {
          noChangeCount += 1;
          emitProposalResolutionProgress(input.reportProgress, {
            apply: input.apply,
            status: "proposal_processed",
            totalProposals: backlog.length,
            processedProposals: index + 1,
            appliedCount,
            rejectedInactiveCount,
            noChangeCount,
            targetedEntryCount: updatedEntryIds.size,
            proposalId: proposal.id,
            issueKind: proposal.issueKind,
            outcome: "no_change",
          });
        }
        continue;
      }

      await deps.port.reviewProposal({
        proposalId: proposal.id,
        status: "applied",
        reason: "Autonomously applied eligible surgeon proposal.",
        reviewedAt: input.now().toISOString(),
        appliedActionCount: 1,
      });
    } else {
      for (const entryId of proposal.entryIds) {
        proposalEntryIds.push(entryId);
        updatedEntryIds.add(entryId);
      }
    }

    await deps.recordRunAction({
      id: randomUUID(),
      runId: input.runId,
      actionType: "update_entry",
      entryIds: proposalEntryIds,
      reasoning,
      recallDelta: null,
      details: {
        proposal_id: proposal.id,
        proposal_issue_kind: proposal.issueKind,
        proposal_source: proposal.source,
        proposal_review_status: input.apply ? "applied" : "dry_run",
        target_claim_key: targetClaimKey,
      },
      createdAt: input.now().toISOString(),
    });
    appliedCount += 1;
    emitProposalResolutionProgress(input.reportProgress, {
      apply: input.apply,
      status: "proposal_processed",
      totalProposals: backlog.length,
      processedProposals: index + 1,
      appliedCount,
      rejectedInactiveCount,
      noChangeCount,
      targetedEntryCount: updatedEntryIds.size,
      proposalId: proposal.id,
      issueKind: proposal.issueKind,
      outcome: input.apply ? "applied" : "dry_run",
    });
  }

  if (appliedCount === 0 && rejectedInactiveCount === 0) {
    emitProposalResolutionProgress(input.reportProgress, {
      apply: input.apply,
      status: "stalled",
      totalProposals: backlog.length,
      processedProposals: backlog.length,
      appliedCount,
      rejectedInactiveCount,
      noChangeCount,
      targetedEntryCount: updatedEntryIds.size,
    });
    return {
      status: "stalled",
      completion: null,
      error: "Eligible proposal backlog was present, but no proposal could be advanced.",
      summaryOverride: "Eligible surgeon proposals were present, but none could be advanced safely.",
    };
  }

  emitProposalResolutionProgress(input.reportProgress, {
    apply: input.apply,
    status: "completed",
    totalProposals: backlog.length,
    processedProposals: backlog.length,
    appliedCount,
    rejectedInactiveCount,
    noChangeCount,
    targetedEntryCount: updatedEntryIds.size,
  });
  return {
    status: "completed",
    completion: {
      actions_taken: appliedCount,
      entries_skipped: [],
      observations: [
        `Processed ${appliedCount} eligible surgeon proposal${appliedCount === 1 ? "" : "s"}.`,
        `${updatedEntryIds.size} entr${updatedEntryIds.size === 1 ? "y was" : "ies were"} targeted by proposal resolution.`,
        ...(rejectedInactiveCount > 0
          ? [`Rejected ${rejectedInactiveCount} stale eligible proposal${rejectedInactiveCount === 1 ? "" : "s"} whose target entries were no longer active.`]
          : []),
      ],
      recommendations: ["Leave non-eligible surgeon proposals on the manual review path."],
    },
    error: null,
  };
}

/**
 * Builds the persisted rationale for one autonomously reviewed proposal.
 *
 * @param proposal - Proposal being applied or rejected.
 * @param reviewReason - Operator-facing reason to append.
 * @returns Joined review rationale string.
 */
function buildProposalReviewReason(proposal: { id: string; rationale: string }, reviewReason: string): string {
  return `Approved surgeon proposal ${proposal.id}: ${proposal.rationale} Review note: ${reviewReason}`.trim();
}

/**
 * Emits one structured proposal-resolution progress event when a reporter is configured.
 *
 * @param reporter - Optional progress callback supplied by the caller.
 * @param input - Snapshot of proposal-resolution progress counters.
 */
function emitProposalResolutionProgress(
  reporter: SurgeonProgressReporter | undefined,
  input: {
    apply: boolean;
    status: "started" | "proposal_processed" | "completed" | "no_work" | "stalled";
    totalProposals: number;
    processedProposals: number;
    appliedCount: number;
    rejectedInactiveCount: number;
    noChangeCount: number;
    targetedEntryCount: number;
    proposalId?: string;
    issueKind?: string;
    outcome?: "applied" | "dry_run" | "rejected_inactive" | "no_change";
  },
): void {
  emitSurgeonProgress(reporter, {
    kind: "proposal_resolution_progress",
    passType: "proposal_resolution",
    apply: input.apply,
    status: input.status,
    totalProposals: input.totalProposals,
    processedProposals: input.processedProposals,
    appliedCount: input.appliedCount,
    rejectedInactiveCount: input.rejectedInactiveCount,
    noChangeCount: input.noChangeCount,
    targetedEntryCount: input.targetedEntryCount,
    proposalId: input.proposalId,
    issueKind: input.issueKind,
    outcome: input.outcome,
  });
}

/**
 * Validates and returns the single claim key targeted by an eligible proposal.
 *
 * @param proposal - Proposal selected for autonomous application.
 * @returns Normalized target claim key.
 */
function normalizeProposalApplyTarget(proposal: { id: string; eligibleForApply: boolean; proposedClaimKeys: string[] }): string {
  if (!proposal.eligibleForApply) {
    throw new Error(`Proposal ${proposal.id} is not eligible for autonomous apply.`);
  }
  if (proposal.proposedClaimKeys.length !== 1) {
    throw new Error(`Proposal ${proposal.id} cannot be applied automatically because it does not resolve to exactly one proposed claim key.`);
  }

  const targetClaimKey = proposal.proposedClaimKeys[0]?.trim();
  if (!targetClaimKey) {
    throw new Error(`Proposal ${proposal.id} is missing a valid proposed claim key.`);
  }

  return targetClaimKey;
}

/**
 * Serializes bounded-slice progress into a stable fingerprint for stall detection.
 *
 * @param pass - Active agent-loop pass.
 * @param completionGuards - Completion-guard state for the current run.
 * @param actionMetrics - Persisted non-skip action counters.
 * @param completionState - Mutable completion marker for the pass.
 * @returns Stable fingerprint string describing semantic progress.
 */
function createPassProgressFingerprint(
  pass: AgentSurgeonPass,
  completionGuards: ReturnType<typeof createSurgeonCompletionGuardState>,
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  },
  completionState: SurgeonToolCompletionState,
): string {
  if (pass === "retirement") {
    const progress = completionGuards.retirement.snapshot();
    return JSON.stringify({
      completed: completionState.isComplete,
      actionsTaken: actionMetrics.actionsTaken,
      entriesRetired: actionMetrics.entriesRetired,
      reviewedEntryCount: progress.reviewedEntryCount,
      actionableMaxWindowEnd: progress.actionable.maxWindowEnd,
      actionableTotalCount: progress.actionable.totalCount,
      actionableExhausted: progress.actionable.sawExhaustedPage,
      actionableNextOffset: progress.actionable.nextOffset,
      allMaxWindowEnd: progress.all.maxWindowEnd,
      allTotalCount: progress.all.totalCount,
      allExhausted: progress.all.sawExhaustedPage,
      allNextOffset: progress.all.nextOffset,
    });
  }

  const progress = completionGuards.supersession.snapshot();
  return JSON.stringify({
    completed: completionState.isComplete,
    actionsTaken: actionMetrics.actionsTaken,
    claimKeyClustersViewed: progress.claimKeyClustersViewed,
    claimKeyClustersRemaining: progress.claimKeyClustersRemaining,
    claimKeyClustersAdjudicated: progress.claimKeyClustersAdjudicated,
    claimKeyScopeExhausted: progress.claimKeyScopeExhausted,
    subjectClustersViewed: progress.subjectClustersViewed,
    subjectClustersRemaining: progress.subjectClustersRemaining,
    subjectClustersAdjudicated: progress.subjectClustersAdjudicated,
    subjectScopeExhausted: progress.subjectScopeExhausted,
    widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted,
  });
}

/**
 * Summarizes same-run progress for continuation prompts so later slices do not
 * rely on the model remembering prior adjudications.
 *
 * @param pass - Surgeon pass being continued.
 * @param completionGuards - Mutable completion-guard state for the run.
 * @param actionMetrics - Persisted non-skip action counters for the run.
 * @returns Short progress reminder for the next bounded slice.
 */
function buildContinuationProgressReminder(
  pass: AgentSurgeonPass,
  completionGuards: ReturnType<typeof createSurgeonCompletionGuardState>,
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  },
): string {
  if (pass === "retirement") {
    const progress = completionGuards.retirement.snapshot();
    const actionableStatus =
      progress.actionable.sawExhaustedPage || progress.actionable.nextOffset === null ? "exhausted" : `next offset ${progress.actionable.nextOffset}`;
    const allStatus =
      progress.all.maxWindowEnd === 0
        ? "not started"
        : progress.all.sawExhaustedPage || progress.all.nextOffset === null
          ? "exhausted"
          : `next offset ${progress.all.nextOffset}`;
    return (
      `Persisted actions so far: ${actionMetrics.actionsTaken} (${actionMetrics.entriesRetired} retired). ` +
      `Unique reviewed candidates so far: ${progress.reviewedEntryCount}. ` +
      `Actionable scope explored through ${progress.actionable.maxWindowEnd} candidates (${actionableStatus}). ` +
      `All-scope explored through ${progress.all.maxWindowEnd} candidates (${allStatus}). ` +
      "Candidates skipped or updated earlier in this run are suppressed from later candidate queries."
    );
  }

  const progress = completionGuards.supersession.snapshot();
  return `Persisted actions so far: ${actionMetrics.actionsTaken}. Already adjudicated claim_key clusters: ${progress.claimKeyClustersAdjudicated}/${progress.claimKeyClustersTotal} (${progress.claimKeyClustersRemaining} remaining). Already adjudicated subject clusters: ${progress.subjectClustersAdjudicated}/${progress.subjectClustersTotal} (${progress.subjectClustersRemaining} remaining). Same-run adjudicated clusters are suppressed from later supersession queries.`;
}

/**
 * Loads pass-specific counts needed for startup prompts and completion guards.
 *
 * @param pass - Surgeon pass being executed.
 * @param port - Persistence boundary used to load candidate counts.
 * @param protection - Retirement protection configuration for health queries.
 * @returns Pass-specific candidate counts known before the first model turn.
 */
async function loadPassStartContext(
  pass: ImplementedSurgeonPass,
  port: SurgeonPort,
  protection: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays: number;
    now: Date;
  },
): Promise<SurgeonPassStartContext> {
  if (pass === "supersession") {
    const [claimKeyClusters, subjectClusters] = await Promise.all([
      port.listSupersessionCandidates({
        scope: "claim_key",
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        now: protection.now,
      }),
      port.listSupersessionCandidates({
        scope: "subject",
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        now: protection.now,
      }),
    ]);

    return {
      retirementRawActionableCandidates: 0,
      retirementAvailableActionableCandidates: 0,
      retirementAvailableAllCandidates: 0,
      retirementRecentlyEvaluatedCandidates: 0,
      supersessionClaimKeyClusters: claimKeyClusters.length,
      supersessionSubjectClusters: subjectClusters.length,
    };
  }

  if (pass === "retirement") {
    const retirementCandidateResult = await port.countRetirementCandidates({
      protectRecalledDays: protection.protectRecalledDays,
      protectMinImportance: protection.protectMinImportance,
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: protection.now,
    });

    return {
      retirementRawActionableCandidates: retirementCandidateResult.rawActionableCount,
      retirementAvailableActionableCandidates: retirementCandidateResult.availableActionableCount,
      retirementAvailableAllCandidates: retirementCandidateResult.availableAllCount,
      retirementRecentlyEvaluatedCandidates: retirementCandidateResult.recentlyEvaluatedFilteredCount,
      supersessionClaimKeyClusters: 0,
      supersessionSubjectClusters: 0,
    };
  }

  return {
    retirementRawActionableCandidates: 0,
    retirementAvailableActionableCandidates: 0,
    retirementAvailableAllCandidates: 0,
    retirementRecentlyEvaluatedCandidates: 0,
    supersessionClaimKeyClusters: 0,
    supersessionSubjectClusters: 0,
  };
}

/**
 * Loads the current direct-work counts used by autonomous surgeon runs.
 *
 * @param port - Persistence boundary used to load candidate counts.
 * @param protection - Retirement protection configuration for health queries.
 * @returns Current direct-work counts keyed by pass.
 */
async function loadAutonomousCycleWork(
  port: SurgeonPort,
  protection: {
    includeClaimKeyQuality: boolean;
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays: number;
    now: Date;
  },
): Promise<Record<ImplementedSurgeonPass, number>> {
  const [claimKeyEntries, health, supersessionContext, retirementContext] = await Promise.all([
    protection.includeClaimKeyQuality
      ? port.listClaimKeyQualityEntries({
          includeInactive: true,
        })
      : Promise.resolve([]),
    port.getHealthStats({
      protectRecalledDays: protection.protectRecalledDays,
      protectMinImportance: protection.protectMinImportance,
      skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
      now: protection.now,
    }),
    loadPassStartContext("supersession", port, protection),
    loadPassStartContext("retirement", port, protection),
  ]);

  return {
    claim_key_quality: claimKeyEntries.length,
    proposal_resolution: health.eligibleProposalBacklogCount,
    supersession: supersessionContext.supersessionClaimKeyClusters + supersessionContext.supersessionSubjectClusters,
    retirement: retirementContext.retirementAvailableActionableCandidates,
  };
}

/**
 * Checks whether any autonomous pass still has direct work remaining.
 *
 * @param cycleWork - Current direct-work counts keyed by pass.
 * @returns True when at least one pass still has work remaining.
 */
function hasAutonomousWork(cycleWork: Record<ImplementedSurgeonPass, number>): boolean {
  return Object.values(cycleWork).some((count) => count > 0);
}

/**
 * Normalizes cycle work into the set of passes that can repeat on later autonomous cycles.
 *
 * @param cycleWork - Direct-work counts observed at the start of the current cycle.
 * @param includeClaimKeyQuality - Whether this cycle included the one-time claim-key pass.
 * @returns Comparable direct-work counts for repeatable later cycles.
 */
function normalizeRepeatableAutonomousCycleWork(
  cycleWork: Record<ImplementedSurgeonPass, number>,
  includeClaimKeyQuality: boolean,
): Record<ImplementedSurgeonPass, number> {
  if (!includeClaimKeyQuality) {
    return cycleWork;
  }

  return {
    ...cycleWork,
    claim_key_quality: 0,
  };
}

/**
 * Builds a stable fingerprint for the autonomous direct-work scheduler.
 *
 * @param cycleWork - Direct-work counts keyed by implemented pass.
 * @returns Serialized fingerprint suitable for equality checks.
 */
function autonomousCycleWorkFingerprint(cycleWork: Record<ImplementedSurgeonPass, number>): string {
  return JSON.stringify(cycleWork);
}

/**
 * Selects the next autonomous pass that still has work and has not already run
 * in the current cycle.
 *
 * @param input - Canonical pass order plus current work counts.
 * @returns The next pass to execute, or null when the cycle is exhausted.
 */
function findNextAutonomousPass(input: {
  autonomousSequence: ImplementedSurgeonPass[];
  cycleWork: Record<ImplementedSurgeonPass, number>;
  executedPasses: ReadonlySet<ImplementedSurgeonPass>;
}): ImplementedSurgeonPass | null {
  for (const pass of input.autonomousSequence) {
    if (input.executedPasses.has(pass)) {
      continue;
    }
    if (input.cycleWork[pass] > 0) {
      return pass;
    }
  }

  return null;
}

/**
 * Checks whether one autonomous cycle changed the direct-work surface enough to
 * justify another cycle.
 *
 * Equal work counts mean no visible scheduling progress. In apply mode, direct
 * mutations still count as progress because they can replace one candidate with
 * another while keeping counts flat.
 *
 * @param input - Completed cycle results plus before/after work snapshots.
 * @returns True when the cycle made direct progress.
 */
function autonomousCycleMadeDirectProgress(input: {
  apply: boolean;
  cycleResults: SurgeonRunResult[];
  cycleWorkBefore: Record<ImplementedSurgeonPass, number>;
  cycleWorkAfter: Record<ImplementedSurgeonPass, number>;
}): boolean {
  if (autonomousCycleWorkFingerprint(input.cycleWorkBefore) !== autonomousCycleWorkFingerprint(input.cycleWorkAfter)) {
    return true;
  }

  if (!input.apply) {
    return false;
  }

  return input.cycleResults.some(
    (result) => result.actionsTaken > 0 || result.entriesRetired > 0 || (result.actionsSkipped ?? 0) > 0 || (result.reviewedEntries ?? 0) > 0,
  );
}

/**
 * Detects the narrow supersession case where the cycle finished cleanly, but
 * the remaining work surface is unchanged because the only leftovers were
 * intentionally skipped non-actionable clusters.
 *
 * @param input - Completed cycle results plus before/after work snapshots.
 * @returns True when the autonomous run should stop cleanly instead of stalling.
 */
function shouldStopAfterNonActionableSupersessionCycle(input: {
  cycleResults: SurgeonRunResult[];
  cycleWorkBefore: Record<ImplementedSurgeonPass, number>;
  cycleWorkAfter: Record<ImplementedSurgeonPass, number>;
}): boolean {
  if (
    input.cycleWorkBefore.claim_key_quality > 0 ||
    input.cycleWorkBefore.proposal_resolution > 0 ||
    input.cycleWorkBefore.retirement > 0 ||
    input.cycleWorkAfter.claim_key_quality > 0 ||
    input.cycleWorkAfter.proposal_resolution > 0 ||
    input.cycleWorkAfter.retirement > 0
  ) {
    return false;
  }

  if (input.cycleWorkBefore.supersession <= 0 || input.cycleWorkAfter.supersession !== input.cycleWorkBefore.supersession) {
    return false;
  }

  const supersessionResult = [...input.cycleResults].reverse().find((result) => result.passType === "supersession");
  if (!supersessionResult || supersessionResult.status !== "completed" || supersessionResult.actionsTaken > 0 || supersessionResult.entriesRetired > 0) {
    return false;
  }

  return true;
}

/**
 * Detects the narrow tail case where retirement is the only remaining pass and
 * another autonomous cycle would likely spend budget without changing the
 * candidate surface.
 *
 * @param input - Pass result plus before/after work snapshots.
 * @returns True when the autonomous run should stop instead of repeating retirement.
 */
async function shouldStopAfterLowYieldRetirementPass(input: {
  result: SurgeonRunResult;
  cycleWorkBefore: Record<ImplementedSurgeonPass, number>;
  cycleWorkAfter: Record<ImplementedSurgeonPass, number>;
  retirementContextBefore: SurgeonPassStartContext;
  port: SurgeonPort;
  protection: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays: number;
    now: Date;
  };
}): Promise<"completed" | "stalled" | null> {
  if (input.result.status !== "completed" || input.result.actionsTaken > 0 || input.result.entriesRetired > 0) {
    return null;
  }

  if (
    input.cycleWorkAfter.claim_key_quality > 0 ||
    input.cycleWorkAfter.proposal_resolution > 0 ||
    input.cycleWorkAfter.supersession > 0 ||
    input.cycleWorkAfter.retirement <= 0
  ) {
    return null;
  }

  if (input.cycleWorkBefore.claim_key_quality > 0 || input.cycleWorkBefore.proposal_resolution > 0 || input.cycleWorkBefore.supersession > 0) {
    return null;
  }

  const retirementContextAfter = await loadPassStartContext("retirement", input.port, input.protection);
  const candidateSurfaceUnchanged =
    retirementContextAfter.retirementAvailableActionableCandidates === input.retirementContextBefore.retirementAvailableActionableCandidates &&
    retirementContextAfter.retirementAvailableAllCandidates === input.retirementContextBefore.retirementAvailableAllCandidates;
  if (!candidateSurfaceUnchanged) {
    return null;
  }

  return (input.result.actionsSkipped ?? 0) > 0 || (input.result.reviewedEntries ?? 0) > 0 ? "completed" : "stalled";
}

/**
 * Selects the pass-specific prompt block.
 *
 * @param pass - Surgeon pass being executed.
 * @returns Prompt text for the requested pass.
 */
function getPassPrompt(pass: ImplementedSurgeonPass): string {
  if (pass === "claim_key_quality") {
    return getSurgeonClaimKeyQualityPassPrompt();
  }

  return pass === "supersession" ? getSurgeonSupersessionPassPrompt() : getSurgeonRetirementPassPrompt();
}

/**
 * Selects the tool set for the requested surgeon pass.
 *
 * @param pass - Surgeon pass being executed.
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Ordered tool set for the active pass.
 */
function createToolsForPass(pass: Extract<SurgeonPassType, "retirement" | "supersession">, deps: Parameters<typeof createSurgeonTools>[0]) {
  return pass === "supersession" ? createSupersessionTools(deps) : createSurgeonTools(deps);
}

/**
 * Filters agent messages down to the role types understood by the LLM.
 *
 * @param messages - Mixed agent messages.
 * @returns Only the user, assistant, and tool-result messages.
 */
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      (message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
  );
}

/**
 * Creates the mutable completion marker shared with surgeon tools.
 *
 * @returns Completion state holder for one run.
 */
function createCompletionState(): SurgeonToolCompletionState {
  return {
    isComplete: false,
    summary: null,
    setComplete(summary: SurgeonCompletionSummary): void {
      this.isComplete = true;
      this.summary = summary;
    },
  };
}

/**
 * Describes why a stalled run is still meaningful when it already persisted work.
 *
 * @param pass - Surgeon pass that stalled.
 * @param actionMetrics - Persisted non-skip action counters for the run.
 * @returns Short stalled-run summary.
 */
function buildStalledRunSummary(
  pass: AgentSurgeonPass | ImplementedSurgeonPass,
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  },
): string {
  if (actionMetrics.actionsTaken > 0) {
    if (pass === "retirement") {
      return `The ${pass} pass stalled after persisting ${actionMetrics.actionsTaken} non-skip action${actionMetrics.actionsTaken === 1 ? "" : "s"}, including ${actionMetrics.entriesRetired} retirement${actionMetrics.entriesRetired === 1 ? "" : "s"}.`;
    }

    return `The ${pass} pass stalled after persisting ${actionMetrics.actionsTaken} non-skip action${actionMetrics.actionsTaken === 1 ? "" : "s"}.`;
  }

  return `The ${pass} pass stalled without persisting any non-skip actions.`;
}

/**
 * Writes the final run row and returns the public result object.
 *
 * @param input - Finalized run state.
 * @returns Public run result.
 */
async function finalizeRun(input: {
  runId: string;
  status: SurgeonRunStatus;
  passType: ImplementedSurgeonPass;
  completionState: SurgeonToolCompletionState;
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  };
  budgetTracker?: ReturnType<typeof createBudgetTracker>;
  usageTotals?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  error: string | null;
  summaryOverride?: string;
  reviewedEntries?: number;
  port: SurgeonPort;
  now: () => Date;
}): Promise<SurgeonRunResult> {
  const trackerTotals = input.budgetTracker?.totals();
  const totals = {
    inputTokens: input.usageTotals?.inputTokens ?? trackerTotals?.inputTokens ?? 0,
    outputTokens: input.usageTotals?.outputTokens ?? trackerTotals?.outputTokens ?? 0,
    costUsd: input.usageTotals?.estimatedCostUsd ?? trackerTotals?.costUsd ?? 0,
  };
  const completionSummary = reconcileCompletionSummary(input.completionState.summary, input.actionMetrics);
  const summary = input.summaryOverride ?? summarizeCompletion(completionSummary);
  const actualActionsTaken = input.actionMetrics.actionsTaken;
  const actionsSkipped = completionSummary?.entries_skipped.length ?? 0;

  await input.port.completeRun(input.runId, {
    status: input.status,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedCostUsd: totals.costUsd,
    actionsTaken: actualActionsTaken,
    actionsSkipped,
    entriesRetired: input.actionMetrics.entriesRetired,
    summaryJson: completionSummary,
    error: input.error,
    completedAt: input.now().toISOString(),
  });

  return {
    runId: input.runId,
    status: input.status,
    passType: input.passType,
    actionsTaken: actualActionsTaken,
    actionsSkipped,
    entriesRetired: input.actionMetrics.entriesRetired,
    reviewedEntries: input.reviewedEntries,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedCostUsd: totals.costUsd,
    summary,
    completionSummary,
  };
}

/**
 * Builds the aggregate public result returned by autonomous surgeon runs.
 *
 * @param input - Finalized autonomous run state.
 * @returns Public autonomous run result.
 */
function finalizeAutonomousRun(input: {
  cyclesCompleted: number;
  passes: SurgeonRunResult[];
  status: SurgeonRunStatus;
  summaryOverride?: string | null;
}): SurgeonAutonomousRunResult {
  return {
    cyclesCompleted: input.cyclesCompleted,
    passes: input.passes,
    status: input.status,
    actionsTaken: input.passes.reduce((sum, pass) => sum + pass.actionsTaken, 0),
    entriesRetired: input.passes.reduce((sum, pass) => sum + pass.entriesRetired, 0),
    inputTokens: input.passes.reduce((sum, pass) => sum + pass.inputTokens, 0),
    outputTokens: input.passes.reduce((sum, pass) => sum + pass.outputTokens, 0),
    estimatedCostUsd: input.passes.reduce((sum, pass) => sum + pass.estimatedCostUsd, 0),
    summary: input.summaryOverride ?? buildAutonomousSummary(input.passes),
  };
}

/**
 * Collapses per-pass summaries into one autonomous run summary string.
 *
 * @param passes - Completed pass results for one autonomous run.
 * @returns Joined summary text, or null when none was produced.
 */
function buildAutonomousSummary(passes: SurgeonRunResult[]): string | null {
  const sections = passes.map((pass) => buildAutonomousSummarySection(pass)).filter((value): value is string => value !== null && value.length > 0);
  return sections.length > 0 ? sections.join("\n") : null;
}

/**
 * Formats one pass summary as a labeled multiline block for autonomous output.
 *
 * @param pass - Completed pass result.
 * @returns Summary block, or null when the pass has nothing meaningful to show.
 */
function buildAutonomousSummarySection(pass: SurgeonRunResult): string | null {
  const lines = pass.completionSummary?.observations.length ? pass.completionSummary.observations : splitSummaryText(pass.summary);
  if (lines.length === 0) {
    return null;
  }
  return [`${pass.passType}:`, ...lines.map((line) => `- ${line}`)].join("\n");
}

/**
 * Splits a freeform summary paragraph into readable lines for CLI rendering.
 *
 * @param summary - Freeform summary text.
 * @returns Trimmed summary lines.
 */
function splitSummaryText(summary: string | null): string[] {
  if (!summary) {
    return [];
  }
  return summary
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[a-z0-9)])\.\s+(?=[A-Z0-9])/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Reconciles model-reported completion counts with the actions actually persisted.
 *
 * @param summary - Model-reported completion summary.
 * @param actionMetrics - Persisted action counters gathered during the run.
 * @returns Normalized completion summary aligned with persisted work.
 */
function reconcileCompletionSummary(
  summary: SurgeonCompletionSummary | null,
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  },
): SurgeonCompletionSummary | null {
  if (!summary) {
    return null;
  }
  if (summary.actions_taken === actionMetrics.actionsTaken) {
    return summary;
  }
  const observations =
    actionMetrics.actionsTaken > 0
      ? [`Persisted ${actionMetrics.actionsTaken} non-skip action${actionMetrics.actionsTaken === 1 ? "" : "s"} earlier in this pass.`, ...summary.observations]
      : [...summary.observations];
  return {
    ...summary,
    actions_taken: actionMetrics.actionsTaken,
    entries_skipped: [...summary.entries_skipped],
    observations,
    recommendations: [...summary.recommendations],
    ...(summary.claim_key_quality ? { claim_key_quality: summary.claim_key_quality } : {}),
  };
}

/**
 * Summarizes the structured completion payload into a short text string.
 *
 * @param summary - Structured completion summary from `complete_pass`.
 * @returns Human-readable observations text when available.
 */
function summarizeCompletion(summary: SurgeonCompletionSummary | null): string | null {
  if (!summary) {
    return null;
  }

  if (summary.observations.length > 0) {
    return summary.observations.join(" ");
  }

  if (summary.recommendations.length > 0) {
    return summary.recommendations.join(" ");
  }

  return null;
}

/**
 * Registers one assistant usage payload once per assistant message.
 *
 * @param message - Assistant message whose usage should be counted.
 * @param usageSeen - Stable key set for already-counted assistant messages.
 * @param budgetTracker - Run-local budget tracker.
 */
function registerUsage(message: AssistantMessage, usageSeen: Set<string>, budgetTracker: ReturnType<typeof createBudgetTracker>): void {
  const key = assistantUsageKey(message);
  if (usageSeen.has(key)) {
    return;
  }

  const usage = (message as { usage?: Usage }).usage;
  if (!usage) {
    return;
  }

  usageSeen.add(key);
  budgetTracker.addUsage(usage);
}

/**
 * Builds a stable dedupe key for assistant usage accounting.
 *
 * @param message - Assistant message to fingerprint.
 * @returns Stable in-memory usage key.
 */
function assistantUsageKey(message: AssistantMessage): string {
  const contentKey = message.content
    .map((block) => {
      if (block.type === "text") {
        return `text:${block.text.slice(0, 64)}`;
      }

      if (block.type === "toolCall") {
        return `tool:${block.id}:${block.name}`;
      }

      return block.type;
    })
    .join("|");

  return `${message.timestamp}:${contentKey}`;
}

/**
 * Maps a tool name to the surgeon action type stored in the audit log.
 *
 * @param toolName - Tool name emitted by the agent loop.
 * @returns Stored action type, or undefined when the tool is not audited.
 */
function toolNameToActionType(toolName: string): Extract<SurgeonRunAction["actionType"], "retire" | "update_entry"> | undefined {
  if (toolName === "retire_entry") {
    return "retire";
  }

  if (toolName === "update_entry") {
    return "update_entry";
  }

  return undefined;
}

/**
 * Returns whether the tool result represents a meaningful audited action.
 *
 * @param actionType - Candidate action type derived from the tool name.
 * @param details - Raw tool result details payload.
 * @returns True when the tool result should be written to the action log.
 */
function shouldAuditAction(actionType: "retire" | "update_entry", details: unknown): boolean {
  const record = asRecord(details);
  if (record.success !== true) {
    return false;
  }

  if (actionType === "retire") {
    return record.retired === true || normalizeNonNegativeInteger(record.retiredCount) === 1;
  }

  return record.updated === true;
}

/**
 * Extracts a single-entry ID list from validated tool arguments.
 *
 * @param args - Validated tool arguments.
 * @returns Entry IDs referenced by the tool call.
 */
function extractEntryIds(args: unknown): string[] {
  const entryId = asRecord(args).entry_id;
  return typeof entryId === "string" && entryId.trim().length > 0 ? [entryId.trim()] : [];
}

/**
 * Extracts audit reasoning from the assistant text and tool payloads.
 *
 * @param assistantMessage - Assistant message that requested the tool call.
 * @param args - Validated tool arguments.
 * @param details - Tool result details.
 * @param toolName - Tool name used for fallback text.
 * @returns Reasoning string stored with the action log.
 */
function extractActionReasoning(assistantMessage: AssistantMessage, args: unknown, details: unknown, toolName: string): string {
  const assistantReasoning = extractAssistantReasoning(assistantMessage);
  if (assistantReasoning.length > 0) {
    return assistantReasoning;
  }

  const argRecord = asRecord(args);
  const detailRecord = asRecord(details);
  const argReason = typeof argRecord.reasoning === "string" ? argRecord.reasoning.trim() : typeof argRecord.reason === "string" ? argRecord.reason.trim() : "";
  if (argReason.length > 0) {
    return argReason;
  }

  const detailReason = typeof detailRecord.reason === "string" ? detailRecord.reason.trim() : "";
  if (detailReason.length > 0) {
    return detailReason;
  }

  return `Executed ${toolName}.`;
}

/**
 * Concatenates assistant text blocks into one reasoning string.
 *
 * @param message - Assistant message from the agent loop.
 * @returns Joined assistant text content.
 */
function extractAssistantReasoning(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter((block) => block.length > 0)
    .join("\n")
    .trim();
}

/**
 * Formats the last run for prompt display.
 *
 * @param run - Optional persisted last-run metadata.
 * @returns Human-readable last-run summary or `none`.
 */
function formatLastRun(
  run: {
    passType: string;
    status: string;
    startedAt: string;
    dryRun: boolean;
  } | null,
): string {
  if (!run) {
    return "none";
  }

  return `${run.passType} ${run.status} (${run.dryRun ? "dry-run" : "apply"}) at ${run.startedAt}`;
}

/**
 * Narrows an unknown agent message to an assistant message.
 *
 * @param message - Agent message emitted by the loop.
 * @returns True when the message is an assistant message.
 */
function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Unknown value to inspect.
 * @returns Plain object record or an empty object fallback.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/**
 * Formats a USD amount with four fractional digits.
 *
 * @param value - Numeric USD amount.
 * @returns Currency string.
 */
function formatUsd(value: number): string {
  return `$${Math.max(0, value).toFixed(4)}`;
}

/**
 * Normalizes an optional positive integer.
 *
 * @param value - Raw numeric value.
 * @returns Integer when valid, otherwise undefined.
 */
function normalizePositiveInteger(value: unknown): number | undefined {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return undefined;
  }

  return Math.floor(value as number);
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

/**
 * Normalizes an optional positive number.
 *
 * @param value - Raw numeric value.
 * @returns Number when valid, otherwise undefined.
 */
function normalizePositiveNumber(value: unknown): number | undefined {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    return undefined;
  }

  return value as number;
}

/**
 * Normalizes an optional non-negative number.
 *
 * @param value - Raw numeric value.
 * @returns Number when valid, otherwise undefined.
 */
function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (!Number.isFinite(value) || (value as number) < 0) {
    return undefined;
  }

  return value as number;
}
