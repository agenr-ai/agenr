import { randomUUID } from "node:crypto";

import { runAgentLoop, type AfterToolCallContext, type AgentEvent, type AgentMessage, type BeforeToolCallContext } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@mariozechner/pi-ai";

import type { SqlDatabase } from "../../adapters/db/client.js";
import { completeSurgeonRun, createSurgeonRun, getDailySurgeonCost, getLastSurgeonRun, logSurgeonAction } from "../../adapters/db/surgeon-run-log.js";
import { countRetirementCandidates, getSurgeonHealthStats } from "../../adapters/db/surgeon-queries.js";
import { getSurgeonRetirementPassPrompt, getSurgeonSystemPrompt } from "../../adapters/surgeon/prompts.js";
import { createTraceLogger, type SurgeonTraceLogger } from "../../adapters/surgeon/trace-logger.js";
import { createSurgeonTools, type SurgeonToolCompletionState } from "../../adapters/surgeon/tools/index.js";
import {
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  type AgenrConfig,
} from "../../config.js";
import type { RecallPorts } from "../../core/ports.js";
import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import type { SurgeonCompletionSummary, SurgeonRunStatus } from "../../core/surgeon/types.js";
import { createBudgetTracker } from "./budget.js";
import { createSurgeonCompletionGuardState } from "./completion-guard.js";

/**
 * Safety valve for continuation prompts. Prevents infinite loops when the
 * model repeatedly stops without completing. This is a last resort — the
 * primary constraints are budget and candidate exhaustion.
 */
const MAX_CONTINUATION_ATTEMPTS = 50;
const USER_ABORT_ERROR = "Run aborted by user (SIGINT).";
const USER_ABORT_SUMMARY = "Run aborted by user.";

/**
 * CLI and runtime options accepted by one surgeon run.
 */
export interface SurgeonRunOptions {
  pass: "retirement";
  project?: string;
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
}

/**
 * Persisted summary returned after a surgeon run completes or fails.
 */
export interface SurgeonRunResult {
  runId: string;
  status: SurgeonRunStatus;
  passType: string;
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
  db: SqlDatabase;
  dbPath?: string;
  config: AgenrConfig | null;
  model: Model<Api>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  recallPorts?: RecallPorts;
  now?: () => Date;
  backupDb?: (dbPath: string) => Promise<string>;
}

/**
 * Runs the retirement-only surgeon agent loop and persists the run lifecycle.
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

  const dailyCost = dailyCostCap > 0 ? await getDailySurgeonCost(deps.db, nowFn()) : 0;
  if (dailyCostCap > 0 && dailyCost >= dailyCostCap) {
    throw new Error(`Surgeon daily cost cap exceeded. Cost in the last 24 hours is ${formatUsd(dailyCost)} and the cap is ${formatUsd(dailyCostCap)}.`);
  }

  const systemPrompt = buildSystemPrompt(deps.config);

  if (options.apply && deps.dbPath && deps.dbPath !== ":memory:" && deps.backupDb) {
    await deps.backupDb(deps.dbPath);
  }

  const runId = await createSurgeonRun(deps.db, {
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

  const budgetTracker = createBudgetTracker({
    contextLimit,
    costCapUsd: runCostCap,
  });
  const completionState = createCompletionState();
  const actionMetrics = {
    actionsTaken: 0,
    entriesRetired: 0,
  };
  const usageSeen = new Set<string>();
  let continuationAttempts = 0;
  let terminalStatus: SurgeonRunStatus | null = null;
  let terminalError: string | null = null;
  let traceLogger: SurgeonTraceLogger | null = null;

  try {
    const [health, retirementCandidateResult, lastRun] = await Promise.all([
      getSurgeonHealthStats(deps.db, {
        protectRecalledDays: protection.protectRecalledDays,
        protectMinImportance: protection.protectMinImportance,
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        now: nowFn(),
      }),
      countRetirementCandidates(deps.db, {
        protectRecalledDays: protection.protectRecalledDays,
        protectMinImportance: protection.protectMinImportance,
        skipRecentlyEvaluatedDays: protection.skipRecentlyEvaluatedDays,
        now: nowFn(),
      }),
      getLastSurgeonRun(deps.db),
    ]);

    const retirementCandidates = retirementCandidateResult.total;
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: health.total,
      retirementCandidates,
    });
    traceLogger = createTraceLogger({
      verbose: options.verbose,
      tracePath: options.tracePath,
      budgetTracker,
    });

    const tools = createSurgeonTools({
      executor: deps.db,
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
        await logSurgeonAction(deps.db, action);
        traceLogger?.logAction(action);
      },
      completionState,
      budgetTracker,
      costCap: runCostCap,
      completionGuards,
      recallPorts: deps.recallPorts,
    });

    const initialPrompt = buildInitialUserPrompt({
      project: options.project,
      totalEntries: health.total,
      retirementCandidates,
      lastRun,
      costCapUsd: runCostCap,
      contextLimit,
    });

    await runAgentLoop(
      [
        {
          role: "user",
          content: initialPrompt,
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
        getFollowUpMessages: async () => {
          if (
            completionState.isComplete ||
            signal?.aborted === true ||
            budgetTracker.isExhausted() ||
            budgetTracker.isCostCapExceeded() ||
            continuationAttempts >= MAX_CONTINUATION_ATTEMPTS
          ) {
            return [];
          }

          continuationAttempts += 1;
          const remaining = budgetTracker.remaining();

          return [
            {
              role: "user",
              content: buildContinuationPrompt({
                currentContextTokens: remaining.currentContextTokens,
                contextLimit: remaining.contextLimit,
                remainingCostUsd: remaining.remainingCostUsd,
                attempt: continuationAttempts,
              }),
              timestamp: Date.now(),
            },
          ];
        },
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

            await logSurgeonAction(deps.db, action);
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

    if (signal?.aborted === true) {
      terminalStatus = terminalStatus ?? "aborted";
      terminalError = terminalError ?? USER_ABORT_ERROR;
      return finalizeRun({
        runId,
        status: "aborted",
        completionState,
        actionMetrics,
        budgetTracker,
        error: terminalError,
        summaryOverride: USER_ABORT_SUMMARY,
        db: deps.db,
        now: nowFn,
      });
    }

    const finalStatus = completionState.summary
      ? terminalStatus && terminalStatus !== "failed"
        ? terminalStatus
        : "completed"
      : (terminalStatus ?? "completed");

    return finalizeRun({
      runId,
      status: finalStatus,
      completionState,
      actionMetrics,
      budgetTracker,
      error: terminalError,
      db: deps.db,
      now: nowFn,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      terminalStatus = terminalStatus ?? "aborted";
      terminalError = terminalError ?? USER_ABORT_ERROR;
      return finalizeRun({
        runId,
        status: "aborted",
        completionState,
        actionMetrics,
        budgetTracker,
        error: terminalError,
        summaryOverride: USER_ABORT_SUMMARY,
        db: deps.db,
        now: nowFn,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return finalizeRun({
      runId,
      status: terminalStatus ?? "failed",
      completionState,
      actionMetrics,
      budgetTracker,
      error: terminalError ?? message,
      db: deps.db,
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
function resolveRunCostCap(options: SurgeonRunOptions, config: AgenrConfig | null): number {
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
  options: SurgeonRunOptions,
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
 * Joins the shared and pass-specific prompt blocks into one system prompt.
 *
 * @param config - Optional persisted agenr configuration.
 * @returns Full system prompt text for the run.
 */
