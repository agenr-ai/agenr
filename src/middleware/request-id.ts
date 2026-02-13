import { createMiddleware } from "hono/factory";

function readRequestId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = readRequestId(c.req.header("x-request-id")) ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  await next();
  c.res.headers.set("X-Request-Id", requestId);
});
