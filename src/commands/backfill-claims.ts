import { readConfig, resolveModelForTask } from "../config.js";
import { closeDb, DEFAULT_DB_PATH, getDb, initDb } from "../db/client.js";
import { extractClaim } from "../db/claim-extraction.js";
import { SubjectIndex } from "../db/subject-index.js";
import { createLlmClient } from "../llm/client.js";

export interface BackfillClaimsOptions {
  model?: string;
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
  db?: string;
  verbose?: boolean;
}

export interface BackfillClaimsResult {
  exitCode: number;
  processed: number;
  claimsExtracted: number;
  noClaim: number;
  errors: number;
  skipped: number;
}

interface BackfillCandidate {
  id: string;
  content: string;
  type: string;
  subject: string;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function parsePositiveInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function stdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function loadCandidates(
  db: ReturnType<typeof getDb>,
  limit: number | undefined,
): Promise<{ entries: BackfillCandidate[]; skipped: number }> {
  const sqlParts = [
    "SELECT id, content, type, subject FROM entries",
    "WHERE subject_key IS NULL",
    "  AND retired = 0",
    "  AND superseded_by IS NULL",
    "ORDER BY importance DESC, created_at DESC",
  ];
  const args: unknown[] = [];

  if (limit !== undefined) {
    sqlParts.push("LIMIT ?");
    args.push(limit);
  }

  const result = await db.execute({
    sql: sqlParts.join("\n"),
    args,
  });

  const entries: BackfillCandidate[] = [];
  let skipped = 0;
  for (const row of result.rows) {
    const record = row as Record<string, unknown>;
    const id = toStringValue(record.id).trim();
    const content = toStringValue(record.content);
    const type = toStringValue(record.type).trim();
    const subject = toStringValue(record.subject).trim();
    if (!id || !content.trim() || !type || !subject) {
      skipped += 1;
      continue;
    }
    entries.push({ id, content, type, subject });
  }

  return { entries, skipped };
}

export async function runBackfillClaimsCommand(
  opts: BackfillClaimsOptions,
): Promise<BackfillClaimsResult> {
  const config = readConfig(process.env);
  const dbPath = opts.db?.trim() || config?.db?.path?.trim() || DEFAULT_DB_PATH;
  const limit = parsePositiveInt(opts.limit, "--limit");
  const batchSize = parsePositiveInt(opts.batchSize, "--batch-size") ?? 10;
  const verbose = opts.verbose === true;

  const db = getDb(dbPath);
  let processed = 0;
  let claimsExtracted = 0;
  let noClaim = 0;
  let errors = 0;
  let skipped = 0;

  try {
    await initDb(db);
    const candidates = await loadCandidates(db, limit);
    skipped += candidates.skipped;
    stdoutLine(`[backfill] Found ${candidates.entries.length} entries without claims`);

    if (opts.dryRun === true) {
      stdoutLine("[backfill] dry-run enabled, no changes made");
      return {
        exitCode: 0,
        processed,
        claimsExtracted,
        noClaim,
        errors,
        skipped,
      };
    }

    const total = candidates.entries.length;
    if (total > 0) {
      const model = opts.model?.trim() || resolveModelForTask(config ?? {}, "claimExtraction");
      const llmClient = createLlmClient({
        model,
        env: process.env,
      });

      for (let index = 0; index < total; index += batchSize) {
        const batch = candidates.entries.slice(index, index + batchSize);
        for (const entry of batch) {
          try {
            const claim = await extractClaim(
              entry.content,
              entry.type,
              entry.subject,
              llmClient,
              model,
              config ?? undefined,
            );

            if (!claim) {
              noClaim += 1;
              processed += 1;
              if (verbose) {
                stdoutLine(`[backfill] entry ${entry.id}: no claim extracted`);
              }
              continue;
            }

            await db.execute({
              sql: `
                UPDATE entries SET
                  subject_entity = ?,
                  subject_attribute = ?,
                  subject_key = ?,
                  claim_predicate = ?,
                  claim_object = ?,
                  claim_confidence = ?,
                  updated_at = ?
                WHERE id = ?
              `,
              args: [
                claim.subjectEntity,
                claim.subjectAttribute,
                claim.subjectKey,
                claim.predicate,
                claim.object,
                claim.confidence,
                new Date().toISOString(),
                entry.id,
              ],
            });

            claimsExtracted += 1;
            processed += 1;
            if (verbose) {
              stdoutLine(
                `[backfill] entry ${entry.id}: ${claim.subjectKey} ${claim.predicate} ${claim.object} (confidence=${claim.confidence.toFixed(2)})`,
              );
            }
          } catch (error) {
            errors += 1;
            processed += 1;
            stderrLine(
              `[backfill] entry ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        stdoutLine(`[backfill] ${processed}/${total} processed, ${claimsExtracted} claims extracted`);
      }
    }

    const subjectIndex = new SubjectIndex();
    await subjectIndex.rebuild(db);
    const stats = subjectIndex.stats();
    stdoutLine(`[backfill] subject index rebuilt: ${stats.keys} keys, ${stats.entries} entries`);

    stdoutLine(
      `[backfill] Backfill complete: ${processed} processed, ${claimsExtracted} claims extracted, ${noClaim} no-claim, ${errors} errors`,
    );

    return {
      exitCode: errors > 0 ? 1 : 0,
      processed,
      claimsExtracted,
      noClaim,
      errors,
      skipped,
    };
  } finally {
    closeDb(db);
  }
}
