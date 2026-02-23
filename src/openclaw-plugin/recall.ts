import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgenrPluginConfig } from "./types.js";

const RECALL_TIMEOUT_MS = 10000;
// Cap query length to avoid oversized CLI args and embedding inputs.
const RECALL_QUERY_MAX_CHARS = 500;
const DEFAULT_BUDGET = 2000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_AGENR_PATH = path.join(PACKAGE_ROOT, "dist", "cli.js");

export type RecallEntry = {
  type: string;
  subject: string;
  content: string;
  importance?: number;
};

export type RecallResult = {
  query: string;
  results: Array<{
    entry: RecallEntry & Record<string, unknown>;
    score: number;
    category?: string;
  }>;
};

export function resolveAgenrPath(config?: AgenrPluginConfig): string {
  return config?.agenrPath?.trim() || process.env["AGENR_BIN"]?.trim() || DEFAULT_AGENR_PATH;
}

export function resolveBudget(config?: AgenrPluginConfig): number {
  return config?.budget ?? DEFAULT_BUDGET;
}

export function buildSpawnArgs(agenrPath: string): { cmd: string; args: string[] } {
  if (agenrPath.endsWith(".js")) {
    return { cmd: process.execPath, args: [agenrPath] };
  }

  return { cmd: agenrPath, args: [] };
}

export async function runRecall(
  agenrPath: string,
  budget: number,
  project?: string,
  query?: string,
  options?: { context?: "session-start" | "browse"; since?: string },
): Promise<RecallResult | null> {
  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const spawnArgs = buildSpawnArgs(agenrPath);

    function finish(value: RecallResult | null): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    const isBrowse = options?.context === "browse";
    const args = isBrowse
      ? ["recall", "--browse", "--since", options?.since ?? "1d", "--json"]
      : ["recall", "--context", "session-start", "--budget", String(budget), "--json"];
    if (project) {
      args.push("--project", project);
    }
    if (!isBrowse) {
      const trimmedQuery = query?.trim() ?? "";
      const truncatedQuery =
        trimmedQuery.length > RECALL_QUERY_MAX_CHARS
          ? trimmedQuery.slice(0, RECALL_QUERY_MAX_CHARS)
          : trimmedQuery;
      if (truncatedQuery) {
        args.push(truncatedQuery);
      }
    }
    const child = spawn(spawnArgs.cmd, [...spawnArgs.args, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, RECALL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(stdout);
        finish(isRecallResult(parsed) ? parsed : null);
      } catch {
        finish(null);
      }
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

function isRecallResult(value: unknown): value is RecallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "results" in value &&
    Array.isArray((value as RecallResult).results)
  );
}

// Entry types mapped to display groups.
const TODO_TYPES = new Set(["todo"]);
const PREFERENCE_TYPES = new Set(["preference", "decision"]);
// All other types fall into facts/events group.

type GroupedEntries = {
  todos: RecallEntry[];
  preferences: RecallEntry[];
  facts: RecallEntry[];
};

function groupValidEntries(result: RecallResult): GroupedEntries {
  const grouped: GroupedEntries = {
    todos: [],
    preferences: [],
    facts: [],
  };

  if (!result.results || result.results.length === 0) {
    return grouped;
  }

  for (const item of result.results) {
    const entry = item.entry;
    if (
      !entry ||
      typeof entry.type !== "string" ||
      typeof entry.subject !== "string" ||
      typeof entry.content !== "string"
    ) {
      continue;
    }

    if (TODO_TYPES.has(entry.type)) {
      grouped.todos.push(entry);
    } else if (PREFERENCE_TYPES.has(entry.type)) {
      grouped.preferences.push(entry);
    } else {
      grouped.facts.push(entry);
    }
  }

  return grouped;
}

export function formatRecallAsMarkdown(result: RecallResult): string {
  if (!result.results || result.results.length === 0) {
    return "";
  }

  const { todos, preferences, facts } = groupValidEntries(result);

  if (todos.length === 0 && preferences.length === 0 && facts.length === 0) {
    return "";
  }

  const lines: string[] = ["## agenr Memory Context", ""];

  if (todos.length > 0) {
    lines.push("### Active Todos", "");
    for (const entry of todos) {
      lines.push(`- [${entry.subject}] ${entry.content}`);
    }
    lines.push("");
  }

  if (preferences.length > 0) {
    lines.push("### Preferences and Decisions", "");
    for (const entry of preferences) {
      lines.push(`- [${entry.subject}] ${entry.content}`);
    }
    lines.push("");
  }

  if (facts.length > 0) {
    lines.push("### Facts and Events", "");
    for (const entry of facts) {
      lines.push(`- [${entry.subject}] ${entry.content}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
