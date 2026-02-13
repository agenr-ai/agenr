import type { Context } from "hono";

export const INVALID_JSON_BODY_RESPONSE = {
  error: "Invalid request",
  message: "Request body must be valid JSON.",
} as const;

export type ParsedJsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; response: Response };

export async function parseJsonBody(c: Context): Promise<ParsedJsonBodyResult> {
  try {
    return { ok: true, data: await c.req.json() };
  } catch {
    return { ok: false, response: c.json(INVALID_JSON_BODY_RESPONSE, 400) };
  }
}
