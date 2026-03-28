import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(repoRoot, "src", "adapters", "openclaw");
const outputDir = path.join(repoRoot, "dist", "adapters", "openclaw");

const copiedFiles = ["openclaw.plugin.json", "package.json"];

await fs.mkdir(outputDir, { recursive: true });

for (const filename of copiedFiles) {
  const sourcePath = path.join(sourceDir, filename);
  const outputPath = path.join(outputDir, filename);
  await fs.copyFile(sourcePath, outputPath);
}
