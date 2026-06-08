import type { Durable } from "../../core/types.js";
import type { DurableRecallEvent, DurableTraceDreamAction, DurableTraceProfileSnapshot, DurableTraceProvenance, DurableTraceTimelineEvent } from "./ports.js";

/** Minimum delta between created and updated timestamps before emitting an updated event. */
const UPDATED_EVENT_MIN_DELTA_MS = 1_000;

/**
 * Builds provenance facts for one durable trace view.
 *
 * @param entry - Durable row being traced.
 * @returns Normalized provenance payload.
 */
export function buildDurableTraceProvenance(entry: Durable): DurableTraceProvenance {
  return {
    ...(entry.source_file ? { sourceFile: entry.source_file } : {}),
    ...(entry.source_context ? { sourceContext: entry.source_context } : {}),
    ...(entry.claim_key_source ? { claimKeySource: entry.claim_key_source } : {}),
    ...(entry.claim_support_locator ? { claimSupportLocator: entry.claim_support_locator } : {}),
    ...(entry.claim_support_observed_at ? { claimSupportObservedAt: entry.claim_support_observed_at } : {}),
    ...(entry.project ? { project: entry.project } : {}),
    ...(entry.user_id ? { userId: entry.user_id } : {}),
  };
}

/**
 * Builds a chronological audit timeline for one durable trace view.
 *
 * @param input - Entry facts plus related audit rows.
 * @returns Timeline events ordered oldest first.
 */
export function buildDurableTraceTimeline(input: {
  durable: Durable;
  dreamActions: DurableTraceDreamAction[];
  recallEvents: DurableRecallEvent[];
  profileSnapshots: DurableTraceProfileSnapshot[];
}): DurableTraceTimelineEvent[] {
  const events: DurableTraceTimelineEvent[] = [];

  if (!isDreamCreatedDurable(input.durable, input.dreamActions)) {
    events.push({
      at: input.durable.created_at,
      kind: "created",
      label: "Durable created",
      detail: formatProvenanceDetail(input.durable),
    });
  }

  const createdMs = Date.parse(input.durable.created_at);
  const updatedMs = Date.parse(input.durable.updated_at);
  if (Number.isFinite(createdMs) && Number.isFinite(updatedMs) && updatedMs - createdMs >= UPDATED_EVENT_MIN_DELTA_MS) {
    events.push({
      at: input.durable.updated_at,
      kind: "updated",
      label: input.durable.superseded_by ? "Marked superseded" : "Durable updated",
      detail: formatUpdateDetail(input.durable),
    });
  }

  for (const action of input.dreamActions) {
    events.push({
      at: action.createdAt,
      kind: "dream",
      label: formatDreamActionLabel(action.actionType),
      detail: formatDreamActionDetail(action),
      runId: action.runId,
      actionType: action.actionType,
    });
  }

  for (const snapshot of input.profileSnapshots) {
    events.push({
      at: snapshot.createdAt,
      kind: "profile",
      label: snapshot.role === "directive" ? "Selected for directive startup profile" : "Selected for startup memory profile",
      detail: `snapshot=${snapshot.id}`,
      runId: snapshot.runId ?? undefined,
    });
  }

  for (const recall of input.recallEvents) {
    events.push({
      at: recall.recalledAt,
      kind: "recall",
      label: "Recalled",
      detail: formatRecallDetail(recall),
    });
  }

  return events.sort(compareTimelineEvents);
}

/** Returns whether a Dreaming audit action is already the durable creation event. */
function isDreamCreatedDurable(durable: Durable, dreamActions: DurableTraceDreamAction[]): boolean {
  return dreamActions.some((action) => {
    if (action.actionType !== "insert_durable" && action.actionType !== "supersede_durable") {
      return false;
    }
    return action.createdAt === durable.created_at;
  });
}

