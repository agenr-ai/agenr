import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyPluginDist } from "../../scripts/copy-plugin-dist.mjs";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(pkgDir, "..", "..");
const pluginDist = path.join(pkgDir, "dist");

const result = await copyPluginDist({
  root,
  pluginDist,
  adapterName: "openclaw",
  includeTypes: false,
});

console.log(JSON.stringify(result, null, 2));
