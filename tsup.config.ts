import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "internal-eval-server": "src/internal-eval-server.ts",
    "internal-recall-eval-server": "src/internal-recall-eval-server.ts",
    "core/recall/index": "src/core/recall/index.ts",
    "adapters/skeln/index": "src/adapters/skeln/index.ts",
  },
  external: ["skeln", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "typebox"],
  format: ["esm"],
  clean: true,
  dts: true,
});
