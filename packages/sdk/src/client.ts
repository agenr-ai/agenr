import { AgenrError } from "./errors";
import type {
  AgpOperation,
  AgpResponse,
  AgpTransaction,
  AgenrConfig,
  ExecuteOptions,
  PrepareResponse,
  TransactionStatus,
} from "./types";

type HttpMethod = "GET" | "POST";

type ResponseFallback = Partial<Pick<AgpResponse, "id" | "operation" | "businessId">>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgpOperation(value: string | undefined): value is AgpOperation {
  return value === "discover" || value === "query" || value === "execute";
}

function isTransactionStatus(value: string | undefined): value is TransactionStatus {
  return value === "pending" || value === "succeeded" || value === "failed";
}

const DEFAULT_BASE_URL = "https://api.agenr.ai";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export class AgenrClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;

  constructor(config: AgenrConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = config.apiKey;
    this.headers = config.headers ?? {};

    if (!this.baseUrl) {
      throw new Error("AgenrClient requires a valid baseUrl");
    }
  }

  discover<T = unknown>(businessId: string): Promise<AgpResponse<T>> {
    return this.callOperation<T>("discover", businessId);
  }

  query<T = unknown>(businessId: string, request: Record<string, unknown>): Promise<AgpResponse<T>> {
    return this.callOperation<T>("query", businessId, request);
  }

  execute<T = unknown>(
    businessId: string,
    request: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<AgpResponse<T>> {
    const requestHeaders: Record<string, string> = {};

    if (options?.confirmationToken) {
      requestHeaders["x-confirmation-token"] = options.confirmationToken;
    }

    if (options?.idempotencyKey) {
      requestHeaders["idempotency-key"] = options.idempotencyKey;
    }

    return this.callOperation<T>("execute", businessId, request, requestHeaders);
  }

  async prepare<T = unknown>(businessId: string, request: Record<string, unknown>): Promise<PrepareResponse> {
    if (!businessId || !businessId.trim()) {
      throw new Error("prepare() requires a businessId");
    }

    const normalizedBusinessId = businessId.trim();
    const response = await this.requestJson("POST", "/agp/execute/prepare", {
      businessId: normalizedBusinessId,
      request,
    });

    return this.toPrepareResponse(response);
  }

  async status<T = unknown>(transactionId: string): Promise<AgpTransaction<T>> {
    if (!transactionId || !transactionId.trim()) {
      throw new Error("status() requires a transactionId");
    }

    const response = await this.requestJson("GET", `/agp/status/${encodeURIComponent(transactionId)}`);
    return this.toAgpResponse<T>(response, { id: transactionId.trim() });
  }

  private async callOperation<T = unknown>(
    operation: AgpOperation,
    businessId: string,
    request?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<AgpResponse<T>> {
    if (!businessId || !businessId.trim()) {
      throw new Error(`${operation}() requires a businessId`);
    }

    const normalizedBusinessId = businessId.trim();
    const body = request === undefined ? { businessId: normalizedBusinessId } : { businessId: normalizedBusinessId, request };

    const response = await this.requestJson("POST", `/agp/${operation}`, body, headers);
    return this.toAgpResponse<T>(response, { operation, businessId: normalizedBusinessId });
  }

  private async requestJson(
    method: HttpMethod,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const requestInit: RequestInit = {
      method,
      headers: this.buildHeaders(extraHeaders),
    };

    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, requestInit);
    } catch (error) {
      throw new AgenrError("Network request failed", 0, error);
    }

    const parsed = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw this.toHttpError(response.status, parsed);
    }

    return parsed;
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...this.headers,
      ...extraHeaders,
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();

    if (!text) {
      throw new AgenrError("Expected JSON response body", response.status);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AgenrError("Failed to parse JSON response", response.status, text);
    }
  }

  private toHttpError(statusCode: number, response: unknown): AgenrError {
    const message = this.extractErrorMessage(response) ?? `Request failed with status ${statusCode}`;
    const transactionId = this.extractTransactionId(response);

    return new AgenrError(message, statusCode, response, transactionId);
  }

  private extractErrorMessage(response: unknown): string | undefined {
    if (!isObject(response)) {
      return undefined;
    }

    const error = response.error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }

    const message = response.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }

    return undefined;
  }

  private extractTransactionId(response: unknown): string | undefined {
    if (!isObject(response)) {
      return undefined;
    }

    const id = response.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }

    const transactionId = response.transactionId;
    if (typeof transactionId === "string" && transactionId.length > 0) {
      return transactionId;
    }

    return undefined;
  }

  private toAgpResponse<T = unknown>(response: unknown, fallback: ResponseFallback = {}): AgpResponse<T> {
    if (!isObject(response)) {
      throw new AgenrError("Invalid AGP response: expected JSON object", 200, response, fallback.id);
    }

    const id = this.readString(response, "id") ?? this.readString(response, "transactionId") ?? fallback.id;
    if (!id) {
      throw new AgenrError("Invalid AGP response: missing transaction ID", 200, response);
    }

    const operationValue = this.readString(response, "operation") ?? fallback.operation;
    if (!isAgpOperation(operationValue)) {
      throw new AgenrError("Invalid AGP response: missing or invalid operation", 200, response, id);
    }

    const businessId = this.readString(response, "businessId") ?? fallback.businessId;
    if (!businessId) {
      throw new AgenrError("Invalid AGP response: missing businessId", 200, response, id);
    }

    const statusValue = this.readString(response, "status");
    if (!isTransactionStatus(statusValue)) {
      throw new AgenrError("Invalid AGP response: missing or invalid status", 200, response, id);
    }

    const now = new Date().toISOString();
    const createdAt = this.readString(response, "createdAt") ?? now;
    const updatedAt = this.readString(response, "updatedAt") ?? now;
    const data = (response.data ?? response.result ?? null) as T;
    const error = this.readString(response, "error");

    return {
      id,
      operation: operationValue,
      businessId,
      status: statusValue,
      createdAt,
      updatedAt,
      data,
      ...(error ? { error } : {}),
    };
  }

  private toPrepareResponse(response: unknown): PrepareResponse {
    if (!isObject(response)) {
      throw new AgenrError("Invalid prepare response: expected JSON object", 200, response);
    }

    const confirmationToken = this.readString(response, "confirmationToken");
    const expiresAt = this.readString(response, "expiresAt");
    const summary = this.readString(response, "summary");

    if (!confirmationToken || !expiresAt || !summary) {
      throw new AgenrError("Invalid prepare response: missing required fields", 200, response);
    }

    return {
      confirmationToken,
      expiresAt,
      summary,
    };
  }

  private readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  }
}
