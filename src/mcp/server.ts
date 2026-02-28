import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { once } from "node:events";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { recall, updateRecallMetadata } from "../db/recall.js";
import { retireEntries } from "../db/retirements.js";
import { sessionStartRecall } from "../db/session-start.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import { KNOWLEDGE_PLATFORMS, KNOWLEDGE_TYPES } from "../types.js";
import type { KnowledgeEntry, RecallResult } from "../types.js";
import { APP_VERSION } from "../version.js";
import { normalizeKnowledgePlatform } from "../platform.js";
import { normalizeProject } from "../project.js";
import { parseSinceToIso } from "../utils/time.js";

async function appendMcpLog(line: Record<string, unknown>): Promise<void> {
  try {
    const logPath = path.join(os.homedir(), ".agenr", "mcp-access.log");
    const entry = JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n";
    await fs.appendFile(logPath, entry, "utf8");
  } catch {
    // Never let logging failures affect MCP responses. Success-only logging
    // is intentional - errors and throws are not logged here.
  }
}

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

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "agenr_recall",
    description: "Retrieve relevant knowledge entries using semantic search.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "What to search for.",
          minLength: 1,
        },
        context: {
          type: "string",
          description:
            "Recall context. Use 'session-start' for fast bootstrap (no query needed). Use 'browse' for temporal browsing sorted by date+importance without semantic search (no query needed, zero API calls).",
          enum: ["default", "session-start", "browse"],
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
        until: {
          type: "string",
          description:
            "Only entries created before this point in time (ISO date or relative, e.g. 7d = entries older than 7 days). Use with since for a date range: since sets the lower bound, until the upper bound.",
        },
        around: {
          type: "string",
          description:
            "Bias recall toward a specific date. Entries closer to this date rank higher. ISO date or relative (e.g. 7d = 7 days ago).",
        },
        aroundRadius: {
          type: "integer",
          description: "Window radius in days for around targeting (default: 14).",
          minimum: 1,
        },
        threshold: {
          type: "number",
          description: "Minimum relevance score from 0.0 to 1.0.",
          minimum: 0,
          maximum: 1,
          default: 0,
        },
        platform: {
          type: "string",
          description: "Optional platform filter: openclaw, claude-code, codex.",
        },
        project: {
          type: "string",
          description:
            "Omit to use configured project scope (including dependencies). Pass * to return all projects regardless of scope.",
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
        source: {
          type: "string",
          description: "Optional source label for extracted entries.",
        },
      },
    },
  },
  {
    name: "agenr_retire",
    description:
      "Mark one or more memory entries as retired (soft delete). Pass ids as a comma-separated string or array. Retired entries are excluded from all recall.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["entry_id"],
      properties: {
        entry_id: {
          type: "string",
          description: "Entry id to retire.",
        },
        reason: {
          type: "string",
          description: "Retirement reason.",
        },
        persist: {
          type: "boolean",
          description: "Persist retirement to ledger for re-ingest safety.",
          default: false,
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
  updateRecallMetadataFn: typeof updateRecallMetadata;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  retireEntriesFn: typeof retireEntries;
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

function parseCsvProjects(input: string): string[] {
  const parsed = Array.from(
    new Set(
      input
        .split(",")
        .map((value) => normalizeProject(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  if (parsed.some((value) => value === "*")) {
    throw new RpcError(JSON_RPC_INVALID_PARAMS, "project=\"*\" must be passed by itself");
  }

  return parsed;
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
      `[${i + 1}] [id=${result.entry.id}] (score: ${result.score.toFixed(3)}, type: ${result.entry.type}, ${formatDate(result.entry.created_at)})`,
    );
    lines.push(result.entry.content);
    if (i < results.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatBrowseText(results: RecallResult[]): string {
  if (results.length === 0) {
    return "No entries found in the specified time window.";
  }

  const lines: string[] = [`Found ${results.length} entries (browse mode):`, ""];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) {
      continue;
    }
    const dateStr = new Date(result.entry.created_at).toISOString().slice(0, 10);
    lines.push(
      `[${i + 1}] [id=${result.entry.id}] [${dateStr}] importance=${result.entry.importance} type=${result.entry.type}`,
    );
    lines.push(result.entry.content);
    if (i < results.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatExtractedText(entries: KnowledgeEntry[]): string {
  const lines: string[] = [`Extracted ${entries.length} entries from text:`, ""];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    lines.push(`[${i + 1}] (${entry.type}) ${entry.content}`);
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
  const serverVersion = options.serverVersion ?? APP_VERSION;

  const resolvedDeps: McpServerDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    createLlmClientFn: deps.createLlmClientFn ?? createLlmClient,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    recallFn: deps.recallFn ?? recall,
    updateRecallMetadataFn: deps.updateRecallMetadataFn ?? updateRecallMetadata,
    retireEntriesFn: deps.retireEntriesFn ?? retireEntries,
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
  const scopedProjectDirRaw = typeof env.AGENR_PROJECT_DIR === "string" ? env.AGENR_PROJECT_DIR.trim() : "";
  const scopedProjectDir = scopedProjectDirRaw ? path.resolve(scopedProjectDirRaw) : null;

  let dbClient: Client | null = null;
  let dbInitPromise: Promise<void> | null = null;
  let isStopped = false;
  let lineReader: readline.Interface | null = null;

  function log(line: string): void {
    errorOutput.write(`${line}\n`);
  }

  if (!scopedProjectDir) {
    log("warn: AGENR_PROJECT_DIR not set -- recall will return global (unscoped) results. Run agenr init to configure project scoping.");
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

  // Intentionally reads config.json on every call (no caching).
  // This is a feature: dependency changes via `agenr init --depends-on`
  // take effect immediately without restarting the MCP server.
  // Per-call filesystem reads are sub-millisecond on local disk.
  async function loadScopedProjectConfig(): Promise<{ project: string; dependencies: string[] } | null> {
    if (!scopedProjectDir) {
      return null;
    }

    const configPath = path.join(scopedProjectDir, ".agenr", "config.json");
    let rawConfig = "";
    try {
      rawConfig = await fs.readFile(configPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConfig);
    } catch {
      return null;
    }

    if (!isRecord(parsed)) {
      return null;
    }

    const projectRaw = typeof parsed.project === "string" ? parsed.project : "";
    const project = normalizeProject(projectRaw);
    if (!project) {
      return null;
    }

    const dependencies = Array.isArray(parsed.dependencies)
      ? Array.from(
          new Set(
            parsed.dependencies
              .filter((value): value is string => typeof value === "string")
              .map((value) => normalizeProject(value))
              .filter((value): value is string => Boolean(value))
              .filter((value) => value !== project),
          ),
        )
      : [];

    return { project, dependencies };
  }

  function buildSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  async function callRecallTool(args: Record<string, unknown>): Promise<string> {
    const contextRaw = typeof args.context === "string" ? args.context.trim().toLowerCase() : "default";
    const context = contextRaw || "default";
    if (context !== "default" && context !== "session-start" && context !== "browse") {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "context must be one of: default, session-start, browse");
    }

    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query && context === "default") {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "query is required unless context is session-start or browse");
    }

    const limit = parsePositiveInt(args.limit, 10, "limit");
    const threshold = parseThreshold(args.threshold);
    const now = resolvedDeps.nowFn();
    const types =
      typeof args.types === "string" && args.types.trim().length > 0 ? parseCsvTypes(args.types) : undefined;
    let since: string | undefined;
    if (typeof args.since === "string" && args.since.trim().length > 0) {
      try {
        since = parseSinceToIso(args.since, now);
      } catch {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid since value");
      }
    }
    let until: string | undefined;
    if (typeof args.until === "string" && args.until.trim().length > 0) {
      try {
        until = parseSinceToIso(args.until, now);
      } catch {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid until value");
      }
    }
    let around: string | undefined;
    if (typeof args.around === "string" && args.around.trim().length > 0) {
      try {
        around = parseSinceToIso(args.around, now);
      } catch {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, "Invalid around value");
      }
    }
    const aroundRadius = typeof args.aroundRadius === "number" ? args.aroundRadius : undefined;
    if (aroundRadius !== undefined && (!Number.isInteger(aroundRadius) || aroundRadius < 1)) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "aroundRadius must be a positive integer (days)");
    }
    const platformRaw = typeof args.platform === "string" ? args.platform.trim() : "";
    const platform = platformRaw ? normalizeKnowledgePlatform(platformRaw) : null;
    if (platformRaw && !platform) {
      throw new RpcError(
        JSON_RPC_INVALID_PARAMS,
        `platform must be one of: ${KNOWLEDGE_PLATFORMS.join(", ")}`,
      );
    }

    const projectRaw = typeof args.project === "string" ? args.project.trim() : "";
    let project: string[] | undefined;
    let projectStrict = false;

    if (projectRaw === "*") {
      project = undefined;
    } else if (projectRaw) {
      project = parseCsvProjects(projectRaw);
      if (project.length === 0) {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, "project must be a non-empty string");
      }
      projectStrict = true;
    } else {
      const scoped = await loadScopedProjectConfig();
      if (scoped) {
        project = Array.from(new Set([scoped.project, ...scoped.dependencies]));
        projectStrict = true;
      } else {
        // No AGENR_PROJECT_DIR and no explicit project= param.
        // Fall back to global (unscoped) recall. This is intentional for
        // backward compatibility with single-project setups.
      }
    }

    const db = await ensureDb();
    let results: RecallResult[];

    if (context === "browse") {
      results = await resolvedDeps.recallFn(
        db,
        {
          text: undefined,
          context: "browse",
          browse: true,
          limit,
          types,
          since,
          until,
          around,
          aroundRadius,
          platform: platform ?? undefined,
          project,
          projectStrict: projectStrict ? true : undefined,
          scope: "private",
          noUpdate: true,
        },
        "",
      );
    } else if (context === "session-start") {
      const grouped = await sessionStartRecall(db, {
        query: {
          context,
          text: undefined,
          limit,
          types,
          since,
          until,
          around,
          aroundRadius,
          platform: platform ?? undefined,
          project,
          projectStrict: projectStrict ? true : undefined,
          noUpdate: true,
        },
        apiKey: "",
        recallFn: resolvedDeps.recallFn,
        nonCoreLimit: limit,
      });
      results = grouped.results;
    } else {
      const apiKey = resolvedDeps.resolveEmbeddingApiKeyFn(resolvedDeps.readConfigFn(env), env);
      results = await resolvedDeps.recallFn(
        db,
        {
          text: query || undefined,
          context,
          limit,
          types,
          since,
          until,
          around,
          aroundRadius,
          platform: platform ?? undefined,
          project,
          projectStrict: projectStrict ? true : undefined,
        },
        apiKey,
      );
    }

    const filtered = results.filter((result) => result.score >= threshold);
    if (context === "session-start" && filtered.length > 0) {
      const ids = filtered.map((result) => result.entry.id);
      await resolvedDeps.updateRecallMetadataFn(db, ids, now);
      const nowIso = now.toISOString();
      for (const result of filtered) {
        result.entry.recall_count += 1;
        result.entry.last_recalled_at = nowIso;
      }
    }
    if (context === "browse") {
      return formatBrowseText(filtered);
    }
    return formatRecallText(query || context, filtered);
  }

  async function callExtractTool(args: Record<string, unknown>): Promise<string> {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "text is required");
    }

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
        messages: parsed.messages,
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

      return formatExtractedText(extractedEntries);
    } finally {
      await resolvedDeps.rmFn(tempDir, { recursive: true, force: true });
    }
  }

  async function callRetireTool(args: Record<string, unknown>): Promise<string> {
    const entryId = typeof args.entry_id === "string" ? args.entry_id.trim() : "";
    if (!entryId) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, "entry_id is required");
    }

    const reason = typeof args.reason === "string" && args.reason.trim().length > 0 ? args.reason.trim() : undefined;
    const persist = args.persist === true;
    const db = await ensureDb();

    const lookup = await db.execute({
      sql: `
        SELECT id, subject, type, importance
        FROM entries
        WHERE id = ?
          AND retired = 0
        LIMIT 1
      `,
      args: [entryId],
    });

    const row = lookup.rows[0] as { subject?: unknown; type?: unknown } | undefined;
    if (!row) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `No active entry found with id: ${entryId}`);
    }

    const subject = typeof row.subject === "string" ? row.subject : String(row.subject ?? "");
    const type = typeof row.type === "string" ? row.type : String(row.type ?? "");

    const retired = await resolvedDeps.retireEntriesFn({
      entryId,
      subjectPattern: persist ? subject : undefined,
      matchType: "exact",
      reason,
      writeLedger: persist,
      db,
      dbPath: options.dbPath,
    });

    if (retired.count === 0) {
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `No active entry found with id: ${entryId}`);
    }

    const messageBase = `Retired: ${subject} (type: ${type}). Entry is hidden from all recall (session-start and explicit queries).`;
    const text = persist ? `${messageBase} Retirement will survive database re-ingest.` : messageBase;
    return text;
  }

  async function dispatchToolCall(params: ToolCallParams): Promise<ToolCallResult> {
    try {
      if (params.name === "agenr_recall") {
        const result = await callRecallTool(params.args);
        await appendMcpLog({
          tool: "agenr_recall",
          query: typeof params.args.query === "string" ? (params.args.query as string).slice(0, 120) : undefined,
          context: typeof params.args.context === "string" ? (params.args.context as string) : undefined,
          project: typeof params.args.project === "string" ? (params.args.project as string) : undefined,
        });
        return {
          content: [{ type: "text", text: result }],
        };
      }

      if (params.name === "agenr_extract") {
        return {
          content: [{ type: "text", text: await callExtractTool(params.args) }],
        };
      }

      if (params.name === "agenr_retire") {
        return {
          content: [{ type: "text", text: await callRetireTool(params.args) }],
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
    // Fail fast: check for embedding API key on startup
    try {
      const startupConfig = await resolvedDeps.readConfigFn();
      resolvedDeps.resolveEmbeddingApiKeyFn(startupConfig, env);
    } catch {
      log("[mcp] ERROR: OPENAI_API_KEY is required for embeddings but was not found.");
      log("[mcp] Set it via environment variable or run: agenr setup");
      log("[mcp] If using MCP, add it to your MCP server config env block.");
      process.exitCode = 1;
      return;
    }

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
