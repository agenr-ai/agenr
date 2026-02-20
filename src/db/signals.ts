import type { Client } from "@libsql/client";

export interface SignalEntry {
  rowid: number;
  id: string;
  type: string;
  subject: string;
  importance: number;
  created_at: string;
}

export interface SignalBatch {
  entries: SignalEntry[];
  maxSeq: number;
}

/**
 * Fetch new high-importance entries since a given watermark.
 * Returns entries with rowid > sinceSeq, importance >= minImportance, retired = 0.
 * Ordered by rowid ASC. Limit caps max entries per signal.
 */
export async function fetchNewSignalEntries(
  db: Client,
  sinceSeq: number,
  minImportance: number,
  limit: number,
  maxAgeSec: number = 0,
): Promise<SignalBatch> {
  const ageArgs: (string | number)[] = maxAgeSec > 0
    ? [minImportance, sinceSeq, new Date(Date.now() - maxAgeSec * 1000).toISOString(), limit]
    : [minImportance, sinceSeq, limit];

  const sql = maxAgeSec > 0
    ? `SELECT rowid, id, type, subject, importance, created_at
       FROM entries
       WHERE importance >= ? AND rowid > ? AND retired = 0
         AND created_at >= ?
       ORDER BY rowid ASC
       LIMIT ?`
    : `SELECT rowid, id, type, subject, importance, created_at
       FROM entries
       WHERE importance >= ? AND rowid > ? AND retired = 0
       ORDER BY rowid ASC
       LIMIT ?`;

  const result = await db.execute({
    sql,
    args: ageArgs,
  });

  const entries: SignalEntry[] = result.rows.map((row) => ({
    rowid: Number(row.rowid),
    id: String(row.id),
    type: String(row.type),
    subject: String(row.subject),
    importance: Number(row.importance),
    created_at: String(row.created_at),
  }));

  const maxSeq = entries.length > 0 ? (entries.at(-1)?.rowid ?? sinceSeq) : sinceSeq;

  return { entries, maxSeq };
}

/**
 * Format signal entries into a compact notification string (50-100 tokens).
 */
export function formatSignal(entries: SignalEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [
    `AGENR SIGNAL: ${entries.length} new high-importance ${entries.length === 1 ? "entry" : "entries"}`,
  ];

  for (const entry of entries) {
    lines.push(`- [${entry.type}, imp:${entry.importance}] "${entry.subject}"`);
  }

  return lines.join("\n");
}

/**
 * Read the current watermark for a consumer.
 * Returns 0 if no watermark exists (first signal check).
 */
export async function getWatermark(db: Client, consumerId: string): Promise<number> {
  const result = await db.execute({
    sql: "SELECT last_received_seq FROM signal_watermarks WHERE consumer_id = ?",
    args: [consumerId],
  });

  if (result.rows.length === 0) {
    return 0;
  }
  return Number(result.rows[0]?.last_received_seq);
}

/**
 * Advance the watermark for a consumer. Upsert.
 */
export async function setWatermark(db: Client, consumerId: string, seq: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO signal_watermarks (consumer_id, last_received_seq, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(consumer_id)
          DO UPDATE SET last_received_seq = excluded.last_received_seq,
                        updated_at = excluded.updated_at`,
    args: [consumerId, seq],
  });
}

/**
 * Initialize first-seen consumers to the current maximum rowid so pre-existing
 * high-importance entries are not replayed as mid-session signals.
 */
export async function initializeWatermark(db: Client, consumerId: string): Promise<number> {
  const existing = await db.execute({
    sql: "SELECT last_received_seq FROM signal_watermarks WHERE consumer_id = ?",
    args: [consumerId],
  });
  if (existing.rows.length > 0) {
    return Number(existing.rows[0]?.last_received_seq);
  }

  const maxResult = await db.execute("SELECT MAX(rowid) AS max_rowid FROM entries");
  const maxRowid = Number((maxResult.rows[0] as { max_rowid?: unknown } | undefined)?.max_rowid ?? 0);
  await setWatermark(db, consumerId, maxRowid);
  return maxRowid;
}
