import { describe, expect, it } from "vitest";

import { formatUnifiedRecallResults } from "../../../src/adapters/shared/recall-format.js";
import { createUnifiedRecallResult } from "./fixtures/unified-recall-result.js";

describe("formatUnifiedRecallResults fetch guidance", () => {
  it("marks truncated previews and appends agenr_fetch guidance", () => {
    const fullContent = `${"Skeln is a local-first terminal agent app. ".repeat(8)}The full body must remain available through agenr_fetch after recall previews truncate it.`;
    const text = formatUnifiedRecallResults(createUnifiedRecallResult(fullContent));

    expect(text).toContain("Recall Route");
    expect(text).toContain("content_chars=");
    expect(text).toContain("preview_truncated=true");
    expect(text).toContain("Fetch Guidance");
    expect(text).toContain("agenr_fetch");
    expect(text).not.toContain(fullContent);
    expect(text).toContain("...");
  });

  it("omits fetch guidance when previews are not truncated", () => {
    const text = formatUnifiedRecallResults(createUnifiedRecallResult("Short durable fact."));

    expect(text).not.toContain("Fetch Guidance");
    expect(text).toContain("preview_truncated=false");
  });
});
