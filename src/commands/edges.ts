import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { getCoRecallNeighbors, getTopCoRecallEdges } from "../db/co-recall.js";
import { toStringValue } from "../utils/entry-utils.js";

export interface EdgesCommandOptions {
  db?: string;
  entry?: string;
  limit?: number;
}

export interface EdgesCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
}

interface EntryLabels {
  [entryId: string]: string;
}

function summarize(text: string, maxLength = 40): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - value.length)}`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, row[index]?.length ?? 0), 0);
    return Math.max(header.length, rowMax);
  });

  const headerLine = headers.map((header, index) => pad(header, widths[index] ?? header.length)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join(" | "));

  return [headerLine, separator, ...body].join("\n");
}

async function readEntryLabels(db: ReturnType<typeof getDb>, entryIds: string[]): Promise<EntryLabels> {
  const uniqueIds = Array.from(new Set(entryIds.map((id) => id.trim()).filter((id) => id.length > 0)));
  if (uniqueIds.length === 0) {
    return {};
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT id, subject, content
      FROM entries
      WHERE id IN (${placeholders})
    `,
    args: uniqueIds,
  });

  const labels: EntryLabels = {};
  for (const row of result.rows) {
    const id = toStringValue((row as { id?: unknown }).id);
    if (!id) {
      continue;
    }
    const subject = toStringValue((row as { subject?: unknown }).subject).trim();
    const content = toStringValue((row as { content?: unknown }).content);
    labels[id] = summarize(subject || content || "(missing entry)");
  }

  return labels;
}

export async function runEdgesCommand(
  options: EdgesCommandOptions = {},
  deps: Partial<EdgesCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: EdgesCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);

    const limit = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.floor(options.limit as number) : undefined;
    const entryId = options.entry?.trim();

    if (entryId) {
      const neighbors = await getCoRecallNeighbors(db, entryId, 0.1, limit ?? 10);
      if (neighbors.length === 0) {
        process.stdout.write(`No co-recall neighbors found for entry: ${entryId}\n`);
        return { exitCode: 0 };
      }

      const labels = await readEntryLabels(db, [entryId, ...neighbors.map((item) => item.entryId)]);
      const rows = neighbors.map((neighbor) => [
        neighbor.entryId,
        labels[neighbor.entryId] ?? "(missing entry)",
        neighbor.weight.toFixed(2),
        String(neighbor.sessionCount),
        neighbor.lastCoRecalled,
      ]);

      process.stdout.write(
        `${renderTable(["neighbor_id", "subject", "weight", "sessions", "last_co_recalled"], rows)}\n`,
      );
      return { exitCode: 0 };
    }

    const edges = await getTopCoRecallEdges(db, limit ?? 20);
    if (edges.length === 0) {
      process.stdout.write("No co-recall edges found.\n");
      return { exitCode: 0 };
    }

    const labels = await readEntryLabels(
      db,
      edges.flatMap((edge) => [edge.entryA, edge.entryB]),
    );
    const rows = edges.map((edge) => [
      edge.entryA,
      labels[edge.entryA] ?? "(missing entry)",
      edge.entryB,
      labels[edge.entryB] ?? "(missing entry)",
      edge.weight.toFixed(2),
      String(edge.sessionCount),
      edge.lastCoRecalled,
    ]);

    process.stdout.write(
      `${renderTable(["entry_a", "subject_a", "entry_b", "subject_b", "weight", "sessions", "last_co_recalled"], rows)}\n`,
    );
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
