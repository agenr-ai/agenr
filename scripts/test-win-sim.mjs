#!/usr/bin/env node
/**
 * Exercise Windows-oriented test timeouts and sqlite cleanup policy on macOS/Linux.
 * Does not replace a real Windows host for libSQL file-lock behavior.
 *
 * Usage:
 *   node scripts/test-win-sim.mjs
 *   node scripts/test-win-sim.mjs tests/helpers/temp-paths.test.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestArgs = process.argv.slice(2);
const args = ["exec", "vitest", "run", ...vitestArgs];

const result = spawnSync("pnpm", args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    AGENR_TEST_WIN: "1",
  },
});

process.exit(result.status ?? 1);
