import fs from "node:fs/promises";
import { createMcpServer } from "../mcp/server.js";
import { APP_VERSION } from "../version.js";

export interface McpCommandOptions {
  db?: string;
  verbose?: boolean;
}

export interface McpCommandDeps {
  createMcpServerFn: typeof createMcpServer;
  readFileFn: (target: string | URL, encoding: BufferEncoding) => Promise<string>;
  stderrWriteFn: (line: string) => void;
}

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function readPackageVersion(
  readFileFn: McpCommandDeps["readFileFn"],
): Promise<string> {
  try {
    const raw = await readFileFn(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fall back to a known-safe default if package metadata can't be read.
  }
  return APP_VERSION;
}

export async function runMcpCommand(options: McpCommandOptions, deps?: Partial<McpCommandDeps>): Promise<void> {
  const resolvedDeps: McpCommandDeps = {
    createMcpServerFn: deps?.createMcpServerFn ?? createMcpServer,
    readFileFn: deps?.readFileFn ?? ((target: string | URL, encoding: BufferEncoding) => fs.readFile(target, encoding)),
    stderrWriteFn: deps?.stderrWriteFn ?? stderrLine,
  };

  const version = await readPackageVersion(resolvedDeps.readFileFn);
  const server = resolvedDeps.createMcpServerFn({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    dbPath: options.db,
    verbose: options.verbose === true,
    serverVersion: version,
    env: process.env,
  });

  resolvedDeps.stderrWriteFn(
    `[mcp] agenr MCP server started (protocol ${"2024-11-05"}, version ${version})`,
  );

  const onSignal = (signal: NodeJS.Signals): void => {
    resolvedDeps.stderrWriteFn(`[mcp] ${signal} received, shutting down`);
    void server.stop();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await server.startServer();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
