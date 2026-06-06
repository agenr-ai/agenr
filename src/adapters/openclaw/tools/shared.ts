import { failedTextResult, readNumberParam, readStringArrayParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { resolveClaimSlotPolicy } from "../../../core/claim-slot-policy.js";
import { describeDurableLineageState, formatDurableClaimLifecycle, summarizeClaimFamilyTransition } from "../../../core/recall/entry-lineage.js";
import type { Durable } from "../../../core/types.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { truncate } from "../../shared/memory-tool-format.js";
import type { MemoryToolOutcome, MemoryToolParamReader } from "../../shared/memory-tools.js";
import {
  ENTRY_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  RECALL_MODES,
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  formatTargetSelector,
  normalizeStringArray,
  parseDurableKind,
  parseDurableKinds,
  parseExpiry,
  parseRecallMode,
  sanitizeUpdateToolParams,
} from "../../shared/entry-tools.js";
import { buildEntryMemoryResolverPorts, readBooleanParam, resolveTargetDurable as resolveSharedTargetDurable } from "../../shared/resolve-target.js";
import type { AgenrOpenClawServices } from "../types.js";

/** Shared OpenClaw param reader wired into host-neutral memory tool parsers. */
const OPENCLAW_PARAM_READER: MemoryToolParamReader = {
  readString: readStringParam,
  readNumber: readNumberParam,
  readStringArray: readStringArrayParam,
};

export {
  OPENCLAW_PARAM_READER,
  ENTRY_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  RECALL_MODES,
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  formatErrorMessage,
  formatTargetSelector,
  normalizeStringArray,
  parseDurableKind,
  parseDurableKinds,
  parseExpiry,
  parseRecallMode,
  readBooleanParam,
  sanitizeUpdateToolParams,
};

/**
 * Maps a host-neutral memory tool outcome into an OpenClaw tool result.
 *
 * @param outcome - Shared store/update execution result.
 * @returns OpenClaw text result payload.
 */
export function toOpenClawToolResult(outcome: MemoryToolOutcome) {
  if (outcome.failed) {
    return failedTextResult(outcome.text, {
      ...outcome.details,
      status: "failed",
    });
  }

  return textResult(outcome.text, outcome.details);
}

/**
 * Resolves exactly one tool target selector into a concrete agenr entry.
 *
 * @param services - OpenClaw service bundle used for entry lookups.
 * @param params - Raw tool parameters.
 * @param options - Optional selector controls.
 * @returns Matching agenr entry.
 */
export async function resolveTargetDurable(
  services: AgenrOpenClawServices,
  params: Record<string, unknown>,
  options: {
    allowLast?: boolean;
  } = {},
): Promise<Durable> {
  return resolveSharedTargetDurable(buildEntryMemoryResolverPorts(services), params, options);
}

/**
 * Logs one tool call summary plus sanitized parameters at info level.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param summary - Human-readable summary text.
 * @param sanitizedParams - Redacted parameter payload for logs.
 * @returns Nothing.
 */
export function logToolCall(
  logger: PluginLogger,
  toolName: string,
  ctx: OpenClawPluginToolContext,
  summary: string,
  sanitizedParams: Record<string, unknown>,
): void {
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} ${summary}`);
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} params=${JSON.stringify(sanitizedParams)}`);
}

/**
 * Logs a warning when one OpenClaw tool call fails.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param error - Unknown failure value.
 * @returns Nothing.
 */
