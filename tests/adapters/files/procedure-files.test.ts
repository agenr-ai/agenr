import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { discoverProcedureFiles, readProcedureFile } from "../../../src/adapters/files/procedure-files.js";

describe("procedure-files adapter", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", { recursive: true, force: true });
    }
  });

  it("discovers yaml procedure files recursively in sorted order", async () => {
    const rootDir = await createTempDir();
    const nestedDir = path.join(rootDir, "nested");
    await mkdir(nestedDir);
    await writeFile(path.join(rootDir, "b-procedure.yml"), "procedure_key: agenr/b\n");
    await writeFile(path.join(rootDir, "ignore.txt"), "ignore");
    await writeFile(path.join(nestedDir, "a-procedure.yaml"), "procedure_key: agenr/a\n");

    const files = await discoverProcedureFiles(rootDir);

    expect(files).toEqual([path.join(rootDir, "b-procedure.yml"), path.join(nestedDir, "a-procedure.yaml")]);
  });

  it("accepts one yaml file target and rejects non-yaml files", async () => {
    const rootDir = await createTempDir();
    const yamlPath = path.join(rootDir, "procedure.yaml");
    const textPath = path.join(rootDir, "notes.txt");
    await writeFile(yamlPath, "procedure_key: agenr/test\n");
    await writeFile(textPath, "ignore");

    await expect(discoverProcedureFiles(yamlPath)).resolves.toEqual([yamlPath]);
    await expect(discoverProcedureFiles(textPath)).resolves.toEqual([]);
  });

  it("reads raw procedure file contents", async () => {
    const rootDir = await createTempDir();
    const yamlPath = path.join(rootDir, "procedure.yaml");
    await writeFile(yamlPath, "procedure_key: agenr/test\n");

    await expect(readProcedureFile(yamlPath)).resolves.toBe("procedure_key: agenr/test\n");
  });

  async function createTempDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-procedure-files-"));
    tempDirs.push(directory);
    return directory;
  }
});
