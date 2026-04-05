import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const pkgDir = new URL('.', import.meta.url).pathname;
const root = path.resolve(pkgDir, '..', '..');
const rootDist = path.join(root, 'dist');
const pluginDist = path.join(pkgDir, 'dist');
const rootEntry = path.join(rootDist, 'adapters', 'openclaw', 'index.js');
const pluginEntry = path.join(pluginDist, 'index.js');

await rm(pluginDist, { recursive: true, force: true });
await mkdir(pluginDist, { recursive: true });
let source = await readFile(rootEntry, 'utf8');
const chunkMatches = [...source.matchAll(/(?:from\s+|import\s+")\.\.\/\.\.\/(chunk-[A-Z0-9]+\.js)"/g)].map((m) => m[1]);
const uniqueChunks = [...new Set(chunkMatches)];
for (const chunk of uniqueChunks) {
  await copyFile(path.join(rootDist, chunk), path.join(pluginDist, chunk));
}
source = source.replaceAll(/from\s+"\.\.\/\.\.\/(chunk-[A-Z0-9]+\.js)"/g, 'from "./$1"');
source = source.replaceAll(/import\s+"\.\.\/\.\.\/(chunk-[A-Z0-9]+\.js)"/g, 'import "./$1"');
await writeFile(pluginEntry, source);
