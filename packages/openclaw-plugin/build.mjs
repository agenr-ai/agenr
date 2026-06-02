import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(pkgDir, "..", "..");
const pluginDist = path.join(pkgDir, "dist");

await build({
  entry: {
    index: path.join(pkgDir, "src", "index.ts"),
  },
  external: ["openclaw", "openclaw/*"],
  format: ["esm"],
  outDir: pluginDist,
  clean: true,
  splitting: true,
  tsconfig: path.join(root, "tsconfig.json"),
});

console.log(JSON.stringify({ finalFiles: (await readdir(pluginDist)).sort() }, null, 2));
