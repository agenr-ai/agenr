import { Hono } from "hono";
import type { Context } from "hono";

import { verifyAuditChain, verifyUserAuditChain } from "../vault/audit-verification";

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export const auditApp = new Hono();

function isAdmin(c: Context): boolean {
  const scopes = c.get("apiKeyScopes") ?? [];
  const tier = c.get("apiKeyTier");
  return tier === "admin" || scopes.includes("*");
}

auditApp.get("/verify", async (c) => {
  const rawLimit = c.req.query("limit");
  const limit = parseLimit(rawLimit);
  if (rawLimit !== undefined && limit === null) {
    return c.json({ error: "Invalid limit query parameter. Expected positive integer." }, 400);
  }

  if (isAdmin(c)) {
    const result = await verifyAuditChain(limit ?? undefined);
    return c.json(result);
  }

  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await verifyUserAuditChain(userId, limit ?? undefined);
  return c.json(result);
});
