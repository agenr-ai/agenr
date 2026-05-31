import type { EpisodeIngestFilePort } from "./ports.js";

/**
 * Creates a one-file discovery adapter for direct host episode writers.
 *
 * @param filePath - Transcript file path to expose as the only discovery result.
 * @returns File discovery port compatible with shared episode ingest.
 */
export function createSingleTranscriptDiscoveryPort(filePath: string): EpisodeIngestFilePort {
  return {
    async discoverFiles(_targetPath: string): Promise<string[]> {
      return [filePath];
    },
  };
}
