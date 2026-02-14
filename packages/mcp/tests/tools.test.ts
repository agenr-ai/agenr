import { describe, expect, it } from "vitest";
import { AgenrError } from "@agenr/sdk";
import { registerTools, type CreateClient } from "../src/tools";

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    discover: overrides.discover ?? (async (businessId: string) => ({
      data: { services: [{ id: "catalog" }], hints: { typicalFlow: "test" } },
    })),
    query: overrides.query ?? (async (businessId: string, request: Record<string, unknown>) => ({
      data: { results: [{ id: "widget-1" }] },
    })),
    execute: overrides.execute ?? (async (businessId: string, request: Record<string, unknown>) => ({
      data: { status: "pending_confirmation", confirmationToken: "echo-confirm-123" },
    })),
    status: overrides.status ?? (async (transactionId: string) => ({
      id: transactionId,
      status: "succeeded",
      data: {},
    })),
  } as ReturnType<CreateClient>;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureTools(clientOverrides: Record<string, unknown> = {}) {
  const tools: Record<string, { description: string; handler: ToolHandler }> = {};

  const fakeServer = {
    tool(name: string, description: string, _schema: unknown, handler: ToolHandler) {
      tools[name] = { description, handler };
    },
  };

  registerTools(fakeServer as never, () => mockClient(clientOverrides));
  return tools;
}

describe("MCP tools", () => {
  it("registers 4 tools", () => {
    const tools = captureTools();
    const names = Object.keys(tools);
    expect(names).toContain("agenr_discover");
    expect(names).toContain("agenr_query");
    expect(names).toContain("agenr_execute");
    expect(names).toContain("agenr_status");
    expect(names.length).toBe(4);
  });

  it("discover tool calls SDK and returns data", async () => {
    const tools = captureTools();
    const result = await tools.agenr_discover.handler({ businessId: "echo" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.services).toBeDefined();
    expect(parsed.hints).toBeDefined();
  });

  it("query tool passes request through", async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const tools = captureTools({
      query: async (_biz: string, req: Record<string, unknown>) => {
        capturedRequest = req;
        return { data: { results: [] } };
      },
    });
    await tools.agenr_query.handler({ businessId: "echo", request: { serviceId: "catalog" } });
    expect(capturedRequest).toEqual({ serviceId: "catalog" });
  });

  it("execute tool passes request through", async () => {
    const tools = captureTools();
    const result = await tools.agenr_execute.handler({
      businessId: "echo",
      request: { serviceId: "order", items: [{ productId: "echo-widget-1", quantity: 1 }] },
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.confirmationToken).toBeDefined();
  });

  it("status tool returns transaction", async () => {
    const tools = captureTools();
    const result = await tools.agenr_status.handler({ transactionId: "txn-123" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("txn-123");
    expect(parsed.status).toBe("succeeded");
  });

  it("returns error content on SDK failure", async () => {
    const tools = captureTools({
      discover: async () => { throw new AgenrError("Not found", 404); },
    });
    const result = await tools.agenr_discover.handler({ businessId: "bad" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  it("returns error for missing businessId", async () => {
    const tools = captureTools();
    const result = await tools.agenr_discover.handler({ businessId: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("businessId");
  });

  it("returns error for invalid request object", async () => {
    const tools = captureTools();
    const result = await tools.agenr_query.handler({ businessId: "echo", request: "not-an-object" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("request");
  });
});
