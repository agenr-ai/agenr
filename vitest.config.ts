import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "agenr:adapter-api": path.resolve(rootDirectory, "src/adapter-api.ts"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: [
      "tests/**/*.test.ts",
      "packages/sdk/tests/**/*.test.ts",
      "packages/mcp/tests/**/*.test.ts",
    ],
  },
});
