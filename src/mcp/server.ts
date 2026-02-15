import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { once } from "node:events";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { recall } from "../db/recall.js";
import { storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import { KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import type { KnowledgeEntry, RecallResult, Scope, StoreResult } from "../types.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcErrorObject {
  code: number;
  message: string;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface ParsedRequest {
  id: JsonRpcId;
  hasId: boolean;
  method: string;
  params: unknown;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

interface ToolCallParams {
  name: string;
  args: Record<string, unknown>;
}

class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const KNOWLEDGE_TYPE_SET = new Set<string>(KNOWLEDGE_TYPES);
const SCOPE_LEVEL_SET = new Set<string>(SCOPE_LEVELS);

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "agenr_recall",
    description: "Retrieve relevant knowledge entries using semantic search.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "What to search for.",
          minLength: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results.",
          minimum: 1,
          default: 10,
        },
        types: {
          type: "string",
          description: "Comma-separated entry types to filter.",
        },
        since: {
          type: "string",
          description: "Only entries newer than this (ISO date or relative, e.g. 7d, 1m).",
        },
        threshold: {
          type: "number",
          description: "Minimum relevance score from 0.0 to 1.0.",
          minimum: 0,
          maximum: 1,
          default: 0,
        },
      },
    },
  },
  {
    name: "agenr_store",
    description: "Store new knowledge entries in the database.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["entries"],
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "type"],
            properties: {
              content: { type: "string", minLength: 1 },
              type: {
                type: "string",
                enum: [...KNOWLEDGE_TYPES],
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                default: 0.8,
              },
              source: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" },
              },
              scope: {
                type: "string",
                enum: [...SCOPE_LEVELS],
                default: "personal",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "agenr_extract",
    description: "Extract knowledge entries from raw text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "Raw text to extract knowledge from.",
        },
        store: {
          type: "boolean",
          default: false,
          description: "Whether to store extracted entries.",
        },
        source: {
          type: "string",
          description: "Optional source label for extracted entries.",
        },
      },
    },
  },
];

export interface McpServerDeps {
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  createLlmClientFn: typeof createLlmClient;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  recallFn: typeof recall;
  storeEntriesFn: typeof storeEntries;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  mkdtempFn: (prefix: string) => Promise<string>;
  writeFileFn: (filePath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  rmFn: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
  nowFn: () => Date;
  tmpdirFn: () => string;
}

export interface McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  verbose?: boolean;
  dbPath?: string;
  serverVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export interface McpServer {
  handleRequest: (request: unknown) => Promise<JsonRpcResponse | null>;
  startServer: () => Promise<void>;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isValidJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeErrorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function parseJsonRpcRequest(raw: unknown): ParsedRequest {
  if (!isRecord(raw)) {
    throw new RpcError(JSON_RPC_INVALID_REQUEST, "Invalid request");
  }

  if (raw.jsonrpc !== "2.0") {
    throw new RpcError(JSON_RPC_INVALID_REQUEST, "Invalid request");
  }

  if (typeof raw.method !== "string" || raw.method.trim().length === 0) {
    throw new RpcError(JSON_RPC_INVALID_REQUEST, "Invalid request");
  }

  const hasId = hasOwn(raw, "id");
  const idRaw = hasId ? raw.id : null;
  if (hasId && !isValidJsonRpcId(idRaw)) {
    throw new RpcError(JSON_RPC_INVALID_REQUEST, "Invalid request");
  }

  return {
    id: hasId ? (idRaw as JsonRpcId) : null,
    hasId,
    method: raw.method,
    params: hasOwn(raw, "params") ? raw.params : undefined,
  };
}

function parseInitializeParams(params: unknown): void {
  if (!isRecord(params)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (typeof params.protocolVersion !== "string" || params.protocolVersion.trim().length === 0) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (!isRecord(params.capabilities)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (!isRecord(params.clientInfo)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (typeof params.clientInfo.name !== "string" || params.clientInfo.name.trim().length === 0) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (typeof params.clientInfo.version !== "string" || params.clientInfo.version.trim().length === 0) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }
}

function parseToolCallParams(params: unknown): ToolCallParams {
  if (!isRecord(params)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (typeof params.name !== "string" || params.name.trim().length === 0) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  if (hasOwn(params, "arguments") && !isRecord(params.arguments)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid params");
  }

  return {
    name: params.name,
    args: isRecord(params.arguments) ? params.arguments : {},
  };
}

function parseCsvTypes(input: string | undefined): KnowledgeEntry["type"][] | undefined {
  if (!input) {
    return undefined;
  }

  const parsed = Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );

  if (parsed.length === 0) {
    return undefined;
  }

  for (const value of parsed) {
    if (!KNOWLEDGE_TYPE_SET.has(value)) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `Invalid type filter: ${value}`);
    }
  }

  return parsed as KnowledgeEntry["type"][];
}

function parsePositiveInt(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, `${fieldName} must be a positive number`);
  }

