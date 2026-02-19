import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AgenrPluginConfig } from "./types.js";

const RECALL_TIMEOUT_MS = 5000;
const DEFAULT_BUDGET = 2000;
const DEFAULT_AGENR_PATH = path.join(os.homedir(), "Code", "agenr-local", "dist", "cli.js");

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

export async function runRecall(agenrPath: string, budget: number): Promise<RecallResult | null> {
  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    function finish(value: RecallResult | null): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    const child = spawn(
      process.execPath,
      [agenrPath, "recall", "--context", "session-start", "--budget", String(budget), "--json"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

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

export function formatRecallAsMarkdown(result: RecallResult): string {
  if (!result.results || result.results.length === 0) {
    return "";
  }

  const todos: RecallEntry[] = [];
  const preferences: RecallEntry[] = [];
  const facts: RecallEntry[] = [];

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
      todos.push(entry);
    } else if (PREFERENCE_TYPES.has(entry.type)) {
      preferences.push(entry);
    } else {
      facts.push(entry);
    }
  }

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
