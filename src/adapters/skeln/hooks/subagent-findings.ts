import type { ExtensionContext } from "skeln";

import type { WorkingCommandNote } from "../../../app/working-memory/snapshot.js";
import type { createAgenrSkelnServices } from "../../../app/skeln/runtime.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { isRecord, readOptionalTrimmedString } from "../../shared/validation.js";
import { toWorkingScopeFromSkelnSession } from "../session/scope.js";
import type { AgenrSkelnSessionScope } from "../types.js";

const SUBAGENT_OUTCOME_MAX_CHARS = 3_000;
const SUBAGENT_RESULT_LIMIT = 6;

/** Minimal Skeln tool-result event fields consumed by subagent finding capture. */
export interface SkelnSubagentToolResultEvent {
  /** Tool name emitted by Skeln. */
  toolName: string;
  /** Whether the tool result is already an error. */
  isError: boolean;
  /** Structured tool details. */
  details: unknown;
}

/**
 * Records bounded subagent findings on the active working set when available.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param resolveScope - Host scope resolver.
 * @param context - Active Skeln extension context.
 * @param event - Tool-result event emitted by Skeln.
 */
export async function recordSkelnSubagentFindings(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
  event: SkelnSubagentToolResultEvent,
): Promise<void> {
  const commandNote = buildSkelnSubagentCommandNote(event, new Date().toISOString());
  if (!commandNote) {
    return;
  }

  try {
    const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
    const result = await services.workingMemory.run({
      action: "update",
      scope: toWorkingScopeFromSkelnSession(scope),
      operation: {
        type: "add_command_note",
        command: commandNote,
      },
      updateReason: "Recorded bounded subagent findings on the parent working set.",
      actor: "runtime",
      source: "lifecycle_hook",
    });

    if (!result.ok && !isExpectedSubagentFindingSkip(result.code)) {
      console.warn(`[agenr] subagent findings working-memory update failed: ${result.message}`);
    }
  } catch (error) {
    console.warn(`[agenr] subagent findings capture failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Builds a bounded working-memory command note from one subagent result.
 *
 * @param event - Tool-result event emitted by Skeln.
 * @param observedAt - Timestamp for the command note.
 * @returns Command note, or undefined when the result is not a successful subagent result.
 */
export function buildSkelnSubagentCommandNote(event: SkelnSubagentToolResultEvent, observedAt: string): WorkingCommandNote | undefined {
  if (event.toolName !== "subagent" || event.isError) {
    return undefined;
  }

  const details = isRecord(event.details) ? event.details : undefined;
  if (!details) {
    return undefined;
  }

  const mode = readOptionalTrimmedString(details.mode) ?? "unknown";
  const artifactPath = readOptionalTrimmedString(details.artifactPath);
  const results = Array.isArray(details.results) ? details.results.flatMap(normalizeDelegationResult).slice(0, SUBAGENT_RESULT_LIMIT) : [];
  if (results.length === 0 && !artifactPath) {
    return undefined;
  }

  const resultLines = results.map(
    (result) => `- ${result.agent}${result.name ? `/${result.name}` : ""}: ${result.status}${result.summary ? ` - ${result.summary}` : ""}`,
  );
  const outcome = truncateText(
    [
      `mode=${mode}`,
      ...resultLines,
      ...(artifactPath ? [`artifact=${artifactPath}`] : []),
      ...(results.length >= SUBAGENT_RESULT_LIMIT ? ["additional subagent results omitted"] : []),
    ].join("\n"),
    SUBAGENT_OUTCOME_MAX_CHARS,
  );

  return {
    command: `subagent ${mode}`,
    outcome,
    observedAt,
  };
}

/** Normalized delegation result used by compact note rendering. */
interface NormalizedDelegationResult {
  /** Child agent name. */
  agent: string;
  /** Optional task name. */
  name?: string;
  /** Child status. */
  status: string;
  /** Compact stdout or stderr summary. */
  summary?: string;
}

/** Converts one raw delegation result into bounded display facts. */
function normalizeDelegationResult(value: unknown): NormalizedDelegationResult[] {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    return [];
  }

  const agent = readOptionalTrimmedString(record.agent);
  const status = readOptionalTrimmedString(record.status);
  if (!agent || !status) {
    return [];
  }

  const stdout = readOptionalTrimmedString(record.stdout);
  const stderr = readOptionalTrimmedString(record.stderr);
  const name = readOptionalTrimmedString(record.name);
  const summary = firstMeaningfulLine(stdout ?? stderr);
  return [
    {
      agent,
      ...(name ? { name } : {}),
      status,
      ...(summary ? { summary } : {}),
    },
  ];
}

/** Returns true when a skipped subagent capture is expected and non-actionable. */
function isExpectedSubagentFindingSkip(code: string): boolean {
  return code === "feature_disabled" || code === "missing_active_set" || code === "missing_scope" || code === "misconfigured";
}

/** Reads the first meaningful output line. */
function firstMeaningfulLine(value: string | undefined): string | undefined {
  const line = value
    ?.split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? truncateText(line, 500) : undefined;
}

/** Truncates text to a bounded UTF-16 character length. */
function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}
