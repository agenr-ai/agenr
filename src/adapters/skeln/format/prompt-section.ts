import { MEMORY_DOCTRINE, MEMORY_RECALL_SECTION_HEADER } from "../../shared/memory-prompt-doctrine.js";

/**
 * Builds the static memory doctrine appended to the Skeln system prompt.
 *
 * @returns Prompt lines describing how to use agenr memory tools and injected context.
 */
export function buildAgenrSkelnMemoryPromptSection(): string[] {
  return [
    MEMORY_RECALL_SECTION_HEADER,
    MEMORY_DOCTRINE.recall.first,
    MEMORY_DOCTRINE.recall.modes,
    MEMORY_DOCTRINE.recall.truncatedPreviewsWithFetch,
    MEMORY_DOCTRINE.recall.injectedContext,
    MEMORY_DOCTRINE.store.skelnNotLogging,
    MEMORY_DOCTRINE.store.claimKeyPromptLine,
    MEMORY_DOCTRINE.update.vsSupersedes,
    "",
  ];
}