  return Math.floor(parsed);
}

function parseThreshold(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "threshold must be between 0.0 and 1.0");
  }
  return parsed;
}

function parseSinceToIso(since: string | undefined, now: Date): string | undefined {
  if (!since) {
    return undefined;
  }

  const trimmed = since.trim();
  if (!trimmed) {
    return undefined;
  }

  const durationMatch = trimmed.match(/^(\d+)\s*([hdmy])$/i);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0 || !unit) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid since value");
    }

    let multiplier = 0;
    if (unit === "h") {
      multiplier = 1000 * 60 * 60;
    } else if (unit === "d") {
      multiplier = 1000 * 60 * 60 * 24;
    } else if (unit === "m") {
      multiplier = 1000 * 60 * 60 * 24 * 30;
    } else if (unit === "y") {
      multiplier = 1000 * 60 * 60 * 24 * 365;
    }

    if (multiplier <= 0) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid since value");
    }

    return new Date(now.getTime() - amount * multiplier).toISOString();
  }

  const parsedDate = new Date(trimmed);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid since value");
  }

  return parsedDate.toISOString();
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  );
}

function parseScope(value: unknown): Scope {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return "personal";
  }

  if (typeof value !== "string") {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "scope must be a string");
  }

  const normalized = value.trim().toLowerCase();
  if (!SCOPE_LEVEL_SET.has(normalized)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, `Invalid scope: ${value}`);
  }

  return normalized as Scope;
}

function confidenceLevelFromScore(score: number): KnowledgeEntry["confidence"] {
  if (score >= 0.8) {
    return "high";
  }
  if (score >= 0.5) {
    return "medium";
  }
  return "low";
}

function inferSubject(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "memory";
  }

  const firstClause = trimmed.split(/[.!?]/)[0] ?? trimmed;
  const words = firstClause.split(/\s+/).filter((word) => word.length > 0).slice(0, 6);
  const candidate = words.join(" ");
  return candidate.slice(0, 80) || "memory";
}

function parseStoreEntries(rawEntries: unknown): KnowledgeEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "entries must be an array");
  }

  return rawEntries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `entries[${index}] must be an object`);
    }

    const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
    if (!type || !KNOWLEDGE_TYPE_SET.has(type)) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `entries[${index}].type is invalid`);
    }

    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `entries[${index}].content is required`);
    }

    const confidenceRaw = raw.confidence === undefined ? 0.8 : Number(raw.confidence);
    if (!Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `entries[${index}].confidence must be between 0.0 and 1.0`);
    }

    const source = typeof raw.source === "string" && raw.source.trim().length > 0 ? raw.source.trim() : "mcp:agenr_store";
    const subject =
      typeof raw.subject === "string" && raw.subject.trim().length > 0 ? raw.subject.trim() : inferSubject(content);
    const scope = parseScope(raw.scope);

    return {
      type: type as KnowledgeEntry["type"],
      subject,
      content,
      confidence: confidenceLevelFromScore(confidenceRaw),
      expiry: "temporary",
      tags: normalizeTags(raw.tags),
      scope,
      source: {
        file: source,
        context: "stored via MCP tool",
      },
    };
  });
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "unknown-date";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown-date";
  }
  return parsed.toISOString().slice(0, 10);
}

function formatRecallText(query: string, results: RecallResult[]): string {
  if (results.length === 0) {
    return `Found 0 results for "${query}".`;
  }

  const lines: string[] = [`Found ${results.length} results for "${query}":`, ""];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) {
      continue;
    }
    lines.push(
      `[${i + 1}] (score: ${result.score.toFixed(3)}, type: ${result.entry.type}, ${formatDate(result.entry.created_at)})`,
    );
    lines.push(result.entry.content);
    if (i < results.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatStoreSummary(result: StoreResult): string {
  const total = result.added + result.updated + result.skipped;
  return `Stored ${total} entries (${result.added} new, ${result.updated} updated, ${result.skipped} duplicates skipped).`;
}

function formatExtractedText(entries: KnowledgeEntry[], stored?: StoreResult): string {
  const lines: string[] = [`Extracted ${entries.length} entries from text:`, ""];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    lines.push(`[${i + 1}] (${entry.type}) ${entry.content}`);
  }

  if (stored) {
    lines.push("");
    lines.push(`Stored: ${stored.added} new, ${stored.updated} updated, ${stored.skipped} duplicates skipped.`);
  }

  return lines.join("\n");
}

