import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Points config resolution at an empty isolated directory for the duration of a test.
 *
 * @param root - Temporary directory that should own `config.json`.
 */
export async function useIsolatedAgenrConfig(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), "{}\n", "utf8");
  process.env.AGENR_CONFIG_DIR = root;
  delete process.env.AGENR_CONFIG_PATH;
}
