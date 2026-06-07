import { EMBEDDING_DIMENSIONS } from "../../embeddings.js";
import { formatErrorMessage } from "../logging.js";
import { searchAgenrDurablesThroughMemoryHost } from "./search-bridge.js";
import type { AgenrOpenClawMemoryPluginRuntime, AgenrOpenClawMemoryProviderStatus, AgenrOpenClawServices } from "../types.js";

/**
 * Builds the lightweight memory runtime that newer OpenClaw status surfaces expect.
 *
 * @param servicesPromise - Shared agenr adapters created for the plugin process.
 * @returns Memory runtime registration object for the active memory slot.
 */
export function createAgenrMemoryRuntime(servicesPromise: Promise<AgenrOpenClawServices>): AgenrOpenClawMemoryPluginRuntime {
  return {
    async getMemorySearchManager() {
      try {
        const services = await servicesPromise;
        const snapshot = await services.memory.getMemoryStatusSnapshot();
        const vectorAvailable = await services.memory.probeVectorAvailability();
        const status: AgenrOpenClawMemoryProviderStatus = {
          backend: "builtin",
          provider: "agenr",
          model: services.embeddingStatus.model,
          dbPath: services.config.dbPath,
          files: snapshot.sourceFiles,
          chunks: snapshot.activeEntries,
          vector: {
            enabled: true,
            available: vectorAvailable,
            dims: EMBEDDING_DIMENSIONS,
          },
          custom: {
            activeEntries: snapshot.activeEntries,
            coreEntries: snapshot.coreEntries,
            sourceFiles: snapshot.sourceFiles,
          },
        };

        return {
          manager: {
            async search(query, opts) {
              return searchAgenrDurablesThroughMemoryHost(query, services, {
                maxResults: opts?.maxResults,
                minScore: opts?.minScore,
                sessionKey: opts?.sessionKey,
              });
            },
            async readFile({ relPath }) {
              throw new Error(`[agenr] memory file reads are not supported for "${relPath}"`);
            },
            status() {
              return status;
            },
            async probeEmbeddingAvailability() {
              return {
                ok: services.embeddingStatus.available,
                ...(services.embeddingStatus.error ? { error: services.embeddingStatus.error } : {}),
              };
            },
            async probeVectorAvailability() {
              return vectorAvailable;
            },
            async sync() {
              return;
            },
          },
        };
      } catch (error) {
        return {
          manager: null,
          error: `[agenr] memory runtime unavailable: ${formatErrorMessage(error)}`,
        };
      }
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
    async closeAllMemorySearchManagers() {
      try {
        const services = await servicesPromise;
        await services.close();
      } catch {
        // Ignore startup failures during memory-runtime shutdown.
      }
    },
  };
}
