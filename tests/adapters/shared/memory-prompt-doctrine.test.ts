import { describe, expect, it } from "vitest";

import { buildAgenrMemoryPromptSection } from "../../../src/adapters/openclaw/format/prompt-section.js";
import { registerAgenrSkelnRecallTool } from "../../../src/adapters/skeln/tools/recall.js";
import { registerAgenrSkelnStoreTool } from "../../../src/adapters/skeln/tools/store.js";
import { registerAgenrSkelnUpdateTool } from "../../../src/adapters/skeln/tools/update.js";
import { buildAgenrSkelnMemoryPromptSection } from "../../../src/adapters/skeln/format/prompt-section.js";
import { createAgenrUpdateTool } from "../../../src/adapters/openclaw/tools.js";
import type { AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import type { ExtensionAPI } from "../../../src/adapters/skeln/skeln-types.js";
import type { AgenrSkelnServices } from "../../../src/adapters/skeln/runtime.js";
import {
  buildOpenClawStorePromptLines,
  buildOpenClawStoreToolDescription,
  buildSkelnStoreToolDescription,
  buildStoreToolGuidelines,
  buildUpdateToolDescription,
  buildUpdateToolGuidelines,
  MEMORY_DOCTRINE,
  RECALL_MODE_SCHEMA_DESCRIPTION,
} from "../../../src/adapters/shared/memory-prompt-doctrine.js";
import { RECALL_TOOL_PARAMETERS } from "../../../src/adapters/shared/memory-tools.js";

describe("memory prompt doctrine", () => {
  it("keeps shared recall atoms aligned across Skeln and OpenClaw prompts", () => {
    const skelnPrompt = buildAgenrSkelnMemoryPromptSection().join("\n");
    const openClawPrompt = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "agenr_fetch", "agenr_store"]),
      citationsMode: "off",
    }).join("\n");

    expect(skelnPrompt).toContain(MEMORY_DOCTRINE.recall.first);
    expect(openClawPrompt).toContain(MEMORY_DOCTRINE.recall.first);
    expect(skelnPrompt).toContain(MEMORY_DOCTRINE.recall.modes);
    expect(openClawPrompt).toContain(MEMORY_DOCTRINE.recall.modes);
    expect(skelnPrompt).toContain(MEMORY_DOCTRINE.recall.injectedContext);
    expect(openClawPrompt).toContain(MEMORY_DOCTRINE.recall.injectedContext);
    expect(skelnPrompt).toContain(MEMORY_DOCTRINE.recall.truncatedPreviewsWithFetch);
    expect(openClawPrompt).toContain(MEMORY_DOCTRINE.recall.truncatedPreviews);
    expect(openClawPrompt).toContain(MEMORY_DOCTRINE.recall.fetchWhenTruncated);
  });

  it("keeps OpenClaw store prompt doctrine non-redundant", () => {
    const prompt = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "agenr_store"]),
      citationsMode: "off",
    }).join("\n");

    expect(prompt).toContain(MEMORY_DOCTRINE.store.openClawNotLogging);
    expect(prompt).toContain(MEMORY_DOCTRINE.store.canonicalRecord);
    expect(prompt).toContain(MEMORY_DOCTRINE.store.claimKeyPromptLine);
    expect(prompt).not.toContain(MEMORY_DOCTRINE.store.claimKeyStoreGuideline);

    const progressLogMentions = prompt.match(/Do not store progress logs/g) ?? [];
    expect(progressLogMentions).toHaveLength(0);
  });

  it("keeps store tool surfaces on the shared guideline bundle", () => {
    const openClawToolDescription = buildOpenClawStoreToolDescription();
    const skelnToolDescription = buildSkelnStoreToolDescription();

    for (const guideline of buildStoreToolGuidelines()) {
      expect(openClawToolDescription).toContain(guideline);
    }

    expect(openClawToolDescription).toContain(MEMORY_DOCTRINE.store.canonicalRecord);
    expect(openClawToolDescription).toContain("future-session test");
    expect(skelnToolDescription).toContain("future Skeln session make a better decision");
  });

  it("keeps update descriptions aligned across host adapters", () => {
    const sharedDescription = buildUpdateToolDescription();
    const skelnUpdate = registerSkelnTool("agenr_update");
    const openClawUpdate = createAgenrUpdateTool(createOpenClawToolContext(), Promise.resolve({} as AgenrOpenClawServices), createLogger());

    expect(skelnUpdate?.description).toBe(sharedDescription);
    expect(String(openClawUpdate.description)).toBe(sharedDescription);

    for (const guideline of buildUpdateToolGuidelines()) {
      expect(sharedDescription).toContain(guideline);
    }
  });

  it("keeps Skeln system prompt store and update atoms on shared doctrine", () => {
    const prompt = buildAgenrSkelnMemoryPromptSection().join("\n");

    expect(prompt).toContain(MEMORY_DOCTRINE.store.skelnNotLogging);
    expect(prompt).toContain(MEMORY_DOCTRINE.update.vsSupersedes);
    expect(prompt).toContain(MEMORY_DOCTRINE.store.claimKeyPromptLine);
  });

  it("wires recall mode schema text from shared doctrine", () => {
    const mode = RECALL_TOOL_PARAMETERS.properties.mode as { description?: string };

    expect(mode.description).toBe(RECALL_MODE_SCHEMA_DESCRIPTION);
    expect(mode.description).toBe(MEMORY_DOCTRINE.recall.modeSchema);
  });

  it("composes OpenClaw store prompt lines without guideline-bundle duplication", () => {
    const promptLines = buildOpenClawStorePromptLines();

    expect(promptLines).not.toEqual(expect.arrayContaining(buildStoreToolGuidelines()));
    expect(promptLines).toContain(MEMORY_DOCTRINE.store.canonicalRecord);
  });
});

interface RegisteredTool {
  name: string;
  description?: string;
}

function registerSkelnTool(name: string): RegisteredTool | undefined {
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
  registerAgenrSkelnRecallTool(skeln, services, resolveScope);

  return tools.find((tool) => tool.name === name);
}

function createOpenClawToolContext() {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:webchat:test",
  };
}

function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}
