import { createAgenrRecallTool } from "./recall-tool.js";
import { createAgenrSkelnServices } from "./runtime.js";
import { createAgenrStoreTool } from "./store-tool.js";
import { createAgenrUpdateTool } from "./update-tool.js";
import type {
  AgenrSkelnMemoryProviderOptions,
  AgenrSkelnServices,
  SkelnMemoryContextLike,
  SkelnMemoryProviderLike,
  SkelnProviderStatusLike,
  SkelnToolContextLike,
  SkelnToolLike,
} from "./types.js";

export type { AgenrSkelnStoreDetails } from "./store-tool.js";

export type {
  SkelnApprovalTargetExtractorLike,
  SkelnApprovalTargetLike,
  AgenrSkelnLogger,
  AgenrSkelnMemoryProviderOptions,
  AgenrSkelnServices,
  SkelnMemoryContextLike,
  SkelnMemoryProviderLike,
  SkelnProviderStatusLike,
  SkelnToolContextLike,
  SkelnToolLike,
  SkelnToolResultLike,
} from "./types.js";

/**
 * Creates a Skeln-compatible agenr memory provider.
 *
 * Session-start and before-turn context hooks are no-ops.
 *
 * @param options - Optional config, database, tool, and logger settings.
 * @returns Structural Skeln memory provider.
 */
export function createAgenrSkelnMemoryProvider(options: AgenrSkelnMemoryProviderOptions = {}): SkelnMemoryProviderLike {
  const toolsEnabled = options.tools?.enabled ?? true;
  const storeEnabled = options.tools?.store ?? toolsEnabled;
  const recallEnabled = options.tools?.recall ?? toolsEnabled;
  const updateEnabled = options.tools?.update ?? toolsEnabled;
  let servicesPromise: Promise<AgenrSkelnServices> | undefined;
  let disposed = false;

  /** Resolves the shared services, initializing them on first use. */
  function services(): Promise<AgenrSkelnServices> {
    if (disposed) {
      throw new Error("Agenr Skeln memory provider has been disposed.");
    }

    servicesPromise ??= createAgenrSkelnServices({
      configPath: options.configPath,
      databasePath: options.databasePath,
    });
    void servicesPromise.catch((error) => {
      options.logger?.error?.("Agenr Skeln memory provider initialization failed.", {
        error: formatErrorMessage(error),
      });
    });
    return servicesPromise;
  }

  return {
    id: "agenr",
    label: "Agenr Memory",
    requiredCapabilities: ["external-persistence"],
    async buildSessionStartContext(_context: SkelnMemoryContextLike): Promise<string | undefined> {
      return undefined;
    },
    async buildBeforeTurnContext(_context: SkelnMemoryContextLike): Promise<string | undefined> {
      return undefined;
    },
    tools(context: SkelnToolContextLike): SkelnToolLike[] {
      const tools: SkelnToolLike[] = [];
      if (storeEnabled) {
        tools.push(createAgenrStoreTool(context, services));
      }
      if (recallEnabled) {
        tools.push(createAgenrRecallTool(context, services));
      }
      if (updateEnabled) {
        tools.push(createAgenrUpdateTool(context, services));
      }
      return tools;
    },
    async status(): Promise<SkelnProviderStatusLike> {
      try {
        const resolved = await services();
        return {
          state: "ready",
          message: resolved.dbPath,
        };
      } catch (error) {
        return {
          state: "error",
          message: formatErrorMessage(error),
        };
      }
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }

      disposed = true;
      if (!servicesPromise) {
        return;
      }

      try {
        const resolved = await servicesPromise;
        await resolved.close();
      } catch {
        // A failed lazy startup owns no closeable services.
      }
    },
  };
}

/**
 * Normalizes unknown failures into human-readable messages.
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
