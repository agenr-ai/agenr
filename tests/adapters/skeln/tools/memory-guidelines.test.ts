import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../../src/adapters/skeln/skeln-types.js";

import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";
import { buildUpdateToolDescription } from "../../../../src/adapters/shared/memory-prompt-doctrine.js";
import { registerAgenrSkelnStoreTool } from "../../../../src/adapters/skeln/tools/store.js";
import { registerAgenrSkelnUpdateTool } from "../../../../src/adapters/skeln/tools/update.js";

describe("Skeln memory tool guidelines", () => {
  it("keeps durable-store guardrails on the store tool surface", () => {
    const tools = registerMemoryTools();
    const store = tools.find((tool) => tool.name === "agenr_store");

    expect(store?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Do not store progress logs"),
        expect.stringContaining("Store the durable takeaway"),
        expect.stringContaining("Use claimKey only for slot-like facts"),
        expect.stringContaining("Format claimKey (only for slot-like durables)"),
      ]),
    );
  });

  it("keeps substantive replacement guidance on the update tool surface", () => {
    const tools = registerMemoryTools();
    const update = tools.find((tool) => tool.name === "agenr_update");

    expect(update?.description).toBe(buildUpdateToolDescription());
    expect(update?.promptGuidelines).toEqual(
      expect.arrayContaining(["Provide exactly one target selector: id or subject.", "Use agenr_store with supersedes for substantive content replacement."]),
    );
  });
});

interface RegisteredTool {
  name: string;
  description?: string;
  promptGuidelines?: string[];
}

function registerMemoryTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const skeln = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  const services = Promise.resolve({} as AgenrSkelnServices);
  const resolveScope = async () => ({
    sessionId: "session-1",
    sessionKey: "skeln:session:session-1",
    cwd: "/tmp/project",
  });

  registerAgenrSkelnStoreTool(skeln, services, resolveScope);
  registerAgenrSkelnUpdateTool(skeln, services, resolveScope);

  return tools;
}
