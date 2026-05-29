import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";

const pkgDir = new URL(".", import.meta.url).pathname;
const root = path.resolve(pkgDir, "..", "..");
const rootDist = path.join(root, "dist");
const pluginDist = path.join(pkgDir, "dist");
const rootEntry = path.join(rootDist, "adapters", "skeln", "index.js");
const pluginEntry = path.join(pluginDist, "index.js");

await rm(pluginDist, { recursive: true, force: true });
await mkdir(pluginDist, { recursive: true });
let source = await readFile(rootEntry, "utf8");
const allRootDistFiles = await readdir(rootDist);
const chunkFiles = allRootDistFiles.filter((name) => name.startsWith("chunk-") && name.endsWith(".js"));
for (const chunk of chunkFiles) {
  await copyFile(path.join(rootDist, chunk), path.join(pluginDist, chunk));
}
source = source.replaceAll("../../chunk-", "./chunk-");
await writeFile(pluginEntry, source);
console.log(JSON.stringify({ copiedChunks: chunkFiles.sort(), finalFiles: (await readdir(pluginDist)).sort() }, null, 2));
