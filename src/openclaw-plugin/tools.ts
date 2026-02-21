import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnArgs, resolveAgenrPath } from "./recall.js";
import type { PluginToolResult } from "./types.js";

const TOOL_TIMEOUT_MS = 10000;
const EXTRACT_TIMEOUT_MS = 60000;

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function runAgenrCommand(
  agenrPath: string,
  args: string[],
  stdinPayload?: string,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<SpawnResult> {
  return await new Promise((resolve) => {
    const resolvedAgenrPath = agenrPath.trim() || resolveAgenrPath();
    const spawnArgs = buildSpawnArgs(resolvedAgenrPath);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: SpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(spawnArgs.cmd, [...spawnArgs.args, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      finish({ code, stdout, stderr, timedOut });
    });

    child.on("error", (error: Error) => {
      finish({ code: null, stdout, stderr, timedOut, error });
    });

    if (stdinPayload !== undefined) {
      child.stdin.write(stdinPayload);
    }
    child.stdin.end();
  });
}

export async function runRecallTool(agenrPath: string, params: Record<string, unknown>): Promise<PluginToolResult> {
  const args = ["recall", "--json"];
  const query = asString(params.query);
  const context = asString(params.context);
  const limit = asNumber(params.limit);
  const types = asString(params.types);
  const since = asString(params.since);
  const until = asString(params.until);
  const platform = asString(params.platform);
  const project = asString(params.project);

  if (query) {
    args.push(query);
  }
  if (context) {
    args.push("--context", context);
  }
  if (limit !== undefined) {
    args.push("--limit", String(limit));
  }
  if (types) {
    args.push("--type", types);
  }
  if (since) {
    args.push("--since", since);
  }
  if (until) {
    args.push("--until", until);
  }
  // threshold has no direct CLI equivalent in agenr recall
  if (platform) {
    args.push("--platform", platform);
  }
  if (project) {
    args.push("--project", project);
  }

  const result = await runAgenrCommand(agenrPath, args);
  if (result.timedOut) {
    return {
      content: [{ type: "text", text: "agenr_recall failed: command timed out" }],
    };
  }
  if (result.error) {
    return {
      content: [{ type: "text", text: `agenr_recall failed: ${result.error.message}` }],
    };
  }
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`;
    return {
      content: [{ type: "text", text: `agenr_recall failed: ${message}` }],
    };
  }

  const output = result.stdout.trim();
  if (!output) {
    return {
      content: [{ type: "text", text: "No results found." }],
      details: { count: 0 },
    };
  }

  try {
    const parsed: unknown = JSON.parse(output);
    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      details: parsed as Record<string, unknown>,
    };
  } catch {
    return {
      content: [{ type: "text", text: "No results found." }],
      details: { count: 0 },
    };
  }
}

export async function runStoreTool(
  agenrPath: string,
  params: Record<string, unknown>,
  pluginConfig?: Record<string, unknown>,
): Promise<PluginToolResult> {
  const entries = Array.isArray(params.entries) ? params.entries : [];
  const platform = asString(params.platform);
  const project = asString(params.project);
  const storeArgs = ["store"];

  // platform and project go as CLI flags, not in the JSON payload
  if (platform) {
    storeArgs.push("--platform", platform);
  }
  if (project) {
    storeArgs.push("--project", project);
  }

  // Infer subject from content when omitted - matches MCP server behavior.
  const processedEntries = entries.map((e: unknown) => {
    const entry = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    if (!entry.subject && typeof entry.content === "string") {
      entry.subject = entry.content
        .slice(0, 60)
        .replace(/[.!?][\s\S]*$/, "")
        .trim() || entry.content.slice(0, 40);
    }
    return entry;
  });

  const dedupConfig = pluginConfig?.dedup as Record<string, unknown> | undefined;
  if (dedupConfig?.aggressive === true) {
    storeArgs.push("--aggressive");
  }
  if (typeof dedupConfig?.threshold === "number") {
    storeArgs.push("--dedup-threshold", String(dedupConfig.threshold));
  }

  const result = await runAgenrCommand(agenrPath, storeArgs, JSON.stringify(processedEntries));
  if (result.timedOut) {
    return {
      content: [{ type: "text", text: "agenr_store timed out" }],
    };
  }
  if (result.error) {
    return {
      content: [{ type: "text", text: `agenr_store failed: ${result.error.message}` }],
    };
  }
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "unknown error";
    return {
      content: [{ type: "text", text: `agenr_store failed: ${message}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Stored ${entries.length} entries.` }],
    details: { count: entries.length },
  };
}

export async function runExtractTool(agenrPath: string, params: Record<string, unknown>): Promise<PluginToolResult> {
  const text = asString(params.text);
  if (!text) {
    return {
      content: [{ type: "text", text: "agenr_extract failed: text is required" }],
    };
  }

  // Step 1: always run extract --json to get KnowledgeEntry[] output
  const args = ["extract", "--json"];
  const tempFile = join(
    tmpdir(),
    `agenr-extract-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  try {
    writeFileSync(tempFile, text, "utf8");
    args.push(tempFile);

    const extractResult = await runAgenrCommand(agenrPath, args, undefined, EXTRACT_TIMEOUT_MS);
    if (extractResult.timedOut) {
      return {
        content: [{ type: "text", text: "agenr_extract failed: command timed out" }],
      };
    }
    if (extractResult.error) {
      return {
        content: [{ type: "text", text: `agenr_extract failed: ${extractResult.error.message}` }],
      };
    }
    if (extractResult.code !== 0) {
      const message = extractResult.stderr.trim() || extractResult.stdout.trim() || "unknown error";
      return {
        content: [{ type: "text", text: `agenr_extract failed: ${message}` }],
      };
    }

    // Step 2: if store is requested, inject source and pipe through store
    if (params.store === true) {
      let entries: unknown[];
      try {
        entries = JSON.parse(extractResult.stdout) as unknown[];
        if (!Array.isArray(entries)) {
          throw new Error("extract did not return an array");
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agenr_extract failed: could not parse extract output for store: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Inject source into entries here (--source does not exist on extract CLI).
      const source = asString(params.source);
      if (source) {
        for (const e of entries) {
          if (e && typeof e === "object") {
            const entry = e as Record<string, unknown>;
            if (!entry.source) {
              entry.source = { file: source, context: "extracted via agenr_extract" };
            }
          }
        }
      }

      const storeResult = await runAgenrCommand(agenrPath, ["store"], JSON.stringify(entries));
      if (storeResult.timedOut) {
        return { content: [{ type: "text", text: "agenr_extract store step timed out" }] };
      }
      if (storeResult.error) {
        return { content: [{ type: "text", text: `agenr_extract store step failed: ${storeResult.error.message}` }] };
      }
      if (storeResult.code !== 0) {
        const message = storeResult.stderr.trim() || storeResult.stdout.trim() || "unknown error";
        return { content: [{ type: "text", text: `agenr_extract store step failed: ${message}` }] };
      }
      return { content: [{ type: "text", text: `Extracted and stored ${entries.length} entries.` }] };
    }

    // No store: return the raw JSON
    try {
      const parsed: unknown = JSON.parse(extractResult.stdout);
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        details: parsed as Record<string, unknown>,
      };
    } catch {
      return {
        content: [{ type: "text", text: "No results found." }],
        details: { count: 0 },
      };
    }
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors for temp extract files.
    }
  }
}

export async function runRetireTool(agenrPath: string, params: Record<string, unknown>): Promise<PluginToolResult> {
  const entryId = asString(params.entry_id);
  if (!entryId) {
    return {
      content: [{ type: "text", text: "agenr_retire failed: entry_id is required" }],
    };
  }

  const reason = asString(params.reason);
  const persist = params.persist === true;

  const args = ["retire", "--id", entryId];
  if (reason) {
    args.push("--reason", reason);
  }
  if (persist) {
    args.push("--persist");
  }

  // Keep piping confirmation for the clack prompt.
  const result = await runAgenrCommand(agenrPath, args, "y\n");

  if (result.timedOut) {
    return {
      content: [{ type: "text", text: "agenr_retire failed: command timed out" }],
    };
  }
  if (result.error) {
    return {
      content: [{ type: "text", text: `agenr_retire failed: ${result.error.message}` }],
    };
  }
  if (result.code === 0) {
    return {
      content: [{ type: "text", text: `Retired entry ${entryId}.` }],
    };
  }

  const message = result.stdout.trim() || result.stderr.trim() || "unknown error";
  return {
    content: [{ type: "text", text: `agenr_retire failed: ${message}` }],
  };
}
