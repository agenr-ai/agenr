import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Single source of truth for the CLI/MCP version: package.json.
export const APP_VERSION: string = ((): string => {
  try {
    const raw = require("../package.json") as { version?: unknown };
    if (typeof raw.version === "string" && raw.version.trim().length > 0) {
      return raw.version.trim();
    }
  } catch {
    // Fall through to env-based fallback.
  }

  const fromEnv = process.env.npm_package_version;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  return "0.0.0";
})();
