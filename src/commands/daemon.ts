import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { loadWatchState } from "../watch/state.js";

const LAUNCH_LABEL = "com.agenr.watch";
const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_STATUS_LOG_LINES = 20;
const DEFAULT_LOG_LINES = 100;

export interface DaemonInstallOptions {
  force?: boolean;
  interval?: number | string;
}

export interface DaemonUninstallOptions {
  yes?: boolean;
}

export interface DaemonStatusOptions {
  lines?: number | string;
  configDir?: string;
}

export interface DaemonLogsOptions {
  lines?: number | string;
  follow?: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DaemonCommandDeps {
  platformFn: () => NodeJS.Platform;
  homedirFn: () => string;
  uidFn: () => number;
  argvFn: () => string[];
  execFileFn: (file: string, args: string[]) => Promise<CommandResult>;
  spawnFn: typeof spawn;
  statFn: typeof fs.stat;
  mkdirFn: typeof fs.mkdir;
  writeFileFn: typeof fs.writeFile;
  rmFn: typeof fs.rm;
  readFileFn: typeof fs.readFile;
  loadWatchStateFn: typeof loadWatchState;
  confirmFn: (message: string) => Promise<boolean>;
}

export interface DaemonCommandResult {
  exitCode: number;
}

export interface DaemonStatusResult extends DaemonCommandResult {
  loaded: boolean;
  running: boolean;
  currentFile: string | null;
  logTail: string[];
}

function parsePositiveInt(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return fallback;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(parsed);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderLaunchdPlist(programArguments: string[], logPath: string): string {
  const argLines = programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argLines,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function getPaths(homeDir: string): {
  launchAgentsDir: string;
  plistPath: string;
  logDir: string;
  logPath: string;
} {
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${LAUNCH_LABEL}.plist`);
  const logDir = path.join(homeDir, ".agenr", "logs");
  const logPath = path.join(logDir, "watch.log");

  return { launchAgentsDir, plistPath, logDir, logPath };
}

async function fileExists(statFn: typeof fs.stat, targetPath: string): Promise<boolean> {
  try {
    await statFn(targetPath);
    return true;
  } catch {
    return false;
  }
}

function defaultExecFile(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
        reject(error);
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0,
      });
    });
  });
}

function resolveDeps(deps?: Partial<DaemonCommandDeps>): DaemonCommandDeps {
  return {
    platformFn: deps?.platformFn ?? (() => process.platform),
    homedirFn: deps?.homedirFn ?? (() => os.homedir()),
    uidFn: deps?.uidFn ?? (() => (typeof process.getuid === "function" ? process.getuid() : -1)),
    argvFn: deps?.argvFn ?? (() => process.argv),
    execFileFn: deps?.execFileFn ?? defaultExecFile,
    spawnFn: deps?.spawnFn ?? spawn,
    statFn: deps?.statFn ?? fs.stat,
    mkdirFn: deps?.mkdirFn ?? fs.mkdir,
    writeFileFn: deps?.writeFileFn ?? fs.writeFile,
    rmFn: deps?.rmFn ?? fs.rm,
    readFileFn: deps?.readFileFn ?? fs.readFile,
    loadWatchStateFn: deps?.loadWatchStateFn ?? loadWatchState,
    confirmFn:
      deps?.confirmFn ??
      (async (message: string) => {
        const result = await clack.confirm({ message });
        return result === true;
      }),
  };
}

function ensureSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("Daemon commands are currently supported on macOS only.");
  }
}

async function runLaunchctl(
  deps: DaemonCommandDeps,
  args: string[],
  strict: boolean,
): Promise<CommandResult> {
  const result = await deps.execFileFn("launchctl", args);
  if (strict && result.exitCode !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].find((value) => value.length > 0) ?? "unknown error";
    throw new Error(`launchctl ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function resolveCliPath(argv: string[]): string {
  const cliArg = argv[1];
  if (cliArg && cliArg.trim().length > 0) {
    return path.resolve(cliArg);
  }
  return path.resolve(process.cwd(), "dist", "cli.js");
}

async function readLastLines(
  readFileFn: typeof fs.readFile,
  logPath: string,
  count: number,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFileFn(logPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-count);
}

function selectLatestWatchedFile(state: Awaited<ReturnType<typeof loadWatchState>>): string | null {
  let best: { filePath: string; at: number } | null = null;

  for (const entry of Object.values(state.files)) {
    const timestamp = Date.parse(entry.lastRunAt);
    const at = Number.isFinite(timestamp) ? timestamp : 0;
    if (!best || at > best.at) {
      best = { filePath: entry.filePath, at };
    }
  }

  return best?.filePath ?? null;
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

export async function runDaemonInstallCommand(
  options: DaemonInstallOptions,
  deps?: Partial<DaemonCommandDeps>,
): Promise<DaemonCommandResult> {
  const resolvedDeps = resolveDeps(deps);
  ensureSupportedPlatform(resolvedDeps.platformFn());

  const intervalSeconds = parsePositiveInt(options.interval, DEFAULT_INTERVAL_SECONDS, "--interval");
  const homeDir = resolvedDeps.homedirFn();
  const uid = resolvedDeps.uidFn();
  if (uid < 0) {
    throw new Error("Unable to resolve current user ID for launchctl.");
  }

  const { launchAgentsDir, plistPath, logDir, logPath } = getPaths(homeDir);
  const plistExists = await fileExists(resolvedDeps.statFn, plistPath);
  if (plistExists && options.force !== true) {
    throw new Error(`Daemon plist already exists: ${plistPath}. Re-run with --force to overwrite.`);
  }

  await resolvedDeps.mkdirFn(launchAgentsDir, { recursive: true });
  await resolvedDeps.mkdirFn(logDir, { recursive: true });

  const cliPath = resolveCliPath(resolvedDeps.argvFn());
  const programArguments = [
    process.execPath,
    cliPath,
    "watch",
    "--auto",
    "--interval",
    String(intervalSeconds),
  ];

  const plist = renderLaunchdPlist(programArguments, logPath);
  await resolvedDeps.writeFileFn(plistPath, plist, "utf8");

  await runLaunchctl(resolvedDeps, ["bootout", `gui/${uid}/${LAUNCH_LABEL}`], false);
  await runLaunchctl(resolvedDeps, ["bootstrap", `gui/${uid}`, plistPath], true);

  clack.log.success(`Installed daemon plist: ${plistPath}`);
  clack.log.info(`Log file: ${logPath}`);
  return { exitCode: 0 };
}

export async function runDaemonUninstallCommand(
  options: DaemonUninstallOptions,
  deps?: Partial<DaemonCommandDeps>,
): Promise<DaemonCommandResult> {
  const resolvedDeps = resolveDeps(deps);
  ensureSupportedPlatform(resolvedDeps.platformFn());

  const homeDir = resolvedDeps.homedirFn();
  const uid = resolvedDeps.uidFn();
  if (uid < 0) {
    throw new Error("Unable to resolve current user ID for launchctl.");
  }

  const { plistPath } = getPaths(homeDir);
  const exists = await fileExists(resolvedDeps.statFn, plistPath);
  if (!exists) {
    clack.log.info(`Daemon plist not found: ${plistPath}`);
    return { exitCode: 0 };
  }

  if (options.yes !== true) {
    const confirmed = await resolvedDeps.confirmFn("Remove agenr watch daemon?");
    if (!confirmed) {
      clack.log.warn("Uninstall cancelled.");
      return { exitCode: 1 };
    }
  }

  await runLaunchctl(resolvedDeps, ["bootout", `gui/${uid}/${LAUNCH_LABEL}`], false);
  await resolvedDeps.rmFn(plistPath, { force: true });

  clack.log.success("Daemon uninstalled.");
  return { exitCode: 0 };
}

export async function runDaemonStatusCommand(
  options: DaemonStatusOptions,
  deps?: Partial<DaemonCommandDeps>,
): Promise<DaemonStatusResult> {
  const resolvedDeps = resolveDeps(deps);
  ensureSupportedPlatform(resolvedDeps.platformFn());

  const homeDir = resolvedDeps.homedirFn();
  const uid = resolvedDeps.uidFn();
  if (uid < 0) {
    throw new Error("Unable to resolve current user ID for launchctl.");
  }

  const { logPath } = getPaths(homeDir);
  const statusResult = await runLaunchctl(resolvedDeps, ["print", `gui/${uid}/${LAUNCH_LABEL}`], false);
  const loaded = statusResult.exitCode === 0;
  const combined = `${statusResult.stdout}\n${statusResult.stderr}`;
  const running = loaded && (/\bstate = running\b/.test(combined) || /\bpid = \d+\b/.test(combined));

  let currentFile: string | null = null;
  try {
    const state = await resolvedDeps.loadWatchStateFn(options.configDir);
    currentFile = selectLatestWatchedFile(state);
  } catch {
    currentFile = null;
  }

  const lineCount = parsePositiveInt(options.lines, DEFAULT_STATUS_LOG_LINES, "--lines");
  const logTail = await readLastLines(resolvedDeps.readFileFn, logPath, lineCount);

  clack.note(
    [
      `Loaded: ${loaded ? "yes" : "no"}`,
      `Running: ${running ? "yes" : "no"}`,
      `Current file: ${currentFile ?? "(none)"}`,
      `Log file: ${logPath}`,
    ].join("\n"),
    "Daemon Status",
  );

  if (logTail.length > 0) {
    clack.log.info(`Last ${logTail.length} log lines:`);
    printLines(logTail);
  }

  return {
    exitCode: 0,
    loaded,
    running,
    currentFile,
    logTail,
  };
}

async function followLog(
  deps: DaemonCommandDeps,
  logPath: string,
  lines: number,
): Promise<void> {
  const child = deps.spawnFn("tail", ["-n", String(lines), "-f", logPath], {
    stdio: "inherit",
  }) as ChildProcess;

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`tail exited with code ${code}`));
    });
  });
}

export async function runDaemonLogsCommand(
  options: DaemonLogsOptions,
  deps?: Partial<DaemonCommandDeps>,
): Promise<DaemonCommandResult> {
  const resolvedDeps = resolveDeps(deps);
  ensureSupportedPlatform(resolvedDeps.platformFn());

  const homeDir = resolvedDeps.homedirFn();
  const { logPath } = getPaths(homeDir);

  const logExists = await fileExists(resolvedDeps.statFn, logPath);
  if (!logExists) {
    throw new Error(`Daemon log file not found: ${logPath}`);
  }

  const lineCount = parsePositiveInt(options.lines, DEFAULT_LOG_LINES, "--lines");
  const follow = options.follow === true || options.lines === undefined;

  if (follow) {
    await followLog(resolvedDeps, logPath, lineCount);
    return { exitCode: 0 };
  }

  const lines = await readLastLines(resolvedDeps.readFileFn, logPath, lineCount);
  printLines(lines);
  return { exitCode: 0 };
}
