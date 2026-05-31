import type { Row } from "@libsql/client";

import type { WorkingSetStatus } from "../../app/working-memory/constants.js";
import type { WorkingEventRecord, WorkingSetRecord } from "../../app/working-memory/records.js";
import type { WorkingSnapshot } from "../../app/working-memory/snapshot.js";
import { readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";

/** Canonical working-set column names in persistence order. */
const WORKING_SET_COLUMN_NAMES = [
  "id",
  "scope_key",
  "scope_kind",
  "title",
  "objective",
  "status",
  "summary",
  "snapshot_json",
  "revision",
  "event_count",
  "heartbeat_at",
  "resume_after",
  "stale_after",
  "lease_owner",
  "lease_expires_at",
  "user_id",
  "project",
  "surface",
  "session_id",
  "session_key",
  "conversation_key",
  "runtime_thread_key",
  "host_thread_id",
  "cwd",
  "git_root",
  "git_branch",
  "task_id",
  "source",
  "created_at",
  "updated_at",
  "last_active_at",
  "closed_at",
  "close_reason",
  "episode_id",
] as const;

/** SQL fragment for SELECT lists over working_sets. */
const WORKING_SET_SELECT_COLUMNS = WORKING_SET_COLUMN_NAMES.join(",\n  ");

/** SQL fragment for INSERT column lists over working_sets. */
const WORKING_SET_INSERT_COLUMNS = WORKING_SET_COLUMN_NAMES.join(",\n          ");

/** Placeholder list for INSERT VALUES over working_sets. */
const WORKING_SET_INSERT_PLACEHOLDERS = WORKING_SET_COLUMN_NAMES.map(() => "?").join(", ");

/** Mutable working-set columns updated on revision-guarded writes. */
const WORKING_SET_UPDATE_COLUMNS = [
  "title",
  "objective",
  "status",
  "summary",
  "snapshot_json",
  "revision",
  "event_count",
  "heartbeat_at",
  "resume_after",
  "stale_after",
  "lease_owner",
  "lease_expires_at",
  "updated_at",
  "last_active_at",
  "closed_at",
  "close_reason",
  "episode_id",
] as const;

const WORKING_EVENT_SELECT_COLUMNS = `
  id,
  working_set_id,
  sequence,
  event_type,
  payload_json,
  actor,
  source,
  host_event_id,
  turn_id,
  created_at
`;

/** Builds the UPDATE SET clause for working_sets. */
function buildWorkingSetUpdateSetClause(): string {
  return WORKING_SET_UPDATE_COLUMNS.map((column) => `${column} = ?`).join(",\n            ");
}

/** Maps a database row into the app working-set record. */
function mapWorkingSetRow(row: Row): WorkingSetRecord {
  const snapshot = parseJson<WorkingSnapshot>(readRequiredString(row, "snapshot_json"), "snapshot_json");
  return {
    id: readRequiredString(row, "id"),
    scopeKey: readRequiredString(row, "scope_key"),
    scopeKind: readRequiredString(row, "scope_kind") as WorkingSetRecord["scopeKind"],
    title: readOptionalString(row, "title"),
    objective: readOptionalString(row, "objective"),
    status: readRequiredString(row, "status") as WorkingSetStatus,
    summary: readOptionalString(row, "summary"),
    snapshot,
    revision: readNumber(row, "revision", 0),
    eventCount: readNumber(row, "event_count", 0),
    heartbeatAt: readOptionalString(row, "heartbeat_at"),
    resumeAfter: readOptionalString(row, "resume_after"),
    staleAfter: readOptionalString(row, "stale_after"),
    leaseOwner: readOptionalString(row, "lease_owner"),
    leaseExpiresAt: readOptionalString(row, "lease_expires_at"),
    userId: readOptionalString(row, "user_id"),
    project: readOptionalString(row, "project"),
    surface: readOptionalString(row, "surface"),
    sessionId: readOptionalString(row, "session_id"),
    sessionKey: readOptionalString(row, "session_key"),
    conversationKey: readOptionalString(row, "conversation_key"),
    runtimeThreadKey: readOptionalString(row, "runtime_thread_key"),
    hostThreadId: readOptionalString(row, "host_thread_id"),
    cwd: readOptionalString(row, "cwd"),
    gitRoot: readOptionalString(row, "git_root"),
    gitBranch: readOptionalString(row, "git_branch"),
    taskId: readOptionalString(row, "task_id"),
    source: readOptionalString(row, "source"),
    createdAt: readRequiredString(row, "created_at"),
    updatedAt: readRequiredString(row, "updated_at"),
    lastActiveAt: readRequiredString(row, "last_active_at"),
    closedAt: readOptionalString(row, "closed_at"),
    closeReason: readOptionalString(row, "close_reason"),
    episodeId: readOptionalString(row, "episode_id"),
  };
}

/** Maps a database row into the app working-event record. */
function mapWorkingEventRow(row: Row): WorkingEventRecord {
  return {
    id: readRequiredString(row, "id"),
    workingSetId: readRequiredString(row, "working_set_id"),
    sequence: readNumber(row, "sequence", 0),
    eventType: readRequiredString(row, "event_type") as WorkingEventRecord["eventType"],
    payload: parseJson<unknown>(readRequiredString(row, "payload_json"), "payload_json"),
    actor: readOptionalString(row, "actor") as WorkingEventRecord["actor"],
    source: readOptionalString(row, "source") as WorkingEventRecord["source"],
    hostEventId: readOptionalString(row, "host_event_id"),
    turnId: readOptionalString(row, "turn_id"),
    createdAt: readRequiredString(row, "created_at"),
  };
}

/** Parses a JSON column with a descriptive error. */
function parseJson<T>(value: string, column: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in working-memory column ${column}: ${message}`, { cause: error });
  }
}

export {
  buildWorkingSetUpdateSetClause,
  mapWorkingEventRow,
  mapWorkingSetRow,
  WORKING_EVENT_SELECT_COLUMNS,
  WORKING_SET_INSERT_COLUMNS,
  WORKING_SET_INSERT_PLACEHOLDERS,
  WORKING_SET_SELECT_COLUMNS,
};
