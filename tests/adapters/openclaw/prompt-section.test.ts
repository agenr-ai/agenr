import { describe, expect, it } from "vitest";

import { buildAgenrMemoryPromptSection } from "../../../src/adapters/openclaw/format/prompt-section.js";

describe("buildAgenrMemoryPromptSection", () => {
  it("returns empty guidance when recall is unavailable", () => {
    expect(buildAgenrMemoryPromptSection({ availableTools: new Set(["agenr_store"]) })).toEqual([]);
  });

  it("renders guidance for the agenr toolset", () => {
    const lines = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "agenr_store", "agenr_update", "agenr_retire", "agenr_trace"]),
      citationsMode: "off",
    });

    expect(lines.join("\n")).toContain("## Memory Recall");
    expect(lines.join("\n")).toContain("call agenr_recall first");
    expect(lines.join("\n")).toContain("supports two recall kinds");
    expect(lines.join("\n")).toContain("mode=entries");
    expect(lines.join("\n")).toContain("mode=episodes");
    expect(lines.join("\n")).toContain("Memory authority");
    expect(lines.join("\n")).toContain("One focused agenr_recall call with the right scope beats several broad ones.");
    expect(lines.join("\n")).toContain("future-session test");
    expect(lines.join("\n")).toContain("Do not store progress snapshots");
    expect(lines.join("\n")).toContain("Do not store plans, checklists, or speculative future state");
    expect(lines.join("\n")).toContain("Importance is 1 to 10");
    expect(lines.join("\n")).toContain("contradicted by live evidence");
    expect(lines.join("\n")).toContain("Use agenr_trace");
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
