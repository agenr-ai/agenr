import type { AgpOperation, AgpTransaction, TransactionStatus } from "../types/agp";
import { getDb } from "../db/client";

export class TransactionStore {
  private parseJson(value: unknown): unknown {
    if (typeof value !== "string") {
      return undefined;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private toTransaction(row: Record<string, unknown>): AgpTransaction | undefined {
    const id = row["id"];
    const operation = row["operation"];
    const businessId = row["business_id"];
    const status = row["status"];
    const createdAt = row["created_at"];
    const updatedAt = row["updated_at"];

    if (
      typeof id !== "string" ||
      typeof operation !== "string" ||
      typeof businessId !== "string" ||
      typeof status !== "string" ||
      typeof createdAt !== "string" ||
      typeof updatedAt !== "string"
    ) {
      return undefined;
    }

    const transaction: AgpTransaction = {
      id,
      operation: operation as AgpOperation,
      businessId,
      status: status as TransactionStatus,
      createdAt,
      updatedAt,
      input: this.parseJson(row["input"]),
    };

    const result = this.parseJson(row["result"]);
    if (result !== undefined) {
      transaction.result = result;
    }

    if (typeof row["error"] === "string") {
      transaction.error = row["error"];
    }

    return transaction;
  }

  async create(
    operation: AgpOperation,
    businessId: string,
    input: unknown,
    ownerKeyId: string,
  ): Promise<AgpTransaction> {
    const now = new Date().toISOString();
    const transaction: AgpTransaction = {
      id: crypto.randomUUID(),
      operation,
      businessId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      input,
    };

    const db = getDb();
    await db.execute({
      sql: `INSERT INTO transactions (
        id,
        operation,
        business_id,
        owner_key_id,
        status,
        input,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        transaction.id,
        transaction.operation,
        transaction.businessId,
        ownerKeyId,
        transaction.status,
        JSON.stringify(transaction.input),
        transaction.createdAt,
        transaction.updatedAt,
      ],
    });

    return transaction;
  }

  async update(
    id: string,
    status: TransactionStatus,
    payload?: { result?: unknown; error?: string },
  ): Promise<AgpTransaction | undefined> {
    const existing = await this.getById(id);
    if (!existing) {
      return undefined;
    }

    const updated: AgpTransaction = {
      ...existing,
      status,
      result: payload?.result,
      error: payload?.error,
      updatedAt: new Date().toISOString(),
    };

    const db = getDb();
    await db.execute({
      sql: `UPDATE transactions
        SET status = ?, result = ?, error = ?, updated_at = ?
        WHERE id = ?`,
      args: [
        updated.status,
        updated.result === undefined ? null : JSON.stringify(updated.result),
        updated.error ?? null,
        updated.updatedAt,
        id,
      ],
    });

    return updated;
  }

  async get(id: string, ownerKeyId: string): Promise<AgpTransaction | undefined> {
    const db = getDb();
    const result = await db.execute({
      sql: `SELECT
        id,
        operation,
        business_id,
        status,
        input,
        result,
        error,
        created_at,
        updated_at
      FROM transactions
      WHERE id = ?
        AND owner_key_id = ?`,
      args: [id, ownerKeyId],
    });

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    return this.toTransaction(row);
  }

  private async getById(id: string): Promise<AgpTransaction | undefined> {
    const db = getDb();
    const result = await db.execute({
      sql: `SELECT
        id,
        operation,
        business_id,
        status,
        input,
        result,
        error,
        created_at,
        updated_at
      FROM transactions
      WHERE id = ?`,
      args: [id],
    });

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    return this.toTransaction(row);
  }
}
