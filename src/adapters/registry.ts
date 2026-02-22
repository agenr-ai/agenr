import path from "node:path";
import { cursorAdapter } from "./cursor.js";
import { readFirstNonEmptyLine } from "./jsonl-base.js";
import { detectJsonlAdapter } from "./jsonl-registry.js";
import { plaudAdapter } from "./plaud.js";
import { textAdapter } from "./text.js";
import type { SourceAdapter } from "./types.js";
import { vscodeCopilotAdapter } from "./vscode-copilot.js";

export async function detectAdapter(filePath: string): Promise<SourceAdapter> {
  const strippedPath = filePath.replace(/\.(deleted|reset)\.[^/\\]+$/, "");
  const ext = path.extname(strippedPath).toLowerCase();

  if (ext === ".jsonl") {
    const firstLine = await readFirstNonEmptyLine(filePath);
    return detectJsonlAdapter(strippedPath, firstLine);
  }

  if (ext === ".vscdb") {
    if (cursorAdapter.canHandle(filePath)) {
      return cursorAdapter;
    }
    if (vscodeCopilotAdapter.canHandle(filePath)) {
      return vscodeCopilotAdapter;
    }
    return vscodeCopilotAdapter;
  }

  if (ext === ".md" || ext === ".markdown") {
    if (plaudAdapter.canHandle(filePath)) {
      return plaudAdapter;
    }
    return textAdapter;
  }

  if (ext === ".txt") {
    return textAdapter;
  }

  return textAdapter;
}
