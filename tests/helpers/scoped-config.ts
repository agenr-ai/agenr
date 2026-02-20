import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ScopedProjectConfigParams {
  project: string;
  dependencies?: string[];
}

export interface ScopedProjectConfigOptions {
  prefix?: string;
  tempDirs?: string[];
}

export async function createScopedProjectConfig(
  params: ScopedProjectConfigParams,
  options: ScopedProjectConfigOptions = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix ?? "agenr-scoped-project-"));
  options.tempDirs?.push(dir);
  await fs.mkdir(path.join(dir, ".agenr"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".agenr", "config.json"),
    `${JSON.stringify(
      {
        project: params.project,
        dependencies: params.dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return dir;
}
