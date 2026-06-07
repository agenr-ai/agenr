import { resolveClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import { describeDurableLineageState, formatDurableClaimLifecycle, summarizeClaimFamilyTransition } from "../../core/recall/durable-lineage.js";
import type { Durable } from "../../core/types.js";
import type { DurableTrace } from "./ports.js";

/**
 * Formats one trace payload for human-readable CLI and tool output.
 *
 * @param trace - Loaded trace payload.
 * @returns Human-readable trace output block.
 */
export function renderDurableTraceText(trace: DurableTrace): string {
  const nowMs = Date.now();
  const slotPolicy = resolveTraceSlotPolicy(trace);
  const lines = [
    `Trace for ${trace.durable.id} | ${trace.durable.subject}`,
    `type=${trace.durable.type} expiry=${trace.durable.expiry} importance=${trace.durable.importance} memory_state=${describeDurableLineageState(trace.durable, nowMs)}`,
    `recall_count=${trace.durable.recall_count}${trace.durable.last_recalled_at ? ` last_recalled_at=${trace.durable.last_recalled_at}` : ""}`,
    `content=${truncate(trace.durable.content, 220)}`,
  ];

  appendProvenanceLines(lines, trace);
  appendLineageLines(lines, trace, nowMs, slotPolicy);
  appendRecallLines(lines, trace);
  appendTimelineLines(lines, trace);

  return `${lines.join("\n")}\n`;
}

/**
 * Formats one trace payload as structured JSON for scripting and review workflows.
 *
 * @param trace - Loaded trace payload.
 * @returns Pretty-printed JSON output.
 */
export function renderDurableTraceJson(trace: DurableTrace): string {
  return `${JSON.stringify(serializeDurableTrace(trace), null, 2)}\n`;
}

/**
 * Serializes one trace payload into a structured inspection object.
 *
 * @param trace - Loaded trace payload.
 * @returns Structured trace payload for JSON surfaces.
 */
export function serializeDurableTrace(trace: DurableTrace): Record<string, unknown> {
  const nowMs = Date.now();
  const slotPolicy = resolveTraceSlotPolicy(trace);
  const transitionSummary = trace.claimFamily ? summarizeClaimFamilyTransition(trace.claimFamily.durables, nowMs) : undefined;

  return {
    durable: serializeTraceDurable(trace.durable, nowMs, slotPolicy),
    provenance: trace.provenance,
    ...(trace.supersededBy ? { supersededBy: serializeTraceDurable(trace.supersededBy, nowMs) } : {}),
    supersedes: trace.supersedes.map((entry) => serializeTraceDurable(entry, nowMs)),
    ...(trace.claimFamily
      ? {
          claimFamily: {
            claimKey: trace.claimFamily.claimKey,
            slotPolicy: slotPolicy.policy,
            slotPolicyReason: slotPolicy.reason,
            ...(transitionSummary ? { transition: transitionSummary } : {}),
            durables: trace.claimFamily.durables.map((entry) => serializeTraceDurable(entry, nowMs)),
          },
        }
      : {}),
    recall: trace.recall,
    dreamActions: trace.dreamActions,
    profileSnapshots: trace.profileSnapshots,
    timeline: trace.timeline,
  };
}

/** Appends provenance lines when source or claim metadata exists. */
function appendProvenanceLines(lines: string[], trace: DurableTrace): void {
  const provenanceEntries = Object.entries(trace.provenance).filter(([, value]) => value !== undefined && value !== "");
  if (provenanceEntries.length === 0) {
    return;
  }

  lines.push("");
  lines.push("[provenance]");
  for (const [key, value] of provenanceEntries) {
    lines.push(`${toSnakeCase(key)}=${truncate(String(value), 220)}`);
  }
}

/** Appends lineage and validity lines for one trace payload. */
function appendLineageLines(lines: string[], trace: DurableTrace, nowMs: number, slotPolicy: { policy: string; reason: string }): void {
  const lineageLines: string[] = [];

  if (trace.supersededBy) {
    lineageLines.push(`superseded_by=${trace.supersededBy.id} | ${trace.supersededBy.subject}`);
  }

  if (trace.supersedes.length > 0) {
    lineageLines.push(`supersedes=${trace.supersedes.map((entry) => `${entry.id} (${entry.subject})`).join(", ")}`);
  }

  if (trace.durable.claim_key) {
    lineageLines.push(`claim_key=${trace.durable.claim_key}`);
    lineageLines.push(`slot_policy=${slotPolicy.policy}`);
    lineageLines.push(`slot_policy_reason=${slotPolicy.reason}`);
  }

  if (trace.claimFamily && trace.claimFamily.durables.length > 0) {
    lineageLines.push(
      `claim_family=${trace.claimFamily.claimKey} | ${trace.claimFamily.durables
        .map((entry) => `${entry.id}:${describeDurableLineageState(entry, nowMs)}:${formatDurableClaimLifecycle(entry)}`)
        .join(", ")}`,
    );
    const transitionSummary = summarizeClaimFamilyTransition(trace.claimFamily.durables, nowMs);
    if (transitionSummary) {
      lineageLines.push(`transition=${transitionSummary}`);
    }
  }

  if (trace.durable.valid_from || trace.durable.valid_to) {
    lineageLines.push(`validity=${trace.durable.valid_from ?? "?"} -> ${trace.durable.valid_to ?? "ongoing"}`);
  }

  if (trace.durable.supersession_kind || trace.durable.supersession_reason) {
    lineageLines.push(
      `supersession=${trace.durable.supersession_kind ?? "unknown"}${trace.durable.supersession_reason ? ` reason=${truncate(trace.durable.supersession_reason, 120)}` : ""}`,
    );
  }

  if (lineageLines.length === 0) {
    return;
  }

  lines.push("");
  lines.push("[lineage]");
  lines.push(...lineageLines);
}

/** Appends recall summary lines for one trace payload. */
function appendRecallLines(lines: string[], trace: DurableTrace): void {
  if (trace.recall.totalCount === 0) {
    return;
  }

  lines.push("");
  lines.push(`[recall] total=${trace.recall.totalCount} showing=${trace.recall.recentEvents.length}`);
  for (const event of trace.recall.recentEvents) {
    lines.push(`- ${event.recalledAt}${event.query ? ` query=${event.query}` : ""}${event.sessionKey ? ` session=${event.sessionKey}` : ""}`);
  }
}

/** Appends chronological audit timeline lines for one trace payload. */
function appendTimelineLines(lines: string[], trace: DurableTrace): void {
  if (trace.timeline.length === 0) {
    return;
  }

  lines.push("");
  lines.push("[timeline]");
  for (const event of trace.timeline) {
    const parts = [`${event.at} ${event.label}`];
    if (event.runId) {
      parts.push(`run=${event.runId}`);
    }
    if (event.detail) {
      parts.push(truncate(event.detail, 180));
    }
    lines.push(`- ${parts.join(" | ")}`);
  }
}

/**
 * Resolves the effective trace slot policy and explanation for the target family.
 *
 * @param trace - Loaded trace payload.
 * @returns Effective slot-policy metadata for the traced family.
 */
export function resolveTraceSlotPolicy(trace: DurableTrace): { policy: string; reason: string } {
  if (trace.claimFamily) {
    const resolved = resolveClaimSlotPolicy(trace.claimFamily.claimKey);
    return {
      policy: trace.claimFamily.slotPolicy ?? resolved.policy,
      reason: trace.claimFamily.slotPolicyReason ?? resolved.reason,
    };
  }

  if (trace.durable.claim_key) {
    const resolved = resolveClaimSlotPolicy(trace.durable.claim_key);
    return {
      policy: resolved.policy,
      reason: resolved.reason,
    };
  }

  return {
    policy: "exclusive",
    reason: "No canonical claim key was available, so the slot policy defaulted to exclusive.",
  };
}

/**
 * Converts one trace entry into a structured inspection payload.
 *
 * @param entry - Entry to serialize.
 * @param nowMs - Reference instant in epoch milliseconds for lineage state.
 * @param slotPolicy - Optional slot-policy metadata when the entry has a claim key.
 * @returns Structured trace entry payload.
 */
export function serializeTraceDurable(entry: Durable, nowMs: number, slotPolicy?: { policy: string; reason: string }): Record<string, unknown> {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    type: entry.type,
    expiry: entry.expiry,
    importance: entry.importance,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    recallCount: entry.recall_count,
    ...(entry.last_recalled_at ? { lastRecalledAt: entry.last_recalled_at } : {}),
    memoryState: describeDurableLineageState(entry, nowMs),
    claimLifecycle: formatDurableClaimLifecycle(entry),
    ...(entry.claim_key ? { claimKey: entry.claim_key } : {}),
    ...(entry.claim_key && slotPolicy ? { slotPolicy: slotPolicy.policy, slotPolicyReason: slotPolicy.reason } : {}),
    ...(entry.valid_from || entry.valid_to
      ? {
          validity: {
            from: entry.valid_from ?? null,
            to: entry.valid_to ?? null,
          },
        }
      : {}),
    ...(entry.supersession_kind || entry.supersession_reason
      ? {
          supersession: {
            ...(entry.supersession_kind ? { kind: entry.supersession_kind } : {}),
            ...(entry.supersession_reason ? { reason: entry.supersession_reason } : {}),
          },
        }
      : {}),
    ...(entry.superseded_by ? { supersededById: entry.superseded_by } : {}),
  };
}

/** Truncates long output text for concise display. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

/** Converts camelCase keys into snake_case labels for text output. */
function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
