export type AgpOperation = "discover" | "query" | "execute";

export type TransactionStatus = "pending" | "succeeded" | "failed";

export interface AgpResponse<T = unknown> {
  id: string;
  operation: AgpOperation;
  businessId: string;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
  data: T;
  error?: string;
}

export type AgpTransaction<T = unknown> = AgpResponse<T>;

export interface PrepareResponse {
  confirmationToken: string;
  expiresAt: string;
  summary: string;
}

export interface ExecuteOptions {
  confirmationToken?: string;
  idempotencyKey?: string;
}

export interface AgenrConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}
