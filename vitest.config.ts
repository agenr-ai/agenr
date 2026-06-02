import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32" || process.env.AGENR_TEST_WIN === "1";

export default defineConfig({
  test: {
    hookTimeout: isWindows ? 30_000 : 10_000,
    testTimeout: isWindows ? 15_000 : 5_000,
  },
});