export function logToolFailure(logger: PluginLogger, toolName: string, ctx: OpenClawPluginToolContext, error: unknown): void {
  logger.warn(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} failed: ${formatErrorMessage(error)}`);
}

/**
 * Sanitizes trace parameters before debug logging.
 *
 * @param params - Parsed trace-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeTraceToolParams(params: { id: string | undefined; subject: string | undefined; last: boolean | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.last !== undefined ? { last: params.last } : {}),
  };
}

/**
 * Formats the limited Phase 1 provenance view returned by `agenr_trace`.
 *
 * @param entry - Target entry being traced.
 * @param supersededBy - Entry that superseded the target, when present.
 * @param supersedes - Entries superseded by the target.
 * @param recallEvents - Recent recall events linked to the target.
 * @returns Human-readable trace output.
 */
export function formatTrace(
  entry: Durable,
  supersededBy: Durable | undefined,
  supersedes: Durable[],
  claimFamily: { claimKey: string; slotPolicy?: "exclusive" | "multivalued"; slotPolicyReason?: string; entries: Durable[] } | undefined,
  recallEvents: Array<{ query?: string; sessionKey?: string; recalledAt: string }>,
): string {
  const nowMs = Date.now();
  const slotPolicy = entry.claim_key
    ? claimFamily
      ? {
          policy: claimFamily.slotPolicy ?? resolveClaimSlotPolicy(claimFamily.claimKey).policy,
          reason: claimFamily.slotPolicyReason ?? resolveClaimSlotPolicy(claimFamily.claimKey).reason,
        }
      : resolveClaimSlotPolicy(entry.claim_key)
    : undefined;
  const lines = [
    `Trace for ${entry.id} | ${entry.subject}`,
    `type=${entry.type} expiry=${entry.expiry} importance=${entry.importance} memory_state=${describeDurableLineageState(entry, nowMs)}`,
    `content=${truncate(entry.content, 220)}`,
  ];

  if (supersededBy) {
    lines.push(`superseded_by=${supersededBy.id} | ${supersededBy.subject}`);
  }

  if (supersedes.length > 0) {
    lines.push(`supersedes=${supersedes.map((item) => `${item.id} (${item.subject})`).join(", ")}`);
  }

  if (entry.claim_key) {
    lines.push(`claim_key=${entry.claim_key}`);
    if (slotPolicy) {
      lines.push(`slot_policy=${slotPolicy.policy}`);
      lines.push(`slot_policy_reason=${slotPolicy.reason}`);
    }
  }

  if (claimFamily && claimFamily.entries.length > 0) {
    lines.push(
      `claim_family=${claimFamily.claimKey} | slot_policy=${slotPolicy?.policy ?? "exclusive"} | ${claimFamily.entries
        .map((item) => `${item.id}:${describeDurableLineageState(item, nowMs)}:${formatDurableClaimLifecycle(item)}`)
        .join(", ")}`,
    );
    if (slotPolicy) {
      lines.push(`claim_family_policy_reason=${slotPolicy.reason}`);
    }
    const transitionSummary = summarizeClaimFamilyTransition(claimFamily.entries, nowMs);
    if (transitionSummary) {
      lines.push(`transition=${transitionSummary}`);
    }
  }

  if (entry.valid_from || entry.valid_to) {
    lines.push(`validity=${entry.valid_from ?? "?"} -> ${entry.valid_to ?? "ongoing"}`);
  }

  if (entry.supersession_kind) {
    lines.push(`supersession_kind=${entry.supersession_kind}${entry.supersession_reason ? ` reason=${truncate(entry.supersession_reason, 120)}` : ""}`);
  }

  if (recallEvents.length > 0) {
    lines.push(
      `recent_recalls=${recallEvents
        .map((event) => `${event.recalledAt}${event.query ? ` query=${event.query}` : ""}${event.sessionKey ? ` session=${event.sessionKey}` : ""}`)
        .join(" ; ")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Wraps unexpected tool failures in the standard failed result payload.
 *
 * @param error - Unknown failure value.
 * @returns Standard failed text result payload.
 */
export function toolFailureResult(error: unknown) {
  return failedTextResult(formatErrorMessage(error), {
    status: "failed" as const,
  });
}

/**
 * Formats stable session identifiers for tool-level OpenClaw logs.
 *
 * @param ctx - Tool invocation context.
 * @returns Stable session context string for logs.
 */
function formatToolSessionContext(ctx: OpenClawPluginToolContext): string {
  const normalizedSessionId = ctx.sessionId?.trim();
  const normalizedSessionKey = ctx.sessionKey?.trim();

  if (normalizedSessionId && normalizedSessionKey) {
    return `session=${normalizedSessionId} key=${normalizedSessionKey}`;
  }

  if (normalizedSessionId) {
    return `session=${normalizedSessionId}`;
  }

  if (normalizedSessionKey) {
    return `key=${normalizedSessionKey}`;
  }

  return "session=unknown";
}
