import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Option, type Command } from "commander";

import { startWebServer } from "../../adapters/web/index.js";
import { readInstanceRegistry, registerInstance } from "../../app/web/instance-registry.js";
import { formatError, formatLabel, formatSuccess, formatWarn } from "../../ui.js";

/** Commander options accepted by the `agenr web` command. */
interface WebCommandOptions {
  port: string;
  host: string;
  open: boolean;
  register?: string;
  db?: string;
  config?: string;
  procedures?: string;
}

/**
 * Registers the `agenr web` CLI command.
 *
 * Launches the local-only operator console: a loopback HTTP server that serves
 * the built single-page app and the management API. The process stays alive
 * until interrupted.
 *
 * @param program - Root Commander program to extend.
 */
export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Launch the local operator console (loopback web UI)")
    .addOption(new Option("--port <port>", "Port to bind").default("4319"))
    .addOption(new Option("--host <host>", "Loopback host to bind").default("127.0.0.1"))
    .option("--no-open", "Do not open a browser automatically")
    .addOption(new Option("--register <name>", "Register and select an instance with this display name on launch"))
    .addOption(new Option("--db <path>", "Database path for the registered instance"))
    .addOption(new Option("--config <path>", "Config file path for the registered instance"))
    .addOption(new Option("--procedures <dir>", "Procedures directory for the registered instance"))
    .action(async (options: WebCommandOptions) => {
      try {
        await runWebCommand(options);
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`${formatError(`Failed to start web console: ${formatUnknownError(error)}`)}\n`);
      }
    });
}

/** Resolves options, bootstraps an instance when asked, and runs the server. */
async function runWebCommand(options: WebCommandOptions): Promise<void> {
  const port = Number.parseInt(options.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${options.port}.`);
  }

  await maybeRegisterInstance(options);
  await warnWhenNoInstance();

  const staticDir = resolveWebStaticDir();
  if (!staticDir) {
    process.stderr.write(`${formatWarn("Built web assets were not found. Serving the API only. Run `pnpm build` to generate the UI.")}\n`);
  }

  const handle = await startWebServer({
    host: options.host,
    port,
    ...(staticDir ? { staticDir } : {}),
    env: process.env,
    logger: (message) => process.stderr.write(`${formatWarn(message)}\n`),
  });

  process.stdout.write(`\n${formatSuccess("Agenr operator console is running.")}\n`);
  process.stdout.write(`${formatLabel("URL", handle.url)}\n`);
  process.stdout.write(`${formatLabel("Mode", staticDir ? "UI + API" : "API only")}\n`);
  process.stdout.write(`${formatLabel("Stop", "press Ctrl-C")}\n\n`);

  if (options.open && staticDir) {
    openBrowser(handle.url);
  }

  await waitForShutdown(async () => {
    process.stdout.write(`\n${formatWarn("Shutting down web console...")}\n`);
    await handle.close();
  });
}

/** Registers and selects a convenience instance when launch flags are provided. */
async function maybeRegisterInstance(options: WebCommandOptions): Promise<void> {
  const name = options.register?.trim();
  if (!name) {
    return;
  }

  await registerInstance(
    {
      name,
      ...(options.config ? { configPath: options.config } : {}),
      ...(options.db ? { dbPath: options.db } : {}),
      ...(options.procedures ? { proceduresDir: options.procedures } : {}),
    },
    { env: process.env },
  );
  process.stdout.write(`${formatSuccess(`Registered and selected instance "${name}".`)}\n`);
}

/** Warns when the console launches without any registered instance. */
async function warnWhenNoInstance(): Promise<void> {
  const registry = await readInstanceRegistry({ env: process.env });
  if (registry.instances.length === 0) {
    process.stdout.write(`${formatWarn("No instances registered yet. Add one from Instance Settings in the console, or relaunch with --register.")}\n`);
  }
}

/** Resolves the built SPA directory shipped beside the compiled CLI. */
function resolveWebStaticDir(): string | null {
  const candidate = fileURLToPath(new URL("./web", import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

/** Opens the default browser at a URL without blocking the server. */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening a browser is best-effort; ignore environments without one.
  }
}

/** Resolves once an interrupt signal is received, then runs cleanup. */
function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      void cleanup().finally(resolve);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

/**
 * Converts unknown thrown values into displayable error text.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
