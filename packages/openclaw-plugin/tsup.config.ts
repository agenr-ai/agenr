import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  external: ["openclaw", "openclaw/*"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
});
