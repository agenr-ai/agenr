#!/usr/bin/env node

import process from "node:process";

import { DEFAULT_INTERNAL_EVAL_HOST, DEFAULT_INTERNAL_EVAL_PORT, startInternalEvalServer } from "./adapters/api/internal-eval-server.js";

const HOST_ENV_NAME = "AGENR_INTERNAL_EVAL_HOST";
const PORT_ENV_NAME = "AGENR_INTERNAL_EVAL_PORT";
const LEGACY_HOST_ENV_NAME = "AGENR_INTERNAL_RECALL_EVAL_HOST";
const LEGACY_PORT_ENV_NAME = "AGENR_INTERNAL_RECALL_EVAL_PORT";

const host = resolveHost(process.env[HOST_ENV_NAME], process.env[LEGACY_HOST_ENV_NAME]);
const port = resolvePort(process.env[PORT_ENV_NAME], process.env[LEGACY_PORT_ENV_NAME]);
const server = await startInternalEvalServer({ host, port });

console.log(`Internal eval dev server listening at ${server.baseUrl}`);
console.log(`Serving routes: ${server.routePaths.join(", ")}`);

installSignalHandler("SIGINT");
installSignalHandler("SIGTERM");

/**
 * Installs a one-shot shutdown handler for a process signal.
 *
 * @param signal - Process signal to trap for graceful shutdown.
 */
function installSignalHandler(signal: NodeJS.Signals): void {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

let shuttingDown = false;

/**
 * Stops the internal eval dev server once and exits the process.
 *
 * @param signal - Signal that triggered the shutdown flow.
 * @returns Promise that resolves after the HTTP server is closed.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown === true) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down internal eval dev server.`);

  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

/**
 * Resolves the loopback host binding from the internal server environment.
 *
 * @param value - Preferred host override from the environment.
 * @param fallbackValue - Legacy host override used for compatibility.
 * @returns Trimmed host string or the default loopback host.
 */
function resolveHost(value: string | undefined, fallbackValue: string | undefined): string {
  const trimmed = value?.trim() || fallbackValue?.trim();
  if (!trimmed) {
    return DEFAULT_INTERNAL_EVAL_HOST;
  }

  return trimmed;
}

/**
 * Resolves and validates the local TCP port from the internal server environment.
 *
 * @param value - Preferred port override from the environment.
 * @param fallbackValue - Legacy port override used for compatibility.
 * @returns Validated TCP port number.
 */
function resolvePort(value: string | undefined, fallbackValue: string | undefined): number {
  const trimmed = value?.trim() || fallbackValue?.trim();
  if (!trimmed) {
    return DEFAULT_INTERNAL_EVAL_PORT;
  }

  if (/^\d+$/u.test(trimmed) !== true) {
    throw new Error(`${PORT_ENV_NAME} must be an integer between 0 and 65535.`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${PORT_ENV_NAME} must be an integer between 0 and 65535.`);
  }

  return parsed;
}
