import { EMBEDDING_DIMENSIONS } from "../../embeddings.js";
import { VECTOR_INDEX_NAME } from "../../db/schema.js";
import { getOpenClawMemoryStatusSnapshot } from "../../db/openclaw-plugin-queries.js";
import type { AgenrOpenClawMemoryPluginRuntime, AgenrOpenClawMemoryProviderStatus, AgenrOpenClawServices } from "../types.js";

const ZERO_VECTOR = JSON.stringify(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0));

/**
 * Builds the lightweight memory runtime that newer OpenClaw status surfaces expect.
 *
 * @param servicesPromise - Shared agenr adapters created for the plugin process.
 * @returns Memory runtime registration object for the active memory slot.
 */
export function createAgenrMemoryRuntime(servicesPromise: Promise<AgenrOpenClawServices>): AgenrOpenClawMemoryPluginRuntime {
  return {
    async getMemorySearchManager() {
      const services = await servicesPromise;
      const snapshot = await getOpenClawMemoryStatusSnapshot(services.database);
      const vectorAvailable = await probeVectorAvailability(services);
      const status: AgenrOpenClawMemoryProviderStatus = {
        backend: "builtin",
        provider: "agenr",
        model: services.embeddingStatus.model,
        dbPath: services.dbPath,
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
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
    async closeAllMemorySearchManagers() {
      const services = await servicesPromise;
      await services.close();
    },
  };
}

/** Probes whether the libSQL vector extension and agenr index are usable. */
async function probeVectorAvailability(services: AgenrOpenClawServices): Promise<boolean> {
  try {
    await services.database.execute({
      sql: `
        SELECT COUNT(*) AS matches
        FROM vector_top_k('${VECTOR_INDEX_NAME}', vector32(?), ?) AS matches
      `,
      args: [ZERO_VECTOR, 1],
    });
    return true;
  } catch {
    return false;
  }
}