function buildSystemPrompt(config: AgenrConfig | null): string {
  return [getSurgeonSystemPrompt().trim(), getSurgeonRetirementPassPrompt().trim(), config?.surgeon?.customInstructions?.trim() ?? ""]
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
  project?: string;
  totalEntries: number;
  retirementCandidates: number;
  lastRun: {
    passType: string;
    status: string;
    startedAt: string;
    dryRun: boolean;
  } | null;
  costCapUsd: number;
  contextLimit: number;
}): string {
  const lines = [
    "Begin retirement pass.",
    `Project scope: ${input.project?.trim() || "all projects"}.`,
    `Entries: ${input.totalEntries}.`,
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
 * Builds the continuation prompt injected when the model stops early.
 *
 * @param input - Remaining budget snapshot and continuation attempt count.
 * @returns Follow-up prompt that tells the model to continue the pass.
 */
function buildContinuationPrompt(input: { currentContextTokens: number; contextLimit: number; remainingCostUsd: number; attempt: number }): string {
  const lines = [
    input.contextLimit > 0
      ? `You stopped without calling complete_pass and the latest turn used ${input.currentContextTokens}/${input.contextLimit} context tokens, with about ${formatUsd(input.remainingCostUsd)} of run budget remaining.`
      : `You stopped without calling complete_pass and still have about ${formatUsd(input.remainingCostUsd)} of run budget remaining. The latest turn context size was ${input.currentContextTokens} tokens.`,
    "Continue the retirement pass.",
    "Keep paginating candidates. If the actionable scope is exhausted and meaningful budget remains, widen to scope = 'all'.",
    "Do not call complete_pass until candidates are genuinely exhausted or budget constraints force you to stop.",
  ];

  return lines.join(" ");
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
 * Writes the final run row and returns the public result object.
 *
 * @param input - Finalized run state.
 * @returns Public run result.
 */
async function finalizeRun(input: {
  runId: string;
  status: SurgeonRunStatus;
  completionState: SurgeonToolCompletionState;
  actionMetrics: {
    actionsTaken: number;
    entriesRetired: number;
  };
  budgetTracker: ReturnType<typeof createBudgetTracker>;
  error: string | null;
  summaryOverride?: string;
  db: SqlDatabase;
  now: () => Date;
}): Promise<SurgeonRunResult> {
  const totals = input.budgetTracker.totals();
  const summary = input.summaryOverride ?? summarizeCompletion(input.completionState.summary);

  await completeSurgeonRun(input.db, input.runId, {
    status: input.status,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedCostUsd: totals.costUsd,
    actionsTaken: input.completionState.summary?.actions_taken ?? input.actionMetrics.actionsTaken,
    actionsSkipped: input.completionState.summary?.entries_skipped.length ?? 0,
    entriesRetired: input.actionMetrics.entriesRetired,
    summaryJson: input.completionState.summary,
    error: input.error,
    completedAt: input.now().toISOString(),
  });

  return {
    runId: input.runId,
    status: input.status,
    passType: "retirement",
    actionsTaken: input.completionState.summary?.actions_taken ?? input.actionMetrics.actionsTaken,
    entriesRetired: input.actionMetrics.entriesRetired,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedCostUsd: totals.costUsd,
    summary,
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
    return record.wouldRetire === true || record.retired === true || normalizeNonNegativeInteger(record.retiredCount) === 1;
  }

  return record.wouldUpdate === true || record.updated === true || hasNonEmptyRecord(record.changes);
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
 * Returns whether an unknown value is a non-empty plain record.
 *
 * @param value - Unknown value to inspect.
 * @returns True when the value is a plain record with at least one key.
 */
function hasNonEmptyRecord(value: unknown): boolean {
  return Object.keys(asRecord(value)).length > 0;
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
