import type { SessionResolver } from "../session-resolver.js";
import { createMtimeResolver } from "./mtime.js";

export const codexSessionResolver: SessionResolver = createMtimeResolver("**/*.jsonl", {
  recursive: true,
  includeFile: (filePath) => filePath.toLowerCase().endsWith(".jsonl"),
});
