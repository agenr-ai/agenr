import type { Durable } from "../../core/types.js";
import type { EntryRecallEvent, EntryTraceDreamAction, EntryTraceProfileSnapshot, EntryTraceProvenance, EntryTraceTimelineEvent } from "./ports.js";

/** Minimum delta between created and updated timestamps before emitting an updated event. */
const UPDATED_EVENT_MIN_DELTA_MS = 1_000;

/**
 * Builds provenance facts for one durable trace view.
 *
 * @param entry - Durable row being traced.
 * @returns Normalized provenance payload.
 */
export function buildEntryTraceProvenance(entry: Durable): EntryTraceProvenance {
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
export function buildEntryTraceTimeline(input: {
  entry: Durable;
  dreamActions: EntryTraceDreamAction[];
  recallEvents: EntryRecallEvent[];
  profileSnapshots: EntryTraceProfileSnapshot[];
}): EntryTraceTimelineEvent[] {
  const events: EntryTraceTimelineEvent[] = [
    {
      at: input.entry.created_at,
      kind: "created",
      label: "Durable created",
      detail: formatProvenanceDetail(input.entry),
    },
  ];

  const createdMs = Date.parse(input.entry.created_at);
  const updatedMs = Date.parse(input.entry.updated_at);
  if (Number.isFinite(createdMs) && Number.isFinite(updatedMs) && updatedMs - createdMs >= UPDATED_EVENT_MIN_DELTA_MS) {
    events.push({
      at: input.entry.updated_at,
      kind: "updated",
      label: "Durable updated",
      detail: formatUpdateDetail(input.entry),
    });
  }

  for (const action of input.dreamActions) {
    events.push({
      at: action.createdAt,
      kind: "dream",
      label: `Dream ${action.actionType}`,
      detail: action.reasoning,
      runId: action.runId,
      actionType: action.actionType,
    });
  }

  for (const snapshot of input.profileSnapshots) {
    events.push({
      at: snapshot.createdAt,
      kind: "profile",
      label: snapshot.role === "directive" ? "Included in directive profile snapshot" : "Included in profile snapshot",
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
function formatRecallDetail(recall: EntryRecallEvent): string | undefined {
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
function compareTimelineEvents(left: EntryTraceTimelineEvent, right: EntryTraceTimelineEvent): number {
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
function timelineKindRank(kind: EntryTraceTimelineEvent["kind"]): number {
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
