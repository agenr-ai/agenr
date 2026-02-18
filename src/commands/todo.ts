import * as clack from "@clack/prompts";
import { banner } from "../ui.js";
import { closeDb, getDb, initDb } from "../db/client.js";

interface TodoRow {
  id: string;
  subject: string;
  content: string;
}

export interface TodoCommandOptions {
  db?: string;
}

export interface TodoCommandDeps {
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  introFn: typeof clack.intro;
  confirmFn: typeof clack.confirm;
  selectFn: typeof clack.select;
  outroFn: typeof clack.outro;
  logInfoFn: typeof clack.log.info;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function findMatches(rows: TodoRow[], query: string): TodoRow[] {
  const normalizedQuery = query.toLowerCase();
  return rows.filter((row) => {
    const normalizedSubject = row.subject.toLowerCase();
    return normalizedSubject.includes(normalizedQuery) || normalizedQuery.includes(normalizedSubject);
  });
}

async function markDone(db: ReturnType<typeof getDb>, id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE entries SET superseded_by = id, updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
}

export async function runTodoCommand(
  subcommand: string,
  subject: string,
  opts: TodoCommandOptions,
  deps: Partial<TodoCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: TodoCommandDeps = {
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    introFn: deps.introFn ?? clack.intro,
    confirmFn: deps.confirmFn ?? clack.confirm,
    selectFn: deps.selectFn ?? clack.select,
    outroFn: deps.outroFn ?? clack.outro,
    logInfoFn: deps.logInfoFn ?? clack.log.info,
  };

  const normalizedSubcommand = subcommand.trim().toLowerCase();
  if (normalizedSubcommand !== "done") {
    resolvedDeps.outroFn(`Unknown todo subcommand: ${subcommand}`);
    return { exitCode: 1 };
  }

  const subjectQuery = subject.trim();
  if (!subjectQuery) {
    resolvedDeps.outroFn("Subject is required.");
    return { exitCode: 1 };
  }

  resolvedDeps.introFn(banner(), { output: process.stderr });

  const db = resolvedDeps.getDbFn(opts.db);
  try {
    await resolvedDeps.initDbFn(db);

    const result = await db.execute({
      sql: `
        SELECT id, subject, content
        FROM entries
        WHERE type = 'todo' AND superseded_by IS NULL
        ORDER BY importance DESC, created_at DESC
      `,
      args: [],
    });

    const rows = result.rows.map((row) => ({
      id: toStringValue(row.id),
      subject: toStringValue(row.subject),
      content: toStringValue(row.content),
    }));

    const matches = findMatches(rows, subjectQuery);
    if (matches.length === 0) {
      resolvedDeps.outroFn(`No active todo matching: ${subjectQuery}`, { output: process.stderr });
      return { exitCode: 1 };
    }

    if (matches.length === 1) {
      const match = matches[0];
      resolvedDeps.logInfoFn(`Todo: ${match.subject}`, { output: process.stderr });
      resolvedDeps.logInfoFn(match.content, { output: process.stderr });
      const confirmed = await resolvedDeps.confirmFn({ message: "Mark as done? [y/N]" });

      if (confirmed !== true) {
        resolvedDeps.outroFn("Cancelled.", { output: process.stderr });
        return { exitCode: 1 };
      }

      await markDone(db, match.id);
      resolvedDeps.outroFn(`Done: ${match.subject}`, { output: process.stderr });
      return { exitCode: 0 };
    }

    const topMatches = matches.slice(0, 5);
    for (let i = 0; i < topMatches.length; i += 1) {
      const row = topMatches[i];
      resolvedDeps.logInfoFn(`${i + 1}. ${row.subject}`, { output: process.stderr });
    }

    const selection = await resolvedDeps.selectFn({
      message: `Select [1-${topMatches.length}] or 0 to cancel`,
      options: [
        ...topMatches.map((row, index) => ({
          label: `${index + 1}. ${row.subject}`,
          value: row.id,
        })),
        { label: "0. Cancel", value: "__cancel__" },
      ],
    });

    if (selection === "__cancel__" || clack.isCancel(selection)) {
      resolvedDeps.outroFn("Cancelled.", { output: process.stderr });
      return { exitCode: 1 };
    }

    const selected = topMatches.find((row) => row.id === selection);
    if (!selected) {
      resolvedDeps.outroFn("Invalid selection.", { output: process.stderr });
      return { exitCode: 1 };
    }

    await markDone(db, selected.id);
    resolvedDeps.outroFn(`Done: ${selected.subject}`, { output: process.stderr });
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
