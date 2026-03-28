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
    expect(lines.join("\n")).toContain("supports temporal recall");
    expect(lines.join("\n")).toContain("future-session test");
    expect(lines.join("\n")).toContain("Importance is 1 to 10");
    expect(lines.join("\n")).toContain("fix it with agenr_update or agenr_retire");
    expect(lines.join("\n")).toContain("Use agenr_trace");
    expect(lines.join("\n")).toContain("Citations are disabled");
  });
});
