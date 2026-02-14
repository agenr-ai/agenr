import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgenrClient } from "../src/client";
import { AgenrError } from "../src/errors";

const originalFetch = globalThis.fetch;

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchJson(responseBody: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function agpResponse(operation: "discover" | "query" | "execute", businessId: string, data: unknown) {
  return {
    id: "txn_123",
    operation,
    businessId,
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    data,
  };
}

function parseBody(index = 0): unknown {
  const body = calls[index]?.init?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

function headersAt(index = 0): Headers {
  return new Headers((calls[index]?.init?.headers ?? {}) as HeadersInit);
}

describe("AgenrClient", () => {
  test("discover() calls POST /agp/discover with correct body", async () => {
    mockFetchJson(agpResponse("discover", "echo", { services: [] }));
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.discover("echo");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.example.test/agp/discover");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(parseBody()).toEqual({ businessId: "echo" });
  });

  test("query() calls POST /agp/query with correct body", async () => {
    mockFetchJson(agpResponse("query", "echo", { results: [] }));
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.query("echo", { serviceId: "catalog" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.example.test/agp/query");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(parseBody()).toEqual({ businessId: "echo", request: { serviceId: "catalog" } });
  });

  test("execute() calls POST /agp/execute with correct body", async () => {
    mockFetchJson(agpResponse("execute", "echo", { status: "ok" }));
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.execute("echo", { serviceId: "order" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.example.test/agp/execute");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(parseBody()).toEqual({ businessId: "echo", request: { serviceId: "order" } });
  });

  test("execute() sends x-confirmation-token header when provided", async () => {
    mockFetchJson(agpResponse("execute", "echo", { status: "ok" }));
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.execute(
      "echo",
      { serviceId: "order", confirmationToken: "adapter-token" },
      { confirmationToken: "api-confirm-token" },
    );

    const headers = headersAt();
    expect(headers.get("x-confirmation-token")).toBe("api-confirm-token");
  });

  test("execute() sends idempotency-key header when provided", async () => {
    mockFetchJson(agpResponse("execute", "echo", { status: "ok" }));
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.execute("echo", { serviceId: "order" }, { idempotencyKey: "idem-123" });

    const headers = headersAt();
    expect(headers.get("idempotency-key")).toBe("idem-123");
  });

  test("prepare() calls POST /agp/execute/prepare with correct body", async () => {
    mockFetchJson({
      confirmationToken: "confirm-123",
      expiresAt: "2026-01-01T00:05:00.000Z",
      summary: "Confirm this execute request",
    });
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    const result = await client.prepare("echo", { serviceId: "order", amount: 1000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.example.test/agp/execute/prepare");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(parseBody()).toEqual({
      businessId: "echo",
      request: { serviceId: "order", amount: 1000 },
    });
    expect(result).toEqual({
      confirmationToken: "confirm-123",
      expiresAt: "2026-01-01T00:05:00.000Z",
      summary: "Confirm this execute request",
    });
  });

  test("status() calls GET /agp/status/:id", async () => {
    mockFetchJson({
      id: "txn_123",
      operation: "execute",
      businessId: "echo",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      data: null,
    });
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    await client.status("txn_123");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.example.test/agp/status/txn_123");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  test("non-200 responses throw AgenrError with statusCode", async () => {
    mockFetchJson({ error: "Forbidden" }, 403);
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });

    try {
      await client.discover("echo");
      throw new Error("Expected discover() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgenrError);
      expect((error as AgenrError).statusCode).toBe(403);
      expect((error as AgenrError).message).toBe("Forbidden");
    }
  });

  test("empty businessId throws", async () => {
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });
    await expect(client.discover("")).rejects.toThrow("discover() requires a businessId");
  });

  test("empty transactionId throws", async () => {
    const client = new AgenrClient({ baseUrl: "https://api.example.test" });
    await expect(client.status("   ")).rejects.toThrow("status() requires a transactionId");
  });
});
