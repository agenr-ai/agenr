import type { Client } from "@libsql/client";
import { toNumber, toRowsAffected, toStringValue } from "../utils/entry-utils.js";

const DEFAULT_EDGE_INCREMENT = 0.1;
export const MAX_USED_ENTRIES = 20;
const MIN_EDGE_WEIGHT = 0.05;
const CO_RECALL_EDGE_TYPE = "co_recalled";

export interface CoRecallNeighbor {
  entryId: string;
  weight: number;
  sessionCount: number;
  lastCoRecalled: string;
}

export interface CoRecallEdge {
  entryA: string;
  entryB: string;
  weight: number;
  sessionCount: number;
  lastCoRecalled: string;
}

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function strengthenCoRecallEdges(
  db: Client,
  usedEntryIds: string[],
  timestamp: string,
): Promise<void> {
  const uniqueIds = Array.from(
    new Set(
      usedEntryIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ).slice(0, MAX_USED_ENTRIES);

  if (uniqueIds.length < 2) {
    return;
  }

  const now = timestamp || new Date().toISOString();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const a = uniqueIds[i];
    if (!a) {
      continue;
    }
    for (let j = i + 1; j < uniqueIds.length; j += 1) {
      const b = uniqueIds[j];
      if (!b || a === b) {
        continue;
      }
      pairs.push(normalizePair(a, b));
    }
  }

  if (pairs.length === 0) {
    return;
  }

  await db.execute("BEGIN");
  try {
    for (const [entryA, entryB] of pairs) {
      await db.execute({
        sql: `
          INSERT INTO co_recall_edges (
            entry_a, entry_b, edge_type, weight, session_count, last_co_recalled, created_at
          )
          VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT
          DO UPDATE SET
            weight = MIN(co_recall_edges.weight + excluded.weight, 1.0),
            session_count = co_recall_edges.session_count + 1,
            last_co_recalled = excluded.last_co_recalled
        `,
        args: [
          entryA,
          entryB,
          CO_RECALL_EDGE_TYPE,
          DEFAULT_EDGE_INCREMENT,
          now,
          now,
        ],
      });
    }
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures and rethrow original error.
    }
    throw error;
  }
}

/**
 * Decay all co-recall edge weights by the given factor and prune edges
 * below the minimum threshold. Intended to run once per calendar day
 * (not per session) via background maintenance. With decayFactor=0.95,
 * this gives a half-life of ~14 days.
 */
export async function decayCoRecallEdges(db: Client, decayFactor = 0.95): Promise<number> {
  if (!Number.isFinite(decayFactor) || decayFactor < 0) {
    throw new Error("decayFactor must be a finite number >= 0");
  }

  await db.execute("BEGIN");
  try {
    await db.execute({
      sql: `
        UPDATE co_recall_edges
        SET weight = weight * ?
        WHERE edge_type = ?
      `,
      args: [decayFactor, CO_RECALL_EDGE_TYPE],
    });

    const pruned = await db.execute({
      sql: `
        DELETE FROM co_recall_edges
        WHERE edge_type = ?
          AND weight < ?
      `,
      args: [CO_RECALL_EDGE_TYPE, MIN_EDGE_WEIGHT],
    });

    await db.execute("COMMIT");
    return toRowsAffected(pruned.rowsAffected);
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures and rethrow original error.
    }
    throw error;
  }
}

export async function getCoRecallNeighbors(
  db: Client,
  entryId: string,
  minWeight = 0.1,
  limit = 10,
): Promise<CoRecallNeighbor[]> {
  const normalizedId = entryId.trim();
  if (!normalizedId) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  const safeMinWeight = Number.isFinite(minWeight) ? Math.max(minWeight, 0) : 0.1;

  const result = await db.execute({
    sql: `
      SELECT
        CASE WHEN entry_a = ? THEN entry_b ELSE entry_a END AS neighbor_id,
        weight,
        session_count,
        last_co_recalled
      FROM co_recall_edges
      WHERE edge_type = ?
        AND (entry_a = ? OR entry_b = ?)
        AND weight >= ?
      ORDER BY weight DESC, session_count DESC, last_co_recalled DESC
      LIMIT ?
    `,
    args: [normalizedId, CO_RECALL_EDGE_TYPE, normalizedId, normalizedId, safeMinWeight, safeLimit],
  });

  return result.rows.map((row) => ({
    entryId: toStringValue((row as { neighbor_id?: unknown }).neighbor_id),
    weight: toNumber((row as { weight?: unknown }).weight),
    sessionCount: toNumber((row as { session_count?: unknown }).session_count),
    lastCoRecalled: toStringValue((row as { last_co_recalled?: unknown }).last_co_recalled),
  }));
}

export async function getTopCoRecallEdges(db: Client, limit = 20): Promise<CoRecallEdge[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const result = await db.execute({
    sql: `
      SELECT entry_a, entry_b, weight, session_count, last_co_recalled
      FROM co_recall_edges
      WHERE edge_type = ?
      ORDER BY weight DESC, session_count DESC, last_co_recalled DESC
      LIMIT ?
    `,
    args: [CO_RECALL_EDGE_TYPE, safeLimit],
  });

  return result.rows.map((row) => ({
    entryA: toStringValue((row as { entry_a?: unknown }).entry_a),
    entryB: toStringValue((row as { entry_b?: unknown }).entry_b),
    weight: toNumber((row as { weight?: unknown }).weight),
    sessionCount: toNumber((row as { session_count?: unknown }).session_count),
    lastCoRecalled: toStringValue((row as { last_co_recalled?: unknown }).last_co_recalled),
  }));
}
