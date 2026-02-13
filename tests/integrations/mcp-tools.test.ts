import { describe, expect, test } from "bun:test";

import { AgenrError } from "@agenr/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools, type CreateClient } from "../../packages/mcp/src/tools";

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  name: string;
  config: {
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (input: Record<string, unknown>) => Promise<ToolResponse>;
};

class MockMcpServer {
  readonly tools: RegisteredTool[] = [];

  registerTool(
    name: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    handler: (input: Record<string, unknown>) => Promise<ToolResponse>,
  ): void {
    this.tools.push({ name, config, handler });
  }
}

function createMockClient(overrides?: Partial<ReturnType<CreateClient>>): ReturnType<CreateClient> {
  return {
    discover: async () => ({ data: { business: "echo" } }),
    query: async () => ({ data: { results: [] } }),
    execute: async () => ({ data: { status: "ok" } }),
    status: async () => ({ id: "txn-1", status: "pending" }),
    ...overrides,
  };
}

function getTool(server: MockMcpServer, name: string): RegisteredTool {
  const tool = server.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }

  return tool;
}

describe("mcp tools", () => {
  test("registerTools adds 4 tools", () => {
    const server = new MockMcpServer();
    registerTools(server as unknown as McpServer, () => createMockClient());

    expect(server.tools).toHaveLength(4);
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "agenr_discover",
      "agenr_query",
      "agenr_execute",
      "agenr_status",
    ]);
  });

  test("discover tool calls SDK and returns data", async () => {
    const discoverCalls: string[] = [];
    const server = new MockMcpServer();

    registerTools(server as unknown as McpServer, () =>
      createMockClient({
        discover: async (businessId: string) => {
          discoverCalls.push(businessId);
          return { data: { services: [{ id: "catalog" }] } };
        },
      }),
    );

    const tool = getTool(server, "agenr_discover");
    const result = await tool.handler({ businessId: "echo" });

    expect(discoverCalls).toEqual(["echo"]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      services: [{ id: "catalog" }],
    });
  });

  test("execute tool passes request through", async () => {
    const executeCalls: Array<{ businessId: string; request: Record<string, unknown> }> = [];
    const server = new MockMcpServer();

    registerTools(server as unknown as McpServer, () =>
      createMockClient({
        execute: async (businessId: string, request: Record<string, unknown>) => {
          executeCalls.push({ businessId, request });
          return { data: { status: "pending_confirmation" } };
        },
      }),
    );

    const request = {
      serviceId: "order",
      items: [{ productId: "echo-widget-1", quantity: 2 }],
    };

    const tool = getTool(server, "agenr_execute");
    const result = await tool.handler({ businessId: "echo", request });

    expect(executeCalls).toEqual([{ businessId: "echo", request }]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "pending_confirmation",
    });
  });

  test("tool handler returns error content on SDK failure", async () => {
    const server = new MockMcpServer();

    registerTools(server as unknown as McpServer, () =>
      createMockClient({
        discover: async () => {
          throw new AgenrError("Forbidden", 403);
        },
      }),
    );

    const tool = getTool(server, "agenr_discover");
    const result = await tool.handler({ businessId: "echo" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agenr error (403): Forbidden");
  });
});
