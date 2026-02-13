import { createHash } from "node:crypto";

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";

type UnknownRecord = Record<string, unknown>;

export type ExecutePolicy = "open" | "confirm" | "strict";

interface ExecuteInput {
  businessId: string;
  request: UnknownRecord;
}

export interface ConfirmationTokenRecord {
  token: string;
  createdAtMs: number;
  expiresAtMs: number;
  businessId: string;
  requestHash: string;
  summary: string;
}

const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

function readExecutePolicy(): ExecutePolicy {
  const raw = process.env.AGENR_EXECUTE_POLICY?.trim().toLowerCase();
  if (raw === "confirm" || raw === "strict") return raw;
  return "open";
}

export function resolveExecutePolicy(): ExecutePolicy {
  return readExecutePolicy();
}

function readMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  return null;
}

export async function cleanupExpiredConfirmationTokens(nowMs = Date.now()): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: "DELETE FROM confirmation_tokens WHERE expires_at_ms <= ?",
    args: [nowMs],
  });
}

function toTokenRecord(row: Record<string, unknown>): ConfirmationTokenRecord | null {
  const token = row["token"];
  const businessId = row["business_id"];
  const requestHash = row["request_hash"];
  const summary = row["summary"];
  const createdAtMs = readMs(row["created_at_ms"]);
  const expiresAtMs = readMs(row["expires_at_ms"]);

  if (
    typeof token !== "string" ||
    typeof businessId !== "string" ||
    typeof requestHash !== "string" ||
    typeof summary !== "string" ||
    createdAtMs === null ||
    expiresAtMs === null
  ) {
    return null;
  }

  return {
    token,
    businessId,
    requestHash,
    summary,
    createdAtMs,
    expiresAtMs,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableJson(entry));
  }

  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    const normalized: UnknownRecord = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      normalized[key] = normalizeForStableJson(record[key]);
    }
    return normalized;
  }

  return value;
}

function requestHashFor(input: ExecuteInput): string {
  const normalizedRequest = normalizeForStableJson(input.request);
  const payload = `${input.businessId}:${JSON.stringify(normalizedRequest)}`;
  return createHash("sha256").update(payload).digest("hex");
}

function readNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readAmountFromRequest(request: UnknownRecord): number | null {
  const amountCents = readNumericValue(request["amount_cents"]);
  if (amountCents !== null) return amountCents;
  return readNumericValue(request["amount"]);
}

function resolveMaxExecuteAmount(): number {
  const raw = process.env.AGENR_MAX_EXECUTE_AMOUNT?.trim();
  if (!raw) return 100;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 100;
  return parsed;
}

function describeExecuteInput(input: ExecuteInput): string {
  const amount = readAmountFromRequest(input.request);
  if (amount === null) {
    return `Execute request for business '${input.businessId}'`;
  }

  return `Execute request for business '${input.businessId}' (requested amount: ${amount} cents)`;
}

async function readExecuteInputFromRequest(c: Context): Promise<ExecuteInput | null> {
  try {
    const rawBody = (await c.req.raw.clone().json()) as unknown;
    if (!isRecord(rawBody)) return null;

    const businessId = rawBody["businessId"];
    const request = rawBody["request"];

    if (typeof businessId !== "string" || !isRecord(request)) return null;

    return { businessId, request };
  } catch {
    return null;
  }
}

export async function storeConfirmationToken(record: ConfirmationTokenRecord): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO confirmation_tokens (
      token,
      business_id,
      request_hash,
      summary,
      created_at_ms,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      record.token,
      record.businessId,
      record.requestHash,
      record.summary,
      record.createdAtMs,
      record.expiresAtMs,
    ],
  });
}

export async function getConfirmationToken(token: string): Promise<ConfirmationTokenRecord | null> {
  const db = getDb();
  const tokenResult = await db.execute({
    sql: `SELECT
      token,
      business_id,
      request_hash,
      summary,
      created_at_ms,
      expires_at_ms
    FROM confirmation_tokens
    WHERE token = ?`,
    args: [token],
  });

  const tokenRow = tokenResult.rows[0] as Record<string, unknown> | undefined;
  return tokenRow ? toTokenRecord(tokenRow) : null;
}

export async function consumeConfirmationToken(token: string): Promise<ConfirmationTokenRecord | null> {
  const record = await getConfirmationToken(token);
  if (!record) {
    return null;
  }

  const db = getDb();
  await db.execute({
    sql: "DELETE FROM confirmation_tokens WHERE token = ?",
    args: [token],
  });
  return record;
}

export async function prepareExecuteConfirmation(input: ExecuteInput): Promise<{
  confirmationToken: string;
  expiresAt: string;
  summary: string;
}> {
  await cleanupExpiredConfirmationTokens();

  const nowMs = Date.now();
  const token = crypto.randomUUID();
  const expiresAtMs = nowMs + CONFIRMATION_TOKEN_TTL_MS;
  const summary = describeExecuteInput(input);
  await storeConfirmationToken({
    token,
    businessId: input.businessId,
    requestHash: requestHashFor(input),
    summary,
    createdAtMs: nowMs,
    expiresAtMs,
  });

  return {
    confirmationToken: token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    summary,
  };
}

export const executePolicyMiddleware = createMiddleware(async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (c.req.method !== "POST" || pathname !== "/agp/execute") {
    await next();
    return;
  }

  const policy = readExecutePolicy();
  if (policy === "open") {
    await next();
    return;
  }

  await cleanupExpiredConfirmationTokens();

  const confirmationToken = c.req.header("x-confirmation-token")?.trim();
  if (!confirmationToken) {
    return c.json(
      { error: "Execute confirmation required. Provide x-confirmation-token header." },
      403,
    );
  }

  const executeInput = await readExecuteInputFromRequest(c);
  if (!executeInput) {
    return c.json(
      { error: "Unable to validate confirmation token for execute payload." },
      403,
    );
  }

  const tokenRecord = await getConfirmationToken(confirmationToken);
  if (!tokenRecord) {
    return c.json({ error: "Invalid confirmation token." }, 403);
  }

  if (tokenRecord.expiresAtMs <= Date.now()) {
    await consumeConfirmationToken(confirmationToken);
    return c.json({ error: "Confirmation token expired. Prepare a new token." }, 403);
  }

  const expectedHash = requestHashFor(executeInput);
  if (tokenRecord.businessId !== executeInput.businessId || tokenRecord.requestHash !== expectedHash) {
    return c.json(
      { error: "Confirmation token does not match this execute request." },
      403,
    );
  }

  if (policy === "strict") {
    const requestedAmount = readAmountFromRequest(executeInput.request);
    if (requestedAmount !== null) {
      const maxAmount = resolveMaxExecuteAmount();
      if (requestedAmount > maxAmount) {
        return c.json(
          { error: `Execute amount exceeds policy limit (${maxAmount} cents).` },
          403,
        );
      }
    }
  }

  // Single-use token: consume after successful policy validation.
  await consumeConfirmationToken(confirmationToken);

  await next();
});
