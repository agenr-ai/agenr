#!/usr/bin/env node

import process from "node:process";

import {
  DEFAULT_INTERNAL_RECALL_EVAL_HOST,
  DEFAULT_INTERNAL_RECALL_EVAL_PORT,
  startInternalRecallEvalServer,
} from "./adapters/api/internal-recall-eval-server.js";

const HOST_ENV_NAME = "AGENR_INTERNAL_RECALL_EVAL_HOST";
const PORT_ENV_NAME = "AGENR_INTERNAL_RECALL_EVAL_PORT";

const host = resolveHost(process.env[HOST_ENV_NAME]);
const port = resolvePort(process.env[PORT_ENV_NAME]);
const server = await startInternalRecallEvalServer({ host, port });

console.log(`Internal recall eval dev server listening at ${server.baseUrl}${server.routePath}`);
console.log("Serving only the existing internal recall eval route for local agenr-evals runs.");

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
 * Stops the internal recall eval dev server once and exits the process.
 *
 * @param signal - Signal that triggered the shutdown flow.
 * @returns Promise that resolves after the HTTP server is closed.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown === true) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down internal recall eval dev server.`);

  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

/**
 * Resolves the loopback host binding from the internal server environment.
 *
 * @param value - Raw host override from the environment.
 * @returns Trimmed host string or the default loopback host.
 */
function resolveHost(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_INTERNAL_RECALL_EVAL_HOST;
  }

  return trimmed;
}

/**
 * Resolves and validates the local TCP port from the internal server environment.
 *
 * @param value - Raw port override from the environment.
 * @returns Validated TCP port number.
 */
function resolvePort(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_INTERNAL_RECALL_EVAL_PORT;
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
