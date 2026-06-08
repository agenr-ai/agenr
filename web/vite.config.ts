import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite configuration for the Agenr operator console.
 *
 * The dev server proxies the management API to the local CLI server so the SPA
 * runs against a real instance during development. Production output is emitted
 * into the CLI's `dist/web` directory so `agenr web` can serve it directly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@agenr/web-api": path.resolve(repoRoot, "../src/web-api"),
    },
  },
  server: {
    port: 4320,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4319",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
});
