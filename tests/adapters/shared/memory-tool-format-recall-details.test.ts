import { describe, expect, it } from "vitest";

import { buildEntryRecallPreview, buildRecallToolDetails, ENTRY_PREVIEW_MAX_CHARS } from "../../../src/adapters/shared/memory-tool-format.js";
import { createUnifiedRecallResult } from "./fixtures/unified-recall-result.js";

describe("buildRecallToolDetails entry previews", () => {
  it("omits full entry bodies and exposes preview metadata instead", () => {
    const fullContent = `${"Skeln is a local-first terminal agent app. ".repeat(8)}Full body must not appear in recall details.`;
    const preview = buildEntryRecallPreview(fullContent);
    const details = buildRecallToolDetails(createUnifiedRecallResult(fullContent));

    expect(preview.previewTruncated).toBe(true);
    expect(details.entries).toEqual([
      expect.objectContaining({
        id: "entry-1",
        contentPreview: preview.contentPreview,
        contentChars: fullContent.trim().length,
        previewTruncated: true,
      }),
    ]);
    expect(details.projectedEntries).toEqual([
      expect.objectContaining({
        id: "entry-1",
        contentPreview: preview.contentPreview,
        contentChars: fullContent.trim().length,
        previewTruncated: true,
      }),
    ]);
    expect(JSON.stringify(details)).not.toContain(fullContent);
    expect((details.entries as Array<Record<string, unknown>>)[0]).not.toHaveProperty("content");
  });

  it("includes untruncated preview text when content fits the cap", () => {
    const content = "Short durable fact.";
    const details = buildRecallToolDetails(createUnifiedRecallResult(content));

    expect(details.entries).toEqual([
      expect.objectContaining({
        contentPreview: content,
        contentChars: content.length,
        previewTruncated: false,
      }),
    ]);
    expect(content.length).toBeLessThanOrEqual(ENTRY_PREVIEW_MAX_CHARS);
  });
});
