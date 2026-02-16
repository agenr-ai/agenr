import path from "node:path";
import type { SourceAdapter } from "./types.js";

const STUB_ERROR = "Cursor/VS Code session import requires the cursor adapter (coming soon). Export to JSONL first.";

export const cursorAdapter: SourceAdapter = {
  name: "cursor",

  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".vscdb") {
      return false;
    }

    return /cursor/i.test(filePath);
  },

  async parse(_filePath: string) {
    throw new Error(STUB_ERROR);
  },
};
