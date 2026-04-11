import { Option, type Command } from "commander";

import { loadOpenClawEntryTraceRuntime } from "../../app/openclaw/inspect.js";
import type { OpenClawEntryTrace } from "../../app/openclaw/ports.js";
import { resolveClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { Entry } from "../../core/types.js";

interface TraceCommandOptions {
  id?: string;
  subject?: string;
  last?: boolean;
}

/**
 * Registers the `agenr trace` CLI command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace")
    .description("Inspect one entry's provenance and claim-family lineage")
    .addOption(new Option("--id <id>", "Entry id to inspect"))
    .addOption(new Option("--subject <text>", "Subject text to resolve when the id is unknown"))
    .option("--last", "Inspect the most recently created entry")
    .action(async (options: TraceCommandOptions) => {
      try {
        const trace = await loadOpenClawEntryTraceRuntime({
          id: options.id,
          subject: options.subject,
          last: options.last === true,
          env: process.env,
        });
        process.stdout.write(renderTrace(trace));
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
function renderTrace(trace: OpenClawEntryTrace): string {
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
    lines.push(`slot_policy=${resolveClaimSlotPolicy(trace.entry.claim_key).policy}`);
  }

  if (trace.claimFamily && trace.claimFamily.entries.length > 0) {
    const slotPolicy = trace.claimFamily.slotPolicy ?? resolveClaimSlotPolicy(trace.claimFamily.claimKey).policy;
    lines.push(
      `claim_family=${trace.claimFamily.claimKey} | slot_policy=${slotPolicy} | ${trace.claimFamily.entries
        .map((entry) => `${entry.id}:${describeEntryState(entry)}:${formatClaimLifecycle(entry)}`)
        .join(", ")}`,
    );
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
 * Formats one narrow memory-state label for lineage inspection.
 *
 * @param entry - Entry to describe.
 * @returns Narrow state label.
 */
function describeEntryState(entry: Entry): string {
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
function formatClaimLifecycle(entry: Entry): string {
  if (!entry.claim_key) {
    return "no-key";
  }

  return entry.claim_key_status ?? "legacy";
}

/** Builds a compact change summary from one traced claim family. */
function summarizeClaimFamilyTransition(entries: Entry[]): string | undefined {
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
