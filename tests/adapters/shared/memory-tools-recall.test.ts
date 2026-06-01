import { describe, expect, it, vi } from "vitest";

import { parseRecallToolParams, runRecallMemoryTool } from "../../../src/adapters/shared/memory-tools.js";
import type { MemoryToolParamReader } from "../../../src/adapters/shared/memory-tools.js";
import { runUnifiedRecall, type UnifiedRecallResult } from "../../../src/app/recall/index.js";

vi.mock("../../../src/app/recall/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/recall/index.js")>();
  return {
    ...actual,
    runUnifiedRecall: vi.fn(),
  };
});

const READER: MemoryToolParamReader = {
  readString(params, key, options) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (options?.required) {
        throw new Error(`${options.label ?? key} is required.`);
      }
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`${options?.label ?? key} must be a string.`);
    }
    return value;
  },
  readNumber(params, key, options) {
    const value = params[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${key} must be a number.`);
    }
    if (options?.integer && !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer.`);
    }
    if (options?.strict && value < 0) {
      throw new Error(`${key} must be non-negative.`);
    }
    return value;
  },
  readStringArray(params, key) {
    const value = params[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${key} must be an array of strings.`);
    }
    return value;
  },
};

describe("agenr_recall shared tool params", () => {
  it("parses optional budget", () => {
    expect(parseRecallToolParams({ query: "skeln architecture", budget: 500 }, READER)).toMatchObject({
      query: "skeln architecture",
      budget: 500,
    });
  });

  it("rejects non-positive budget values", () => {
    expect(() => parseRecallToolParams({ query: "skeln architecture", budget: 0 }, READER)).toThrow("budget must be a positive integer.");
  });

  it("passes budget through to unified recall", async () => {
    const mockedRunUnifiedRecall = vi.mocked(runUnifiedRecall);
    mockedRunUnifiedRecall.mockResolvedValue({
      routing: {
        requested: "entries",
        detectedIntent: "factual",
        queried: ["entries"],
        reason: "Entry recall requested.",
      },
      procedureCandidates: [],
      procedureNotices: [],
      episodes: [],
      entries: [],
      projectedEntries: [],
      entryFamilies: [],
      claimTransitions: [],
      notices: [],
      count: 0,
    } satisfies UnifiedRecallResult);

    await runRecallMemoryTool(
      parseRecallToolParams({ query: "skeln architecture", mode: "entries", budget: 750 }, READER),
      {
        episodes: {} as never,
        procedures: {} as never,
        recall: {} as never,
        embeddingStatus: { available: true },
      },
      { sessionKey: "session:test" },
    );

    expect(mockedRunUnifiedRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "skeln architecture",
        mode: "entries",
        budget: 750,
        sessionKey: "session:test",
      }),
      expect.anything(),
    );
  });
});
