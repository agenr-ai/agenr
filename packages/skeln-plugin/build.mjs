import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(pkgDir, "..", "..");
const rootDist = path.join(root, "dist");
const pluginDist = path.join(pkgDir, "dist");
const rootEntry = path.join(rootDist, "adapters", "skeln", "index.js");
const rootTypesEntry = path.join(rootDist, "adapters", "skeln", "index.d.ts");
const pluginEntry = path.join(pluginDist, "index.js");
const pluginTypesEntry = path.join(pluginDist, "index.d.ts");

await rm(pluginDist, { recursive: true, force: true });
await mkdir(pluginDist, { recursive: true });
let source = await readFile(rootEntry, "utf8");
let types = await readFile(rootTypesEntry, "utf8");
const allRootDistFiles = await readdir(rootDist);
const chunkFiles = allRootDistFiles.filter((name) => name.startsWith("chunk-") && name.endsWith(".js"));
for (const chunk of chunkFiles) {
  await copyFile(path.join(rootDist, chunk), path.join(pluginDist, chunk));
}
const declarationFiles = allRootDistFiles.filter((name) => name.endsWith(".d.ts"));
for (const declarationFile of declarationFiles) {
  await copyFile(path.join(rootDist, declarationFile), path.join(pluginDist, declarationFile));
}
source = source.replaceAll("../../chunk-", "./chunk-");
types = types.replaceAll("../../", "./");
await writeFile(pluginEntry, source);
await writeFile(pluginTypesEntry, types);
console.log(
  JSON.stringify({ copiedChunks: chunkFiles.sort(), copiedDeclarations: declarationFiles.sort(), finalFiles: (await readdir(pluginDist)).sort() }, null, 2),
);
