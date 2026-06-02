#!/usr/bin/env node
/**
 * Run agenr checks inside a Linux container (Ubuntu-like parity).
 *
 * Docker Desktop on macOS cannot run Windows containers; use `pnpm test:win-sim`
 * for Windows cleanup/timeouts policy, and keep a slim Windows GitHub job for
 * real file-lock behavior.
 *
 * Usage:
 *   node scripts/test-docker.mjs              # pnpm test
 *   node scripts/test-docker.mjs check        # pnpm check
 *   node scripts/test-docker.mjs test -- tests/helpers
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmVersion = "10.28.2";
const nodeImage = process.env.AGENR_DOCKER_NODE_IMAGE ?? "node:24-bookworm-slim";
const userArgs = process.argv.slice(2);
const pnpmArgs = resolvePnpmArgs(userArgs);

const shellCommand = [
  "set -euo pipefail",
  "corepack enable",
  `corepack prepare pnpm@${pnpmVersion} --activate`,
  "pnpm install --frozen-lockfile",
  `pnpm ${pnpmArgs.map((arg) => shellQuote(arg)).join(" ")}`,
].join(" && ");

const dockerArgs = ["run", "--rm", "-v", `${repoRoot}:/work`, "-w", "/work", "-e", "CI=1", nodeImage, "bash", "-lc", shellCommand];

const result = spawnSync("docker", dockerArgs, { stdio: "inherit" });
if (result.error) {
  console.error(`Failed to run docker: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function resolvePnpmArgs(args) {
  if (args.length === 0) {
    return ["test"];
  }

  if (args[0] === "check" || args[0] === "test" || args[0] === "smoke:packages") {
    return args;
  }

  if (args.some((arg) => arg.endsWith(".test.ts") || arg.startsWith("tests/"))) {
    return ["exec", "vitest", "run", ...args];
  }

  return args;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
