import type { ExtensionAPI } from "skeln";

import { createAgenrSkelnServices } from "./runtime.js";
import type { AgenrSkelnConfig } from "./runtime.js";
import type { RegisterAgenrSkelnMemoryOptions } from "./types.js";

export type { AgenrSkelnConfig, AgenrSkelnServices } from "./runtime.js";
export type { AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions, SkelnHostContext } from "./types.js";
export { createAgenrSkelnServices } from "./runtime.js";

/**
 * Registers agenr durable-memory tools and lifecycle hooks on a Skeln extension API.
 *
 * Tool and prompt-injection wiring is added in later adapter slices; this entry
 * composes shared services once per process and closes the database on quit.
 *
 * @param skeln - Skeln extension API for the active runtime.
 * @param options - Optional path overrides and host scope callback.
 */
export function registerAgenrSkelnMemory(skeln: ExtensionAPI, options: RegisterAgenrSkelnMemoryOptions = {}): void {
  const config: AgenrSkelnConfig = {
    dbPath: options.dbPath,
    configPath: options.configPath,
    memoryPolicy: options.memoryPolicy,
  };
  const servicesPromise = createAgenrSkelnServices(config);

  void servicesPromise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agenr] startup failed: ${message}`);
  });

  skeln.on("session_shutdown", async (event) => {
    if (event.reason !== "quit") {
      return;
    }

    try {
      const services = await servicesPromise;
      await services.close();
    } catch {
      // Ignore startup failures during shutdown.
    }
  });
}

/** Default Skeln extension factory for direct `@agenr/skeln-plugin` loads. */
export default function extension(skeln: ExtensionAPI): void {
  registerAgenrSkelnMemory(skeln);
}