function extractIdForError(raw: unknown): JsonRpcId {
  if (!isRecord(raw) || !hasOwn(raw, "id")) {
    return null;
  }
  return isValidJsonRpcId(raw.id) ? raw.id : null;
}

export async function readLine(iterator: AsyncIterator<string>): Promise<string | null> {
  const next = await iterator.next();
  if (next.done) {
    return null;
  }
  return next.value;
}

export async function writeLine(output: NodeJS.WritableStream, payload: JsonRpcResponse): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;
  if (output.write(line)) {
    return;
  }
  await once(output, "drain");
}

export function createMcpServer(
  options: McpServerOptions = {},
  deps: Partial<McpServerDeps> = {},
): McpServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const verbose = options.verbose === true;
  const env = options.env ?? process.env;
  const serverVersion = options.serverVersion ?? "0.1.0";

  const resolvedDeps: McpServerDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    createLlmClientFn: deps.createLlmClientFn ?? createLlmClient,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    recallFn: deps.recallFn ?? recall,
    storeEntriesFn: deps.storeEntriesFn ?? storeEntries,
    parseTranscriptFileFn: deps.parseTranscriptFileFn ?? parseTranscriptFile,
    extractKnowledgeFromChunksFn: deps.extractKnowledgeFromChunksFn ?? extractKnowledgeFromChunks,
    mkdtempFn: deps.mkdtempFn ?? ((prefix: string) => fs.mkdtemp(prefix)),
    writeFileFn:
      deps.writeFileFn ??
      ((filePath: string, data: string, encoding: BufferEncoding) => fs.writeFile(filePath, data, encoding)),
    rmFn: deps.rmFn ?? ((targetPath: string, options: { recursive?: boolean; force?: boolean }) => fs.rm(targetPath, options)),
    nowFn: deps.nowFn ?? (() => new Date()),
    tmpdirFn: deps.tmpdirFn ?? os.tmpdir,
  };

  let dbClient: Client | null = null;
  let dbInitPromise: Promise<void> | null = null;
  let isInitialized = false;
  let isStopped = false;
  let lineReader: readline.Interface | null = null;

  function log(line: string): void {
    errorOutput.write(`${line}\n`);
  }

  async function ensureDb(): Promise<Client> {
    if (!dbClient) {
      dbClient = resolvedDeps.getDbFn(options.dbPath);
    }

    if (!dbInitPromise) {
      dbInitPromise = resolvedDeps
        .initDbFn(dbClient)
        .catch((error: unknown) => {
          dbInitPromise = null;
          throw error;
        });
    }

    await dbInitPromise;
    return dbClient;
  }

  function closeDbIfOpen(): void {
    if (dbClient) {
      resolvedDeps.closeDbFn(dbClient);
      dbClient = null;
      dbInitPromise = null;
    }
  }

  function buildSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  async function callRecallTool(args: Record<string, unknown>): Promise<string> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "query is required");
    }

    const limit = parsePositiveInt(args.limit, 10, "limit");
    const threshold = parseThreshold(args.threshold);
    const types =
      typeof args.types === "string" && args.types.trim().length > 0 ? parseCsvTypes(args.types) : undefined;
    const since =
      typeof args.since === "string" && args.since.trim().length > 0
        ? parseSinceToIso(args.since, resolvedDeps.nowFn())
        : undefined;

    const db = await ensureDb();
    const config = resolvedDeps.readConfigFn(env);
    const apiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, env);

    const results = await resolvedDeps.recallFn(
      db,
      {
        text: query,
        limit,
        types,
        since,
      },
      apiKey,
    );

    const filtered = results.filter((result) => result.score >= threshold);
    return formatRecallText(query, filtered);
  }

  async function callStoreTool(args: Record<string, unknown>): Promise<string> {
    if (!hasOwn(args, "entries")) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "entries is required");
    }

    const entries = parseStoreEntries(args.entries);
    const db = await ensureDb();
    const config = resolvedDeps.readConfigFn(env);
    const apiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, env);
    const result = await resolvedDeps.storeEntriesFn(db, entries, apiKey, {
      sourceFile: "mcp:agenr_store",
    });

    return formatStoreSummary(result);
  }

  async function callExtractTool(args: Record<string, unknown>): Promise<string> {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "text is required");
    }

    const shouldStore = args.store === true;
    const sourceLabel =
      typeof args.source === "string" && args.source.trim().length > 0 ? args.source.trim() : undefined;

    const tempDir = await resolvedDeps.mkdtempFn(path.join(resolvedDeps.tmpdirFn(), "agenr-mcp-"));
    const tempFile = path.join(tempDir, "input.txt");

    try {
      await resolvedDeps.writeFileFn(tempFile, text, "utf8");

      const parsed = await resolvedDeps.parseTranscriptFileFn(tempFile);
      const config = resolvedDeps.readConfigFn(env);
      const client = resolvedDeps.createLlmClientFn({ config, env });
      const extraction = await resolvedDeps.extractKnowledgeFromChunksFn({
        file: tempFile,
        chunks: parsed.chunks,
        client,
        verbose: false,
      });

      const extractedEntries = extraction.entries.map((entry) => ({
        ...entry,
        scope: entry.scope ?? "personal",
        source: {
          file: sourceLabel ?? entry.source.file,
          context: entry.source.context,
        },
      }));

      let stored: StoreResult | undefined;
      if (shouldStore && extractedEntries.length > 0) {
        const db = await ensureDb();
        const apiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, env);
        stored = await resolvedDeps.storeEntriesFn(db, extractedEntries, apiKey, {
          sourceFile: sourceLabel ?? "mcp:agenr_extract",
        });
      } else if (shouldStore) {
        stored = {
          added: 0,
          updated: 0,
          skipped: 0,
          relations_created: 0,
          total_entries: 0,
          duration_ms: 0,
        };
      }

      return formatExtractedText(extractedEntries, stored);
    } finally {
      await resolvedDeps.rmFn(tempDir, { recursive: true, force: true });
    }
  }

  async function dispatchToolCall(params: ToolCallParams): Promise<ToolCallResult> {
    try {
      if (params.name === "agenr_recall") {
        return {
          content: [{ type: "text", text: await callRecallTool(params.args) }],
        };
      }

      if (params.name === "agenr_store") {
        return {
          content: [{ type: "text", text: await callStoreTool(params.args) }],
        };
      }

      if (params.name === "agenr_extract") {
        return {
          content: [{ type: "text", text: await callExtractTool(params.args) }],
        };
      }

      throw new RpcError(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }

      return {
        content: [{ type: "text", text: `Tool failed: ${toErrorMessage(error)}` }],
        isError: true,
      };
    }
  }

  async function handleRequest(request: unknown): Promise<JsonRpcResponse | null> {
    const parsed = parseJsonRpcRequest(request);

    let result: unknown;

    if (parsed.method === "initialize") {
      parseInitializeParams(parsed.params);
      result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "agenr",
          version: serverVersion,
        },
      };
    } else if (parsed.method === "notifications/initialized" || parsed.method === "initialized") {
      isInitialized = true;
      if (!parsed.hasId) {
        return null;
      }
      result = {};
    } else if (parsed.method === "tools/list") {
      result = {
        tools: TOOL_DEFINITIONS,
      };
    } else if (parsed.method === "tools/call") {
      const toolCallParams = parseToolCallParams(parsed.params);
      result = await dispatchToolCall(toolCallParams);
    } else if (parsed.method === "ping") {
      result = {};
    } else {
      throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, "Method not found");
    }

    if (!parsed.hasId) {
      return null;
    }

    return buildSuccess(parsed.id, result);
  }

  async function startServer(): Promise<void> {
    lineReader = readline.createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });

    const iterator = lineReader[Symbol.asyncIterator]();

    try {
      while (!isStopped) {
        const line = await readLine(iterator);
        if (line === null) {
          break;
        }

        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (verbose) {
          log(`[mcp] <= ${trimmed}`);
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(trimmed);
        } catch {
          const parseError = makeErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error");
          await writeLine(output, parseError);
          if (verbose) {
            log(`[mcp] => ${JSON.stringify(parseError)}`);
          }
          continue;
        }

        const idForError = extractIdForError(parsedJson);
        try {
          const response = await handleRequest(parsedJson);
          if (!response) {
            continue;
          }
          await writeLine(output, response);
          if (verbose) {
            log(`[mcp] => ${JSON.stringify(response)}`);
          }
        } catch (error) {
          const normalized =
            error instanceof RpcError
              ? makeErrorResponse(idForError, error.code, error.message)
              : makeErrorResponse(idForError, JSON_RPC_INTERNAL_ERROR, "Internal error");
          await writeLine(output, normalized);
          if (verbose) {
            log(`[mcp] => ${JSON.stringify(normalized)}`);
          }
        }
      }
    } finally {
      lineReader?.close();
      lineReader = null;
      if (isInitialized) {
        // Kept for MCP lifecycle visibility and potential future hooks.
      }
      closeDbIfOpen();
    }
  }

  async function stop(): Promise<void> {
    isStopped = true;
    lineReader?.close();
    closeDbIfOpen();
  }

  return {
    handleRequest,
    startServer,
    stop,
  };
}
