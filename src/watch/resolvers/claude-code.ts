import type { SessionResolver } from "../session-resolver.js";
import { createMtimeResolver } from "./mtime.js";

function isSubagentPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/subagents/");
}

export const claudeCodeSessionResolver: SessionResolver = createMtimeResolver("*.jsonl", {
  recursive: true,
  includeFile: (filePath) => {
    const normalized = filePath.toLowerCase();
    if (!normalized.endsWith(".jsonl")) {
      return false;
    }
    return !isSubagentPath(filePath);
  },
});
