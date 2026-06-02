import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const DEFAULT_TIMEOUT_MS = process.platform === "win32" ? 900_000 : 300_000;
const INSTALL_TIMEOUT_MS = process.platform === "win32" ? 900_000 : 600_000;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenr package smoke "));

try {
  const packDir = path.join(tempRoot, "packs");
  await mkdir(packDir, { recursive: true });

  const rootPackage = await packPackage(repoRoot, packDir);
  const openClawPluginPackage = await packPackage(path.join(repoRoot, "packages", "openclaw-plugin"), packDir);
  const skelnPluginPackage = await packPackage(path.join(repoRoot, "packages", "skeln-plugin"), packDir);

  await smokeRootCli(rootPackage);
  await smokePackageImport(openClawPluginPackage, "@agenr/agenr-plugin", "openclaw plugin");
  await smokePackageImport(skelnPluginPackage, "@agenr/skeln-plugin", "skeln plugin");

  console.log("package smoke passed");
} finally {
  await removeTempRoot(tempRoot);
}

/** Packs one package into a shared temporary directory. */
async function packPackage(packageDir, packDir) {
  const { stdout } = await run("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd: packageDir });
  const packed = JSON.parse(stdout);
  const fileName = packed?.[0]?.filename;
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new Error(`npm pack did not report a tarball for ${packageDir}`);
  }

  return path.join(packDir, fileName);
}

/** Installs and exercises the packed root CLI package. */
async function smokeRootCli(packageTarball) {
  const appDir = path.join(tempRoot, "cli app with spaces");
  await initApp(appDir);
  await run("npm", ["install", "--no-audit", "--no-fund", packageTarball], {
    cwd: appDir,
    timeout: INSTALL_TIMEOUT_MS,
  });
  const cliPath = path.join(appDir, "node_modules", "agenr", "dist", "cli.js");
  await run(process.execPath, [cliPath, "--version"], { cwd: appDir });

  const configDir = path.join(appDir, "config with spaces");
  const configPath = path.join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "test-key",
        },
        dbPath: "file:relative%20db/nested/knowledge.db",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await run(process.execPath, [cliPath, "db", "reset", "--yes"], {
    cwd: appDir,
    env: {
      ...process.env,
      AGENR_CONFIG_PATH: configPath,
    },
  });

  const dbPath = path.join(appDir, "relative db", "nested", "knowledge.db");
  if (!existsSync(dbPath)) {
    throw new Error(`agenr db reset did not create expected database at ${dbPath}`);
  }
}

/** Installs a packed extension package and verifies its entry can be imported. */
async function smokePackageImport(packageTarball, packageName, label) {
  const appDir = path.join(tempRoot, `${label} app with spaces`);
  await initApp(appDir);
  await run("npm", ["install", "--no-audit", "--no-fund", packageTarball], {
    cwd: appDir,
    timeout: INSTALL_TIMEOUT_MS,
  });
  await run(
    process.execPath,
    ["--input-type=module", "-e", `const mod = await import(${JSON.stringify(packageName)}); if (!mod.default) throw new Error("missing default export");`],
    {
      cwd: appDir,
    },
  );
}

/** Initializes a temporary npm application directory. */
async function initApp(appDir) {
  await mkdir(appDir, { recursive: true });
  await run("npm", ["init", "-y"], { cwd: appDir });
}

/** Best-effort temp directory cleanup for Windows file-lock races. */
async function removeTempRoot(dir) {
  try {
    await rm(dir, { force: true, recursive: true, maxRetries: 10, retryDelay: 1_000 });
  } catch (error) {
    if (isBusyRemoveError(error)) {
      console.warn(`warning: could not remove temp directory ${dir}: ${error.message}`);
      return;
    }

    throw error;
  }
}

/** Runs one command with Windows command-shim support. */
async function run(command, args, options = {}) {
  const invocation = resolveCommandInvocation(command, args);
  console.log(`$ ${formatCommandForLog(command, args)}`);
  return execFileAsync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: invocation.shell,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
}

/** Resolves Windows `.cmd` shims without losing spaces in arguments. */
function resolveCommandInvocation(command, args) {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }

  if (isWindowsCmdShimCommand(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", command, ...args],
      shell: false,
    };
  }

  const extension = path.extname(command).toLowerCase();
  return {
    command,
    args,
    shell: extension === ".cmd" || extension === ".bat",
  };
}

/** Returns true for package-manager commands exposed as Windows `.cmd` shims. */
function isWindowsCmdShimCommand(command) {
  const base = path.basename(command).toLowerCase();
  return base === "npm" || base === "npx" || base === "npm.cmd" || base === "npx.cmd";
}

/** Returns true for Windows temp cleanup races after timed-out child processes. */
function isBusyRemoveError(error) {
  return error && typeof error === "object" && "code" in error && (error.code === "EBUSY" || error.code === "EPERM" || error.code === "ENOTEMPTY");
}

/** Formats one command for smoke-test progress output. */
function formatCommandForLog(command, args) {
  return [path.basename(command), ...args].map((arg) => (String(arg).includes(" ") ? JSON.stringify(arg) : String(arg))).join(" ");
}
