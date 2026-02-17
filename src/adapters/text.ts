import fs from "node:fs/promises";
import { firstNonEmptyLine, looksLikeTranscriptJsonLine, resolveTimestampFallback } from "./jsonl-base.js";
import { detectJsonlAdapter } from "./jsonl-registry.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";

export const textAdapter: SourceAdapter = {
  name: "text",

  canHandle(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown")) {
      return true;
    }

    return true;
  },

  async parse(filePath: string, options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const firstLine = firstNonEmptyLine(raw);

    if (firstLine && looksLikeTranscriptJsonLine(firstLine)) {
      const delegated = detectJsonlAdapter(filePath, firstLine);
      return delegated.parse(filePath, options);
    }

    return {
      messages: [],
      warnings: [],
      metadata: {
        platform: "text",
        startedAt: await resolveTimestampFallback(filePath),
      },
    };
  },
};
