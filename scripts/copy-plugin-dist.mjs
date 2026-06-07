import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Root dist entrypoints that should not ship inside plugin packages. */
const PLUGIN_DIST_ENTRY_EXCLUDES = new Set([
  "cli.js",
  "internal-eval-server.js",
  "internal-recall-eval-server.js",
]);

/**
 * Copies a root `dist/adapters/<adapter>` entry into a publishable plugin package.
 *
 * @param {object} options - Copy options.
 * @param {string} options.root - Repository root.
 * @param {string} options.pluginDist - Plugin package dist directory.
 * @param {string} options.adapterName - Adapter directory name under `dist/adapters/`.
 * @param {boolean} [options.includeTypes=false] - Whether to copy adapter type declarations.
 * @returns {Promise<{ copiedChunks: string[]; copiedSharedArtifacts: string[]; copiedDeclarations: string[]; finalFiles: string[] }>}
 */
export async function copyPluginDist({ root, pluginDist, adapterName, includeTypes = false }) {
  const rootDist = path.join(root, "dist");
  const rootEntry = path.join(rootDist, "adapters", adapterName, "index.js");
  const pluginEntry = path.join(pluginDist, "index.js");

  await access(rootEntry);

  await rm(pluginDist, { recursive: true, force: true });
  await mkdir(pluginDist, { recursive: true });

  let source = await readFile(rootEntry, "utf8");
  const allRootDistFiles = await readdir(rootDist);
  const chunkFiles = allRootDistFiles.filter((name) => name.startsWith("chunk-") && name.endsWith(".js"));
  const sharedArtifactFiles = listSharedDistArtifacts(allRootDistFiles);
  for (const artifact of [...chunkFiles, ...sharedArtifactFiles]) {
    await copyFile(path.join(rootDist, artifact), path.join(pluginDist, artifact));
  }

  source = source.replaceAll("../../", "./");
  await writeFile(pluginEntry, source);

  const copiedDeclarations = [];
  if (includeTypes) {
    const rootTypesEntry = path.join(rootDist, "adapters", adapterName, "index.d.ts");
    let types = await readFile(rootTypesEntry, "utf8");
    const declarationFiles = collectReferencedDeclarationFiles(types, allRootDistFiles);
    for (const declarationFile of declarationFiles) {
      await copyFile(path.join(rootDist, declarationFile), path.join(pluginDist, declarationFile));
      copiedDeclarations.push(declarationFile);
    }

    types = types.replaceAll("../../", "./");
    await writeFile(path.join(pluginDist, "index.d.ts"), types);
  }

  return {
    copiedChunks: chunkFiles.sort(),
    copiedSharedArtifacts: sharedArtifactFiles.sort(),
    copiedDeclarations: copiedDeclarations.sort(),
    finalFiles: (await readdir(pluginDist)).sort(),
  };
}

/**
 * Lists root dist JavaScript artifacts that chunks or adapters import dynamically.
 *
 * @param {string[]} allRootDistFiles
 * @returns {string[]}
 */
function listSharedDistArtifacts(allRootDistFiles) {
  return allRootDistFiles.filter(
    (name) => name.endsWith(".js") && !name.startsWith("chunk-") && !PLUGIN_DIST_ENTRY_EXCLUDES.has(name),
  );
}

/**
 * @param {string} typesSource
 * @param {string[]} allRootDistFiles
 * @returns {string[]}
 */
function collectReferencedDeclarationFiles(typesSource, allRootDistFiles) {
  const matches = typesSource.matchAll(/from ["']\.\.\/\.\.\/([^"']+)["']/g);
  const referenced = new Set();

  for (const match of matches) {
    const importPath = match[1];
    if (!importPath) {
      continue;
    }

    const declarationFile = resolveDeclarationFile(importPath, allRootDistFiles);
    if (declarationFile) {
      referenced.add(declarationFile);
    }
  }

  return [...referenced];
}

/**
 * @param {string} importPath
 * @param {string[]} allRootDistFiles
 * @returns {string | undefined}
 */
function resolveDeclarationFile(importPath, allRootDistFiles) {
  if (importPath.endsWith(".d.ts") && allRootDistFiles.includes(importPath)) {
    return importPath;
  }

  const declarationName = `${importPath.replace(/\.js$/u, "")}.d.ts`;
  if (allRootDistFiles.includes(declarationName)) {
    return declarationName;
  }

  return undefined;
}
