import { describe, expect, it } from "vitest";

import { buildAgenrMemoryPromptSection } from "../../../src/adapters/openclaw/format/prompt-section.js";
import { MEMORY_DOCTRINE } from "../../../src/adapters/shared/memory-prompt-doctrine.js";

describe("buildAgenrMemoryPromptSection", () => {
  it("returns empty guidance when recall is unavailable", () => {
    expect(buildAgenrMemoryPromptSection({ availableTools: new Set(["agenr_store"]) })).toEqual([]);
  });

  it("renders guidance for the agenr toolset", () => {
    const lines = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "agenr_store", "agenr_update", "agenr_fetch"]),
      citationsMode: "off",
    });

    expect(lines.join("\n")).toContain("## Memory Recall");
    expect(lines.join("\n")).toContain("call agenr_recall first");
    expect(lines.join("\n")).toContain("injected background context");
    expect(lines.join("\n")).toContain("historical and episodic recall");
    expect(lines.join("\n")).toContain("mode=durables");
    expect(lines.join("\n")).toContain("mode=auto");
    expect(lines.join("\n")).toContain("mode=episodes");
    expect(lines.join("\n")).toContain("what was the previous approach");
    expect(lines.join("\n")).toContain("what changed from X to Y");
    expect(lines.join("\n")).toContain("Memory authority");
    expect(lines.join("\n")).toContain("One focused agenr_recall call with the right scope beats several broad ones.");
    expect(lines.join("\n")).toContain("non-user background context");
    expect(lines.join("\n")).toContain("future-session test");
    expect(lines.join("\n")).toContain("canonical record");
    expect(lines.join("\n")).toContain("version control");
    expect(lines.join("\n")).toContain("Type guide:");
    expect(lines.join("\n")).toContain("Do not use decision as a catch-all");
    expect(lines.join("\n")).toContain("I merged PR #123.");
    expect(lines.join("\n")).toContain("Jim prefers text-first updates");
    expect(lines.join("\n")).toContain("Do not store progress snapshots");
    expect(lines.join("\n")).toContain("Do not store plans, checklists, or speculative future state");
    expect(lines.join("\n")).toContain("Importance is 1 to 10");
    expect(lines.join("\n")).toContain(MEMORY_DOCTRINE.store.claimKeyPromptLine);
    expect(lines.join("\n")).toContain(MEMORY_DOCTRINE.update.vsSupersedes);
    expect(lines.join("\n")).not.toContain("Do not store progress logs");
    expect(lines.join("\n")).toContain("contradicted by live evidence");
    expect(lines.join("\n")).not.toContain("unfinished background work");
    expect(lines.join("\n")).toContain("Citations are disabled");
  });

  it("adds delegation discipline when orchestration tools are present", () => {
    const lines = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "spawn_subagent"]),
    });

    expect(lines.join("\n")).toContain("unfinished background work");
    expect(lines.join("\n")).toContain("delegated tasks");
  });
});
