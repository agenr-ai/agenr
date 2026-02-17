#!/usr/bin/env node

// Suppress punycode deprecation warning from dependencies (@libsql/client).
// Node.js 21+ deprecated the built-in punycode module.
const originalEmit = process.emit;
process.emit = function (event: string, ...args: unknown[]) {
  if (
    event === "warning" &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    (args[0] as { name?: string }).name === "DeprecationWarning" &&
    String((args[0] as { message?: string }).message).includes("punycode")
  ) {
    return false;
  }

  return originalEmit.call(this, event, ...args);
};

import { pathToFileURL } from "node:url";

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const { createProgram } = await import("./cli-main.js");

  createProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      stderrLine(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export {};
