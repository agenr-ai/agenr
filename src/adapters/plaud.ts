import { parsePlaudFilenameTimestamp, resolveTimestampFallback } from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";

export const plaudAdapter: SourceAdapter = {
  name: "plaud",

  canHandle(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) {
      return false;
    }

    return parsePlaudFilenameTimestamp(filePath) !== undefined;
  },

  async parse(filePath: string, _options?: AdapterParseOptions) {
    const filenameTimestamp = parsePlaudFilenameTimestamp(filePath);

    return {
      messages: [],
      warnings: [],
      metadata: {
        platform: "plaud",
        startedAt: await resolveTimestampFallback(filePath, filenameTimestamp),
      },
    };
  },
};
