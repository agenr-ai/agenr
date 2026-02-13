export type AgpOperation = "discover" | "query" | "execute";

export type TransactionStatus = "pending" | "succeeded" | "failed";

export interface AgpTransaction {
  id: string;
  operation: AgpOperation;
  businessId: string;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
  input: unknown;
  result?: unknown;
  error?: string;
}

export interface DiscoverRequestBody {
  businessId: string;
}

export interface QueryRequestBody {
  businessId: string;
  request: Record<string, unknown>;
}

export interface ExecuteRequestPayload extends Record<string, unknown> {
  idempotencyKey?: string;
}

export interface ExecuteRequestBody {
  businessId: string;
  request: ExecuteRequestPayload;
}
