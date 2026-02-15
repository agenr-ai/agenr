import { randomUUID } from "node:crypto";
import type { Client, InValue, Row } from "@libsql/client";
import type { EntryRelation, RelationType } from "../types.js";

function toStringValue(value: InValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function mapRelation(row: Row): EntryRelation {
  return {
    id: toStringValue(row.id),
    source_id: toStringValue(row.source_id),
    target_id: toStringValue(row.target_id),
    relation_type: toStringValue(row.relation_type) as RelationType,
    created_at: toStringValue(row.created_at),
  };
}

export async function createRelation(
  db: Client,
  sourceId: string,
  targetId: string,
  type: RelationType,
): Promise<string> {
  const id = randomUUID();
  await db.execute({
    sql: `
      INSERT INTO relations (id, source_id, target_id, relation_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [id, sourceId, targetId, type, new Date().toISOString()],
  });
  return id;
}

export async function getRelations(db: Client, entryId: string): Promise<EntryRelation[]> {
  const result = await db.execute({
    sql: `
      SELECT id, source_id, target_id, relation_type, created_at
      FROM relations
      WHERE source_id = ? OR target_id = ?
      ORDER BY created_at ASC
    `,
    args: [entryId, entryId],
  });

  return result.rows.map((row) => mapRelation(row));
}
