import { randomUUID } from "node:crypto";

import {
  CLOSE_MANAGED_WORKING_SET_STATUSES,
  CURRENT_WORKING_SET_STATUSES,
  OPEN_WORKING_SET_STATUSES,
  type WorkingSetStatus,
} from "../../app/working-memory/constants.js";
import type { WorkingEventRecord, WorkingSetRecord } from "../../app/working-memory/records.js";
import type { ResolvedWorkingScope } from "../../app/working-memory/scope.js";
import type { WorkingEventType } from "../../app/working-memory/events.js";
import { normalizeBoundedLimit } from "../../app/working-memory/limits.js";
import type {
  CreateWorkingSetInput,
  UpdateWorkingSetInput,
  WorkingMemoryRepository,
  WorkingSetCreateResult,
  WorkingSetListFilter,
  WorkingSetWriteResult,
} from "../../app/working-memory/repository.js";
import type { SqlDatabase } from "./client.js";
import type { SqlExecutor } from "./queries.js";
import {
  buildWorkingSetUpdateSetClause,
  mapWorkingEventRow,
  mapWorkingSetRow,
  WORKING_EVENT_SELECT_COLUMNS,
  WORKING_SET_INSERT_COLUMNS,
  WORKING_SET_INSERT_PLACEHOLDERS,
  WORKING_SET_SELECT_COLUMNS,
} from "./working-memory-columns.js";

/**
 * Creates a libSQL-backed repository for schema v11 working memory.
 *
 * @param database - Initialized agenr database.
 * @returns Working-memory repository.
 */
export function createWorkingMemoryRepository(database: SqlDatabase): WorkingMemoryRepository {
  return {
    getWorkingSet: (id) => getWorkingSet(database, id),
    findCurrentWorkingSets: (scope) => findWorkingSetsByScope(database, scope, CURRENT_WORKING_SET_STATUSES),
    listWorkingSets: (filter) => listWorkingSets(database, filter),
    listWorkingEvents: (workingSetId, limit) => listWorkingEvents(database, workingSetId, limit),
    createWorkingSet: (input) => createWorkingSet(database, input),
    updateWorkingSet: (input) => updateWorkingSet(database, input),
  };
}

