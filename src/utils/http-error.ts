import type { Context } from "hono";

export function internalServerError(c: Context): Response {
  const requestId = c.get("requestId") ?? crypto.randomUUID();
  return c.json(
    {
      error: "Internal server error",
      requestId,
    },
    500,
  );
}