/** Formats a Dreaming audit action into an operator-facing timeline label. */
function formatDreamActionLabel(actionType: string): string {
  switch (actionType) {
    case "insert_durable":
      return "Dreaming extracted durable";
    case "supersede_durable":
      return "Dreaming created revision";
    case "stale":
      return "Dreaming marked stale";
    case "update_durable":
      return "Dreaming updated durable";
    case "merge":
      return "Dreaming merged durable";
    case "log_conflict":
      return "Dreaming logged conflict";
    case "resolve_conflict":
      return "Dreaming resolved conflict";
    case "flag_review":
      return "Dreaming flagged review";
    case "skip":
      return "Dreaming skipped action";
    default:
      return `Dreaming ${actionType}`;
  }
}

/** Formats Dreaming audit details without relying on raw action identifiers. */
function formatDreamActionDetail(action: DurableTraceDreamAction): string | undefined {
  const parts: string[] = [];
  if (action.reasoning) {
    parts.push(action.reasoning);
  }
  if (action.details) {
    const claimKey = readDetailString(action.details, "claim_key");
    if (claimKey) {
      parts.push(`claim_key=${claimKey}`);
    }

    const evidenceRefs = readDetailStringArray(action.details, "evidence_refs");
    if (evidenceRefs.length > 0) {
      parts.push(`evidence=${evidenceRefs.join(", ")}`);
    }

    const predecessorId = readDetailString(action.details, "predecessor_id");
    if (predecessorId) {
      parts.push(`predecessor=${predecessorId}`);
    }

    const successorId = readDetailString(action.details, "successor_id");
    if (successorId) {
      parts.push(`successor=${successorId}`);
    }

    const validTo = readDetailString(action.details, "valid_to");
    if (validTo) {
      parts.push(`valid_to=${validTo}`);
    }
  }
  if (action.runId) {
    parts.push(`run=${action.runId}`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Reads one optional string field from Dreaming action details. */
function readDetailString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Reads one optional string array field from Dreaming action details. */
function readDetailStringArray(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Formats provenance detail for a created timeline event. */
function formatProvenanceDetail(entry: Durable): string | undefined {
  const parts: string[] = [];
  if (entry.source_file) {
    parts.push(`source=${entry.source_file}`);
  }
  if (entry.claim_key_source) {
    parts.push(`claim_key_source=${entry.claim_key_source}`);
  }
  if (entry.claim_key) {
    parts.push(`claim_key=${entry.claim_key}`);
  }

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Formats update detail for an updated timeline event. */
function formatUpdateDetail(entry: Durable): string | undefined {
  const parts: string[] = [];
  if (entry.supersession_kind) {
    parts.push(`supersession_kind=${entry.supersession_kind}`);
  }
  if (entry.supersession_reason) {
    parts.push(`reason=${entry.supersession_reason}`);
  }
  if (entry.valid_to) {
    parts.push(`valid_to=${entry.valid_to}`);
  }
  if (entry.claim_key) {
    parts.push(`claim_key=${entry.claim_key}`);
  }

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Formats recall detail for a recall timeline event. */
function formatRecallDetail(recall: DurableRecallEvent): string | undefined {
  const parts: string[] = [];
  if (recall.query) {
    parts.push(`query=${recall.query}`);
  }
  if (recall.sessionKey) {
    parts.push(`session=${recall.sessionKey}`);
  }

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Compares timeline events chronologically with stable tie-breakers. */
function compareTimelineEvents(left: DurableTraceTimelineEvent, right: DurableTraceTimelineEvent): number {
  const leftMs = Date.parse(left.at);
  const rightMs = Date.parse(right.at);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }

  const kindDelta = timelineKindRank(left.kind) - timelineKindRank(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  return left.label.localeCompare(right.label);
}

/** Assigns stable ordering ranks to timeline kinds at equal timestamps. */
function timelineKindRank(kind: DurableTraceTimelineEvent["kind"]): number {
  switch (kind) {
    case "created":
      return 0;
    case "updated":
      return 1;
    case "dream":
      return 2;
    case "profile":
      return 3;
    case "recall":
      return 4;
  }
}
