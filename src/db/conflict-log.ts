import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { toNumber, toStringValue } from "../utils/entry-utils.js";

export interface ConflictLogEntry {
  id: string;
  entryA: string;
  entryB: string;
  relation: string;
  confidence: number;
  resolution: string;
  resolvedAt: string | null;
  createdAt: string;
}

function mapConflictLogRow(row: Record<string, unknown>): ConflictLogEntry {
  const confidence = toNumber(row.confidence);
  return {
    id: toStringValue(row.id),
    entryA: toStringValue(row.entry_a),
    entryB: toStringValue(row.entry_b),
    relation: toStringValue(row.relation),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    resolution: toStringValue(row.resolution),
    resolvedAt: toStringValue(row.resolved_at) || null,
    createdAt: toStringValue(row.created_at),
  };
}

export async function logConflict(
  db: Client,
  entryA: string,
  entryB: string,
  relation: string,
  confidence: number,
  resolution: string,
): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await db.execute({
    sql: `
      INSERT INTO conflict_log (
        id,
        entry_a,
        entry_b,
        relation,
        confidence,
        resolution,
        resolved_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [id, entryA, entryB, relation, confidence, resolution, null, createdAt],
  });

  return id;
}

export async function getPendingConflicts(db: Client): Promise<ConflictLogEntry[]> {
  const result = await db.execute({
    sql: `
      SELECT
        id,
        entry_a,
        entry_b,
        relation,
        confidence,
        resolution,
        resolved_at,
        created_at
      FROM conflict_log
      WHERE resolution = 'pending'
      ORDER BY created_at DESC
    `,
  });

  return result.rows.map((row) => mapConflictLogRow(row as Record<string, unknown>));
}

export async function resolveConflictLog(
  db: Client,
  conflictId: string,
  resolution: string,
): Promise<void> {
  await db.execute({
    sql: `
      UPDATE conflict_log
      SET resolution = ?, resolved_at = ?
      WHERE id = ?
    `,
    args: [resolution, new Date().toISOString(), conflictId],
  });
}

export async function getConflictStats(
  db: Client,
): Promise<{
  total: number;
  pending: number;
  autoResolved: number;
  userResolved: number;
}> {
  const result = await db.execute({
    sql: `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN resolution = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN resolution IN ('auto-superseded', 'coexist') THEN 1 ELSE 0 END) AS auto_resolved,
        SUM(CASE WHEN resolution IN ('keep-new', 'keep-old', 'keep-both') THEN 1 ELSE 0 END) AS user_resolved
      FROM conflict_log
    `,
  });

  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const total = toNumber(row.total);
  const pending = toNumber(row.pending);
  const autoResolvedRaw = toNumber(row.auto_resolved);
  const userResolvedRaw = toNumber(row.user_resolved);

  return {
    total: Number.isFinite(total) ? total : 0,
    pending: Number.isFinite(pending) ? pending : 0,
    autoResolved: Number.isFinite(autoResolvedRaw) ? autoResolvedRaw : 0,
    userResolved: Number.isFinite(userResolvedRaw) ? userResolvedRaw : 0,
  };
}
