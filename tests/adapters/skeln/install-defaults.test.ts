import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SKELN_INSTALL_MEMORY_POLICY_JSON } from "../../../src/adapters/skeln/default-install-settings.js";

describe("@agenr/skeln-plugin install defaults", () => {
  it("declares the default Skeln memoryPolicy JSON in the publish manifest", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "packages", "skeln-plugin", "package.json"), "utf8")) as {
      skeln?: {
        config?: {
          memoryPolicy?: {
            default?: string;
          };
        };
      };
    };

    expect(packageJson.skeln?.config?.memoryPolicy?.default).toBe(DEFAULT_SKELN_INSTALL_MEMORY_POLICY_JSON);
  });
});
