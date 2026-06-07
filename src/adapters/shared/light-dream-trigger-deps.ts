import type { LightDreamTriggerDeps } from "../../app/dreaming/background-triggers.js";
import type { DreamPort } from "../../app/dreaming/ports.js";
import type { PluginClaimExtractionRuntime } from "../../app/plugin-runtime/types.js";
import type { AgenrConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";

/** Host plugin services required to build light dream trigger deps. */
export interface PluginLightDreamTriggerServices {
  dreaming: DreamPort;
  config: { dbPath: string };
  agenrConfig: AgenrConfig | null;
  embedding: EmbeddingPort;
  claimExtraction?: PluginClaimExtractionRuntime;
}

/**
 * Builds shared light dream trigger deps from host plugin runtime services.
 *
 * @param services - Dreaming port, db path, config, embedding, and optional claim extraction.
 * @returns Deps object passed to `maybeRunLightDream`.
 */
export function buildLightDreamTriggerDeps(services: PluginLightDreamTriggerServices): LightDreamTriggerDeps {
  return {
    port: services.dreaming,
    dbPath: services.config.dbPath,
    config: services.agenrConfig,
    embedding: services.embedding,
    ...(services.claimExtraction ? { createClaimExtractionLlm: () => services.claimExtraction!.llm } : {}),
  };
}
