import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "core/recall/index": "src/core/recall/index.ts",
    "adapters/openclaw/index": "src/adapters/openclaw/index.ts",
  },
  format: ["esm"],
  clean: true,
  dts: true,
});
