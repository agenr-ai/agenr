import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { z } from "zod";

import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";
import { INVALID_JSON_BODY_RESPONSE, parseJsonBody } from "../../src/utils/json-body";

const discoverSchema = z.object({
  businessId: z.string().min(1),
});

const querySchema = z.object({
  businessId: z.string().min(1),
  request: z.record(z.string(), z.unknown()),
});

const executeSchema = z.object({
  businessId: z.string().min(1),
  request: z.record(z.string(), z.unknown()),
});

let originalApiKey: string | undefined;

function createAgpJsonParseTestApp(): Hono {
  const app = new Hono();
  app.use("/agp/*", apiKeyAuthMiddleware);

  app.post("/agp/discover", requireScope("discover"), async (c) => {
    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    discoverSchema.parse(parsedBody.data);
    return c.json({ ok: true });
  });

  app.post("/agp/query", requireScope("query"), async (c) => {
    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    querySchema.parse(parsedBody.data);
    return c.json({ ok: true });
  });

  app.post("/agp/execute/prepare", requireScope("execute"), async (c) => {
    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    executeSchema.parse(parsedBody.data);
    return c.json({ ok: true });
  });

  app.post("/agp/execute", requireScope("execute"), async (c) => {
    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    executeSchema.parse(parsedBody.data);
    return c.json({ ok: true });
  });

  return app;
}

beforeEach(() => {
  originalApiKey = process.env.AGENR_API_KEY;
  process.env.AGENR_API_KEY = "admin-key";
});

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }
});

describe("AGP json parsing", () => {
  const endpoints = ["/agp/discover", "/agp/query", "/agp/execute/prepare", "/agp/execute"] as const;

  for (const endpoint of endpoints) {
    test(`${endpoint} returns 400 when body is invalid JSON`, async () => {
      const app = createAgpJsonParseTestApp();
      const response = await app.request(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-key",
          "content-type": "application/json",
        },
        body: "not json at all",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(INVALID_JSON_BODY_RESPONSE);
    });
  }
});
