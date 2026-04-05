import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const pkgDir = new URL(".", import.meta.url).pathname;
const root = path.resolve(pkgDir, "..", "..");
const distDir = path.join(pkgDir, "dist");
await mkdir(distDir, { recursive: true });
await copyFile(path.join(root, "dist", "adapters", "openclaw", "index.js"), path.join(distDir, "index.js"));

const source = await readFile(path.join(root, "dist", "adapters", "openclaw", "index.js"), "utf8");
const rewritten = source.replaceAll('from "openclaw/', 'from "openclaw/').replaceAll('from "./', 'from "./');
await writeFile(path.join(distDir, "index.js"), rewritten);
