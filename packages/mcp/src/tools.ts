import { AgenrClient, AgenrError } from "@agenr/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type JsonObject = Record<string, unknown>;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type DiscoverInput = { businessId: string };
type QueryInput = { businessId: string; request: JsonObject };
type ExecuteInput = { businessId: string; request: JsonObject };
type StatusInput = { transactionId: string };

type AgenrClientLike = Pick<AgenrClient, "discover" | "query" | "execute" | "status">;

export type CreateClient = () => AgenrClientLike;

type ToolDefinition<TInput extends JsonObject> = {
  description: string;
  inputSchema: JsonObject;
  handler: (input: TInput) => Promise<ToolResult>;
};

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createClient(): AgenrClient {
  return new AgenrClient({
    apiKey: readEnv("AGENR_API_KEY"),
    baseUrl: readEnv("AGENR_BASE_URL"),
  });
}

function toSuccessResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function toErrorResult(error: unknown): ToolResult {
  const message =
    error instanceof AgenrError
      ? `Agenr error (${error.statusCode}): ${error.message}`
      : error instanceof Error
        ? error.message
        : "Unknown error";

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRequest(request: unknown): JsonObject | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return null;
  }

  return request as JsonObject;
}

function registerTool<TInput extends JsonObject>(
  server: McpServer,
  name: string,
  definition: ToolDefinition<TInput>,
): void {
  const serverCompat = server as unknown as {
    registerTool?: (
      toolName: string,
      config: { description: string; inputSchema: JsonObject },
      handler: (input: TInput) => Promise<ToolResult>,
    ) => void;
    tool?: (
      toolName: string,
      description: string,
      inputSchema: JsonObject,
      handler: (input: TInput) => Promise<ToolResult>,
    ) => void;
  };

  if (typeof serverCompat.registerTool === "function") {
    serverCompat.registerTool(name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, definition.handler);
    return;
  }

  if (typeof serverCompat.tool === "function") {
    serverCompat.tool(name, definition.description, definition.inputSchema, definition.handler);
    return;
  }

  throw new Error("Unsupported MCP server: missing registerTool/tool API");
}

export function registerTools(server: McpServer, createClientFn: CreateClient = createClient): void {
  const client = createClientFn();

  registerTool<DiscoverInput>(server, "agenr_discover", {
    description: "Learn what a business can do. Call this first.",
    inputSchema: {
      type: "object",
      properties: {
        businessId: {
          type: "string",
          description: "Business identifier (e.g. 'echo')",
        },
      },
      required: ["businessId"],
    },
    handler: async (input) => {
      const businessId = normalizeNonEmptyString(input.businessId);
      if (!businessId) {
        return toErrorResult(new Error("businessId is required"));
      }

      try {
        const result = await client.discover(businessId);
        return toSuccessResult(result.data);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  });

  registerTool<QueryInput>(server, "agenr_query", {
    description: "Query a business for data (products, menus, availability).",
    inputSchema: {
      type: "object",
      properties: {
        businessId: {
          type: "string",
          description: "Business identifier",
        },
        request: {
          type: "object",
          description: "Query parameters (see discover hints for shape)",
        },
      },
      required: ["businessId", "request"],
    },
    handler: async (input) => {
      const businessId = normalizeNonEmptyString(input.businessId);
      const request = normalizeRequest(input.request);

      if (!businessId) {
        return toErrorResult(new Error("businessId is required"));
      }

      if (!request) {
        return toErrorResult(new Error("request must be an object"));
      }

      try {
        const result = await client.query(businessId, request);
        return toSuccessResult(result.data);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  });

  registerTool<ExecuteInput>(server, "agenr_execute", {
    description:
      "Take action at a business (order, pay, book). May return a confirmationToken -- present the summary to the user and call again with the token to confirm.",
    inputSchema: {
      type: "object",
      properties: {
        businessId: {
          type: "string",
          description: "Business identifier",
        },
        request: {
          type: "object",
          description: "Action parameters. Include confirmationToken to confirm a pending order.",
        },
      },
      required: ["businessId", "request"],
    },
    handler: async (input) => {
      const businessId = normalizeNonEmptyString(input.businessId);
      const request = normalizeRequest(input.request);

      if (!businessId) {
        return toErrorResult(new Error("businessId is required"));
      }

      if (!request) {
        return toErrorResult(new Error("request must be an object"));
      }

      try {
        const result = await client.execute(businessId, request);
        return toSuccessResult(result.data);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  });

  registerTool<StatusInput>(server, "agenr_status", {
    description: "Check status of a pending transaction.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: {
          type: "string",
          description: "Transaction ID from a previous execute",
        },
      },
      required: ["transactionId"],
    },
    handler: async (input) => {
      const transactionId = normalizeNonEmptyString(input.transactionId);
      if (!transactionId) {
        return toErrorResult(new Error("transactionId is required"));
      }

      try {
        const result = await client.status(transactionId);
        return toSuccessResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  });
}