/** Loads one working set by primary key. */
async function getWorkingSet(executor: SqlExecutor, id: string): Promise<WorkingSetRecord | null> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${WORKING_SET_SELECT_COLUMNS}
      FROM working_sets
      WHERE id = ?
      LIMIT 1
    `,
    args: [normalizedId],
  });
  const row = result.rows[0];
  return row ? mapWorkingSetRow(row) : null;
}

/** Finds working sets for one resolved scope and status set. */
async function findWorkingSetsByScope(executor: SqlExecutor, scope: ResolvedWorkingScope, statuses: readonly WorkingSetStatus[]): Promise<WorkingSetRecord[]> {
  const result = await executor.execute({
    sql: `
      SELECT ${WORKING_SET_SELECT_COLUMNS}
      FROM working_sets
      WHERE scope_key = ?
        AND status IN (${statuses.map(() => "?").join(", ")})
      ORDER BY last_active_at DESC, id ASC
    `,
    args: [scope.scopeKey, ...statuses],
  });

  return result.rows.map((row) => mapWorkingSetRow(row));
}

/** Lists working sets for inspection. */
async function listWorkingSets(executor: SqlExecutor, filter: WorkingSetListFilter): Promise<WorkingSetRecord[]> {
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (filter.scope) {
    conditions.push("scope_key = ?");
    args.push(filter.scope.scopeKey);
  }

  if (filter.statuses && filter.statuses.length > 0) {
    conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    args.push(...filter.statuses);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeBoundedLimit(filter.limit, 20, 100);
  const result = await executor.execute({
    sql: `
      SELECT ${WORKING_SET_SELECT_COLUMNS}
      FROM working_sets
      ${where}
      ORDER BY last_active_at DESC, id ASC
      LIMIT ?
    `,
    args: [...args, limit],
  });

  return result.rows.map((row) => mapWorkingSetRow(row));
}

/** Lists working events for one set. */
async function listWorkingEvents(executor: SqlExecutor, workingSetId: string, limit: number | undefined): Promise<WorkingEventRecord[]> {
  const normalizedId = workingSetId.trim();
  if (!normalizedId) {
    return [];
  }

  const normalizedLimit = normalizeBoundedLimit(limit, 50, 1000);
  const result = await executor.execute({
    sql: `
      SELECT ${WORKING_EVENT_SELECT_COLUMNS}
      FROM working_events
      WHERE working_set_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `,
    args: [normalizedId, normalizedLimit],
  });

  return result.rows.map((row) => mapWorkingEventRow(row)).reverse();
}

/** Creates one working set and its initial event. */
async function createWorkingSet(database: SqlDatabase, input: CreateWorkingSetInput): Promise<WorkingSetCreateResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const existing = await findWorkingSetsByScope(executor, input.scope, CURRENT_WORKING_SET_STATUSES);
    if (existing.length > 0) {
      return { kind: "active_set_exists", scopeKey: input.scope.scopeKey };
    }

    const id = randomUUID();
    const event = buildEvent({
      workingSetId: id,
      sequence: 1,
      eventType: "created",
      payload: {
        objective: input.objective,
        scope: input.scope,
      },
      actor: input.actor,
      source: input.source,
      now: input.now,
    });

    await executor.execute({
      sql: `
        INSERT INTO working_sets (
          ${WORKING_SET_INSERT_COLUMNS}
        )
        VALUES (
          ${WORKING_SET_INSERT_PLACEHOLDERS}
        )
      `,
      args: [
        id,
        input.scope.scopeKey,
        input.scope.scopeKind,
        toNullableString(input.title),
        toNullableString(input.objective),
        input.status,
        toNullableString(input.snapshot.summary),
        serializeJson(input.snapshot),
        1,
        1,
        null,
        toNullableString(input.snapshot.continuation?.resumeAfter),
        toNullableString(input.snapshot.continuation?.staleAfter),
        null,
        null,
        null,
        toNullableString(input.scope.project),
        null,
        toNullableString(input.sessionId ?? input.scope.sessionId),
        toNullableString(input.scope.sessionKey),
        toNullableString(input.scope.conversationKey),
        toNullableString(input.scope.runtimeThreadKey),
        toNullableString(input.scope.hostThreadId),
        toNullableString(input.scope.cwd),
        toNullableString(input.scope.gitRoot),
        toNullableString(input.scope.gitBranch),
        toNullableString(input.scope.taskId),
        toNullableString(input.sourceLabel),
        input.now,
        input.now,
        input.now,
        null,
        null,
        null,
      ],
    });
    await insertWorkingEvent(executor, event);
    const workingSet = await requireWorkingSet(executor, id);

    return { workingSet, event };
  });
}

/** Applies one revision-guarded update. */
async function updateWorkingSet(database: SqlDatabase, input: UpdateWorkingSetInput): Promise<WorkingSetWriteResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const current = await getWorkingSet(executor, input.workingSetId);
    if (!current) {
      return { kind: "not_found" };
    }

    if (!canApplyWorkingSetUpdate(current.status, input.status)) {
      return { kind: "terminal_status", status: current.status };
    }

    if (current.revision !== input.expectedRevision) {
      return { kind: "revision_conflict", actualRevision: current.revision };
    }

    const nextRevision = current.revision + 1;
    const nextEventCount = current.eventCount + 1;
    const event = buildEvent({
      workingSetId: current.id,
      sequence: nextEventCount,
      eventType: input.eventType,
      payload: input.payload,
      actor: input.actor,
      source: input.source,
      now: input.now,
    });

    await executor.execute({
      sql: `
        UPDATE working_sets
        SET ${buildWorkingSetUpdateSetClause()}
        WHERE id = ?
      `,
      args: [
        toNullableString(input.title ?? current.title),
        toNullableString(input.objective ?? input.snapshot.objective),
        input.status,
        toNullableString(input.snapshot.summary),
        serializeJson(input.snapshot),
        nextRevision,
        nextEventCount,
        toNullableString(input.heartbeatAt ?? current.heartbeatAt),
        toNullableString(input.snapshot.continuation?.resumeAfter),
        toNullableString(input.snapshot.continuation?.staleAfter),
        toNullableString("leaseOwner" in input ? (input.leaseOwner ?? undefined) : current.leaseOwner),
        toNullableString("leaseExpiresAt" in input ? (input.leaseExpiresAt ?? undefined) : current.leaseExpiresAt),
        input.now,
        input.now,
        toNullableString(input.closedAt ?? current.closedAt),
        toNullableString(input.closeReason ?? current.closeReason),
        toNullableString(input.episodeId ?? current.episodeId),
        current.id,
      ],
    });
    await insertWorkingEvent(executor, event);
    const workingSet = await requireWorkingSet(executor, current.id);

    return { workingSet, event };
  });
}

/** Inserts one event row. */
async function insertWorkingEvent(executor: SqlExecutor, event: WorkingEventRecord): Promise<void> {
  await executor.execute({
    sql: `
      INSERT INTO working_events (
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
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      event.id,
      event.workingSetId,
      event.sequence,
      event.eventType,
      serializeJson(event.payload),
      toNullableString(event.actor),
      toNullableString(event.source),
      toNullableString(event.hostEventId),
      toNullableString(event.turnId),
      event.createdAt,
    ],
  });
}

/** Builds an in-memory event record before insertion. */
function buildEvent(input: {
  workingSetId: string;
  sequence: number;
  eventType: WorkingEventType;
  payload: unknown;
  actor?: WorkingEventRecord["actor"];
  source?: WorkingEventRecord["source"];
  now: string;
}): WorkingEventRecord {
  return {
    id: randomUUID(),
    workingSetId: input.workingSetId,
    sequence: input.sequence,
    eventType: input.eventType,
    payload: input.payload,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: input.now,
  };
}

/** Returns true when the repository may apply a revision-guarded update. */
function canApplyWorkingSetUpdate(currentStatus: WorkingSetStatus, nextStatus: WorkingSetStatus): boolean {
  if (OPEN_WORKING_SET_STATUSES.includes(currentStatus as (typeof OPEN_WORKING_SET_STATUSES)[number])) {
    return true;
  }

  return currentStatus === "complete" && CLOSE_MANAGED_WORKING_SET_STATUSES.includes(nextStatus as (typeof CLOSE_MANAGED_WORKING_SET_STATUSES)[number]);
}

/** Loads a just-written working set or throws for corruption. */
async function requireWorkingSet(executor: SqlExecutor, id: string): Promise<WorkingSetRecord> {
  const workingSet = await getWorkingSet(executor, id);
  if (!workingSet) {
    throw new Error(`Working set ${id} was not found after write.`);
  }

  return workingSet;
}

/** Serializes a required JSON payload. */
function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Normalizes optional strings for SQL writes. */
function toNullableString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
