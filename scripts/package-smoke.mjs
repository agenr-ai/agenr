import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
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
  await rm(tempRoot, { force: true, recursive: true });
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
  await run("npm", ["install", "--no-audit", "--no-fund", packageTarball], { cwd: appDir });
  await run("npx", ["agenr", "--version"], { cwd: appDir });

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

  await run("npx", ["agenr", "db", "reset", "--yes"], {
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
  await run("npm", ["install", "--no-audit", "--no-fund", packageTarball], { cwd: appDir });
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

/** Runs one command with Windows command-shim support. */
async function run(command, args, options = {}) {
  const invocation = resolveCommandInvocation(command, args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}

/** Resolves Windows `.cmd` shims without losing spaces in arguments. */
function resolveCommandInvocation(command, args) {
  if (process.platform !== "win32" || !requiresWindowsCommandShell(command)) {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/c", command, ...args],
  };
}

/** Returns true for package-manager commands that are exposed as `.cmd` files on Windows. */
function requiresWindowsCommandShell(command) {
  return command === "npm" || command === "npx";
}
