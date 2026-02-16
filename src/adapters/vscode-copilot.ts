import path from "node:path";
import type { SourceAdapter } from "./types.js";

const STUB_ERROR = "Cursor/VS Code session import requires the cursor adapter (coming soon). Export to JSONL first.";

export const vscodeCopilotAdapter: SourceAdapter = {
  name: "vscode-copilot",

  canHandle(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".vscdb";
  },

  async parse(_filePath: string) {
    throw new Error(STUB_ERROR);
  },
};
