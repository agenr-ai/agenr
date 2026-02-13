export class AgenrError extends Error {
  readonly statusCode: number;
  readonly response: unknown;
  readonly transactionId?: string;

  constructor(message: string, statusCode: number, response?: unknown, transactionId?: string) {
    super(message);
    this.name = "AgenrError";
    this.statusCode = statusCode;
    this.response = response;
    this.transactionId = transactionId;
  }
}
