import { createHash } from "node:crypto";

import { executeAuditReadQuery } from "./audit-queries";

const GENESIS_HASH_INPUT = "genesis";

interface AuditChainRow {
  id: string;
  timestamp: string;
  prevHash: string | null;
}

export interface VerificationResult {
  valid: boolean;
  totalEntries: number;
  checkedEntries: number;
  unchainedEntries?: number;
  brokenAt?: { id: string; timestamp: string; expected: string; actual: string };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  if (typeof value === "string") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  return 0;
}

function parseLimit(limit?: number): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return undefined;
  }

  const normalized = Math.floor(limit);
  if (normalized < 1) {
    return undefined;
  }

  return normalized;
}

function toAuditChainRow(row: Record<string, unknown>): AuditChainRow | null {
  const id = row["id"];
  const timestamp = row["timestamp"];
  const prevHashRaw = row["prev_hash"];
  const prevHash = typeof prevHashRaw === "string" ? prevHashRaw : null;

  if (typeof id !== "string" || typeof timestamp !== "string") {
    return null;
  }

  return { id, timestamp, prevHash };
}

async function countAuditEntries(): Promise<number> {
  const result = await executeAuditReadQuery(
    `SELECT COUNT(*) AS total
    FROM credential_audit_log`,
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return 0;
  }

  return parseCount(row["total"]);
}

async function countUserAuditEntries(userId: string): Promise<number> {
  const result = await executeAuditReadQuery(
    `SELECT COUNT(*) AS total
    FROM credential_audit_log
    WHERE user_id = ?`,
    [userId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return 0;
  }

  return parseCount(row["total"]);
}

async function loadAuditRows(limit?: number): Promise<{ rows: AuditChainRow[]; hasAnchor: boolean }> {
  const normalizedLimit = parseLimit(limit);

  if (!normalizedLimit) {
    const result = await executeAuditReadQuery(
      `SELECT
        id,
        timestamp,
        prev_hash
      FROM credential_audit_log
      ORDER BY timestamp ASC, id ASC`,
    );

    return {
      rows: result.rows
        .map((row) => toAuditChainRow(row as Record<string, unknown>))
        .filter((row): row is AuditChainRow => row !== null),
      hasAnchor: false,
    };
  }

  const result = await executeAuditReadQuery(
    `SELECT id, timestamp, prev_hash
    FROM (
      SELECT
        id,
        timestamp,
        prev_hash
      FROM credential_audit_log
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    ) recent_entries
    ORDER BY timestamp ASC, id ASC`,
    [normalizedLimit + 1],
  );

  const rows = result.rows
    .map((row) => toAuditChainRow(row as Record<string, unknown>))
    .filter((row): row is AuditChainRow => row !== null);

  return {
    rows,
    hasAnchor: rows.length > normalizedLimit,
  };
}

async function loadUserAuditRows(userId: string, limit?: number): Promise<AuditChainRow[]> {
  const normalizedLimit = parseLimit(limit);

  if (!normalizedLimit) {
    const result = await executeAuditReadQuery(
      `SELECT
        id,
        timestamp,
        prev_hash
      FROM credential_audit_log
      WHERE user_id = ?
      ORDER BY timestamp ASC, id ASC`,
      [userId],
    );

    return result.rows
      .map((row) => toAuditChainRow(row as Record<string, unknown>))
      .filter((row): row is AuditChainRow => row !== null);
  }

  const result = await executeAuditReadQuery(
    `SELECT id, timestamp, prev_hash
    FROM (
      SELECT
        id,
        timestamp,
        prev_hash
      FROM credential_audit_log
      WHERE user_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    ) recent_entries
    ORDER BY timestamp ASC, id ASC`,
    [userId, normalizedLimit],
  );

  return result.rows
    .map((row) => toAuditChainRow(row as Record<string, unknown>))
    .filter((row): row is AuditChainRow => row !== null);
}

export async function verifyAuditChain(limit?: number): Promise<VerificationResult> {
  const totalEntries = await countAuditEntries();
  if (totalEntries === 0) {
    return {
      valid: true,
      totalEntries,
      checkedEntries: 0,
    };
  }

  const { rows, hasAnchor } = await loadAuditRows(limit);
  const startIndex = hasAnchor ? 1 : 0;
  let previousRow = hasAnchor ? rows[0] ?? null : null;
  let checkedEntries = 0;

  for (let i = startIndex; i < rows.length; i += 1) {
    const currentRow = rows[i];
    if (!currentRow) {
      continue;
    }

    if (currentRow.prevHash === null) {
      previousRow = currentRow;
      continue;
    }

    const expected = previousRow
      ? sha256Hex(`${previousRow.id}${previousRow.timestamp}`)
      : sha256Hex(GENESIS_HASH_INPUT);
    checkedEntries += 1;

    if (currentRow.prevHash !== expected) {
      return {
        valid: false,
        totalEntries,
        checkedEntries,
        brokenAt: {
          id: currentRow.id,
          timestamp: currentRow.timestamp,
          expected,
          actual: currentRow.prevHash,
        },
      };
    }

    previousRow = currentRow;
  }

  return {
    valid: true,
    totalEntries,
    checkedEntries,
  };
}

export async function verifyUserAuditChain(
  userId: string,
  limit?: number,
): Promise<VerificationResult> {
  const totalEntries = await countUserAuditEntries(userId);
  if (totalEntries === 0) {
    return {
      valid: true,
      totalEntries,
      checkedEntries: 0,
      unchainedEntries: 0,
    };
  }

  const rows = await loadUserAuditRows(userId, limit);
  const checkedEntries = rows.length;
  const unchainedEntries = rows.reduce((count, row) => count + (row.prevHash === null ? 1 : 0), 0);

  return {
    valid: true,
    totalEntries,
    checkedEntries,
    unchainedEntries,
  };
}
