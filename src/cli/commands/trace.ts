import { Option, type Command } from "commander";

import { loadEntryTraceRuntime } from "../../app/memory/inspect.js";
import type { EntryTrace } from "../../app/memory/ports.js";
import { resolveClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { Durable } from "../../core/types.js";

/** Commander options accepted by the `agenr trace` command. */
interface TraceCommandOptions {
  id?: string;
  subject?: string;
  last?: boolean;
  json?: boolean;
}

/**
 * Registers the `agenr trace` CLI command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace")
    .description("Inspect one durable's provenance and claim-family lineage")
    .addOption(new Option("--id <id>", "Durable id to inspect"))
    .addOption(new Option("--subject <text>", "Subject text to resolve when the id is unknown"))
    .option("--last", "Inspect the most recently created durable")
    .option("--json", "Emit structured JSON output")
    .action(async (options: TraceCommandOptions) => {
      try {
        const trace = await loadEntryTraceRuntime({
          id: options.id,
          subject: options.subject,
          last: options.last === true,
          env: process.env,
        });
        process.stdout.write(options.json === true ? renderTraceJson(trace) : renderTrace(trace));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load trace: ${formatUnknownError(error)}\n`);
      }
    });
}

/**
 * Formats one trace payload for CLI inspection.
 *
 * @param trace - Loaded trace payload.
 * @returns Human-readable trace output block.
 */
function renderTrace(trace: EntryTrace): string {
  const entrySlotPolicy = resolveTraceSlotPolicy(trace);
  const lines = [
    `Trace for ${trace.entry.id} | ${trace.entry.subject}`,
    `type=${trace.entry.type} expiry=${trace.entry.expiry} importance=${trace.entry.importance} retired=${trace.entry.retired}`,
    `content=${truncate(trace.entry.content, 220)}`,
  ];

  if (trace.supersededBy) {
    lines.push(`superseded_by=${trace.supersededBy.id} | ${trace.supersededBy.subject}`);
  }

  if (trace.supersedes.length > 0) {
    lines.push(`supersedes=${trace.supersedes.map((entry) => `${entry.id} (${entry.subject})`).join(", ")}`);
  }

  if (trace.entry.claim_key) {
    lines.push(`claim_key=${trace.entry.claim_key}`);
    lines.push(`slot_policy=${entrySlotPolicy.policy}`);
    lines.push(`slot_policy_reason=${entrySlotPolicy.reason}`);
  }

  if (trace.claimFamily && trace.claimFamily.entries.length > 0) {
    lines.push(
      `claim_family=${trace.claimFamily.claimKey} | slot_policy=${entrySlotPolicy.policy} | ${trace.claimFamily.entries
        .map((entry) => `${entry.id}:${describeEntryState(entry)}:${formatClaimLifecycle(entry)}`)
        .join(", ")}`,
    );
    lines.push(`claim_family_policy_reason=${entrySlotPolicy.reason}`);
    const transitionSummary = summarizeClaimFamilyTransition(trace.claimFamily.entries);
    if (transitionSummary) {
      lines.push(`transition=${transitionSummary}`);
    }
  }

  if (trace.entry.valid_from || trace.entry.valid_to) {
    lines.push(`validity=${trace.entry.valid_from ?? "?"} -> ${trace.entry.valid_to ?? "ongoing"}`);
  }

  if (trace.entry.supersession_kind) {
    lines.push(
      `supersession_kind=${trace.entry.supersession_kind}${trace.entry.supersession_reason ? ` reason=${truncate(trace.entry.supersession_reason, 120)}` : ""}`,
    );
  }

  if (trace.recallEvents.length > 0) {
    lines.push(
      `recent_recalls=${trace.recallEvents
        .map((event) => `${event.recalledAt}${event.query ? ` query=${event.query}` : ""}${event.sessionKey ? ` session=${event.sessionKey}` : ""}`)
        .join(" ; ")}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Formats one trace payload as structured JSON for scripting and review workflows.
 *
 * @param trace - Loaded trace payload.
 * @returns Pretty-printed JSON output.
 */
function renderTraceJson(trace: EntryTrace): string {
  const slotPolicy = resolveTraceSlotPolicy(trace);
  const transitionSummary = trace.claimFamily ? summarizeClaimFamilyTransition(trace.claimFamily.entries) : undefined;

  return `${JSON.stringify(
    {
      entry: serializeTraceEntry(trace.entry, slotPolicy),
      ...(trace.supersededBy ? { supersededBy: serializeTraceEntry(trace.supersededBy) } : {}),
      supersedes: trace.supersedes.map((entry) => serializeTraceEntry(entry)),
      ...(trace.claimFamily
        ? {
            claimFamily: {
              claimKey: trace.claimFamily.claimKey,
              slotPolicy: slotPolicy.policy,
              slotPolicyReason: slotPolicy.reason,
              ...(transitionSummary ? { transition: transitionSummary } : {}),
              entries: trace.claimFamily.entries.map((entry) => serializeTraceEntry(entry)),
            },
          }
        : {}),
      recallEvents: trace.recallEvents,
    },
    null,
    2,
  )}\n`;
}

/**
 * Formats one narrow memory-state label for lineage inspection.
 *
 * @param entry - Entry to describe.
 * @returns Narrow state label.
 */
function describeEntryState(entry: Durable): string {
  if (entry.superseded_by) {
    return "superseded";
  }

  if (entry.retired || entry.valid_to) {
    return "historical";
  }

  return "current";
}

/**
 * Formats the claim-key lifecycle label for lineage inspection.
 *
 * @param entry - Entry to describe.
 * @returns Lifecycle label text.
 */
function formatClaimLifecycle(entry: Durable): string {
  if (!entry.claim_key) {
    return "no-key";
  }

  return entry.claim_key_status ?? "legacy";
}

/** Builds a compact change summary from one traced claim family. */
function summarizeClaimFamilyTransition(entries: Durable[]): string | undefined {
  const current = entries.find((entry) => !entry.retired && !entry.superseded_by);
  const prior = [...entries]
    .reverse()
    .find((entry) => entry.id !== current?.id && (entry.superseded_by !== undefined || entry.retired || entry.valid_to !== undefined));
  if (current && prior) {
    return `${prior.id} -> ${current.id}`;
  }
  if (prior) {
    return `${prior.id} is historical with no current sibling in the traced family`;
  }
  if (current) {
    return `${current.id} is the only current sibling in the traced family`;
  }
  return undefined;
}

/**
 * Resolves the effective trace slot policy and explanation for the target family.
 *
 * @param trace - Loaded trace payload.
 * @returns Effective slot-policy metadata for the traced family.
 */
function resolveTraceSlotPolicy(trace: EntryTrace): { policy: string; reason: string } {
  if (trace.claimFamily) {
    const resolved = resolveClaimSlotPolicy(trace.claimFamily.claimKey);
    return {
      policy: trace.claimFamily.slotPolicy ?? resolved.policy,
      reason: trace.claimFamily.slotPolicyReason ?? resolved.reason,
    };
  }

  if (trace.entry.claim_key) {
    const resolved = resolveClaimSlotPolicy(trace.entry.claim_key);
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
 * @param slotPolicy - Optional slot-policy metadata when the entry has a claim key.
 * @returns Structured trace entry payload.
 */
function serializeTraceEntry(entry: Durable, slotPolicy?: { policy: string; reason: string }): Record<string, unknown> {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    type: entry.type,
    expiry: entry.expiry,
    importance: entry.importance,
    retired: entry.retired,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    memoryState: describeEntryState(entry),
    claimLifecycle: formatClaimLifecycle(entry),
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

/**
 * Truncates long output text for concise CLI display.
 *
 * @param value - Text to truncate.
 * @param maxChars - Maximum character count.
 * @returns Truncated string when needed.
 */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

/**
 * Converts unknown thrown values into displayable error text.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
