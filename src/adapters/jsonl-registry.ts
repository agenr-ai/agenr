import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { genericJsonlAdapter } from "./jsonl-generic.js";
import { openClawAdapter } from "./openclaw.js";
import type { SourceAdapter } from "./types.js";

export const JSONL_ADAPTERS: SourceAdapter[] = [
  openClawAdapter,
  claudeCodeAdapter,
  codexAdapter,
  genericJsonlAdapter,
];

export function detectJsonlAdapter(filePath: string, firstLine?: string): SourceAdapter {
  for (const adapter of JSONL_ADAPTERS) {
    if (adapter.canHandle(filePath, firstLine)) {
      return adapter;
    }
  }

  return genericJsonlAdapter;
}
