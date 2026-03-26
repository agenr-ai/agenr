import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Application version loaded from `package.json` with an env fallback. */
const APP_VERSION: string = ((): string => {
  try {
    const raw = require("../package.json") as { version?: unknown };
    if (typeof raw.version === "string" && raw.version.trim().length > 0) {
      return raw.version.trim();
    }
  } catch {
    // Fall through to the environment fallback.
  }

  const fromEnv = process.env.npm_package_version;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  return "0.0.0";
})();

export { APP_VERSION };
