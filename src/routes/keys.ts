import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import {
  createApiKey,
  FREE_TIER_SCOPES,
  getApiKeyById,
  linkApiKeyToUser,
  listApiKeys,
  PAID_TIER_SCOPES,
  revokeApiKey,
} from "../db/api-keys";
import { getUserById } from "../db/users";
import { apiKeyAuthMiddleware, requireScope } from "../middleware/auth";

const createKeySchema = z.object({
  label: z.string().trim().min(1),
  tier: z.enum(["free", "paid"]),
  ownerEmail: z.string().trim().email().optional(),
  scopes: z.array(z.string().trim().min(1)).optional(),
});

const linkKeySchema = z.object({
  userId: z.string().trim().min(1),
});

function normalizeScopes(scopes: string[]): string[] {
  const deduped = new Set<string>();

  for (const scope of scopes) {
    const normalized = scope.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    deduped.add(normalized);
  }

  return Array.from(deduped.values());
}

function defaultScopesForTier(tier: "free" | "paid"): string[] {
  if (tier === "paid") {
    return [...PAID_TIER_SCOPES];
  }
  return [...FREE_TIER_SCOPES];
}

function allowedScopesForTier(tier: "free" | "paid"): Set<string> {
  if (tier === "paid") {
    return new Set(PAID_TIER_SCOPES);
  }
  return new Set(FREE_TIER_SCOPES);
}

async function resolveCreateKeyUserId(c: Context): Promise<string | undefined | Response> {
  if (c.get("apiKeyTier") === "admin") {
    return c.get("userId");
  }

  const userId = c.get("userId");
  const apiKeyId = c.get("apiKeyId");
  if (!userId || !apiKeyId || userId !== apiKeyId) {
    return c.json(
      {
        error: "Forbidden",
        message: "API keys cannot create additional keys. Create keys from a signed-in session.",
      },
      403,
    );
  }

  const user = await getUserById(userId);
  if (!user) {
    return c.json(
      {
        error: "Forbidden",
        message: "Only signed-in users can create API keys.",
      },
      403,
    );
  }

  return user.id;
}

export function createKeyRoutes(): Hono {
  const keyApp = new Hono();

  keyApp.post("/keys", apiKeyAuthMiddleware, async (c) => {
    const keyUserId = await resolveCreateKeyUserId(c);
    if (keyUserId instanceof Response) {
      return keyUserId;
    }

    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = createKeySchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const requestedScopes = parsed.data.scopes
      ? normalizeScopes(parsed.data.scopes)
      : defaultScopesForTier(parsed.data.tier);
    const allowedScopes = allowedScopesForTier(parsed.data.tier);
    const invalidScopes = requestedScopes.filter((scope) => !allowedScopes.has(scope));

    if (invalidScopes.length > 0) {
      return c.json(
        {
          error: "Invalid request",
          message: `Scopes not allowed for tier '${parsed.data.tier}': ${invalidScopes.join(", ")}`,
        },
        400,
      );
    }

    const created = await createApiKey({
      label: parsed.data.label,
      tier: parsed.data.tier,
      ownerEmail: parsed.data.ownerEmail,
      scopes: requestedScopes,
      userId: keyUserId,
    });

    return c.json(
      {
        id: created.record.id,
        key: created.raw,
        label: created.record.label,
        tier: created.record.tier,
        scopes: created.record.scopes,
        createdAt: created.record.createdAt,
        warning: "Store this key securely. It will not be shown again.",
      },
      201,
    );
  });

  keyApp.get("/keys/me", apiKeyAuthMiddleware, async (c) => {
    const apiKeyId = c.get("apiKeyId");
    if (!apiKeyId) {
      return c.json({ error: "Key not found" }, 404);
    }

    const key = await getApiKeyById(apiKeyId);
    if (!key) {
      return c.json({ error: "Key not found" }, 404);
    }

    return c.json({
      id: key.id,
      label: key.label,
      tier: key.tier,
      scopes: key.scopes,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    });
  });

  keyApp.get("/keys", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const keys = await listApiKeys();
    return c.json(
      keys.map((key) => ({
        id: key.id,
        label: key.label,
        tier: key.tier,
        ownerEmail: key.ownerEmail,
        scopes: key.scopes,
        rateLimitOverride: key.rateLimitOverride,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
      })),
    );
  });

  keyApp.delete("/keys/:id", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const id = c.req.param("id").trim();
    if (!id) {
      return c.json({ error: "Invalid request", message: "Key id is required." }, 400);
    }

    const revoked = await revokeApiKey(id);
    if (!revoked) {
      return c.json({ error: "Key not found" }, 404);
    }

    return c.json({ id, status: "revoked" });
  });

  keyApp.post("/keys/:id/link", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const id = c.req.param("id").trim();
    if (!id) {
      return c.json({ error: "Invalid request", message: "Key id is required." }, 400);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = linkKeySchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const user = await getUserById(parsed.data.userId);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const linked = await linkApiKeyToUser(id, user.id);
    if (!linked) {
      return c.json({ error: "Key not found" }, 404);
    }

    return c.json({
      id,
      userId: user.id,
      status: "linked",
    });
  });

  return keyApp;
}
