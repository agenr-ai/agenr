import type { Client, InValue } from "@libsql/client";
import { CREATE_IDX_ENTRIES_EMBEDDING_SQL } from "./schema.js";

function toNumber(value: InValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

/**
 * Drop and recreate the vector index, then verify it works.
 * Call after any bulk mutation (consolidation, reset, large ingest).
 */
export async function rebuildVectorIndex(
  db: Client,
  options?: { onLog?: (message: string) => void },
): Promise<{ embeddingCount: number; durationMs: number }> {
  const start = Date.now();
  const onLog = options?.onLog ?? (() => undefined);

  await db.execute("DROP INDEX IF EXISTS idx_entries_embedding");
  await db.execute(CREATE_IDX_ENTRIES_EMBEDDING_SQL);

  const result = await db.execute("SELECT COUNT(*) AS count FROM entries WHERE embedding IS NOT NULL");
  const embeddingCountRaw = result.rows[0]?.count;
  const embeddingCount = Number.isFinite(toNumber(embeddingCountRaw)) ? toNumber(embeddingCountRaw) : 0;

  if (embeddingCount > 0) {
    const verify = await db.execute(`
      SELECT count(*) AS count
      FROM vector_top_k(
        'idx_entries_embedding',
        (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
        1
      )
    `);
    const verifyCountRaw = verify.rows[0]?.count;
    const verifyCount = Number.isFinite(toNumber(verifyCountRaw)) ? toNumber(verifyCountRaw) : 0;
    if (verifyCount !== 1) {
      throw new Error(`Vector index rebuild verification failed (expected 1, got ${verifyCount})`);
    }
  }

  const durationMs = Date.now() - start;
  onLog(`[vector-index] rebuilt for ${embeddingCount} entries (${durationMs}ms)`);
  return { embeddingCount, durationMs };
}
