import { describe, expect, it } from "vitest";

import { ENTRY_FETCH_MAX_CONTENT_CHARS } from "../../../src/adapters/shared/memory-tool-format.js";
import { parseFetchToolParams, runFetchMemoryTool } from "../../../src/adapters/shared/memory-tools.js";
import type { MemoryToolParamReader } from "../../../src/adapters/shared/memory-tools.js";
import type { Entry } from "../../../src/core/types.js";

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
  readNumber() {
    return undefined;
  },
  readStringArray() {
    return undefined;
  },
};

const entry: Entry = {
  id: "entry-1",
  type: "fact",
  subject: "Skeln architecture",
  content: "Skeln runtime extensions are reloadable and project-local.",
  importance: 8,
  expiry: "permanent",
  tags: ["skeln"],
  quality_score: 0.5,
  recall_count: 0,
  retired: false,
  created_at: "2026-05-31T00:00:00.000Z",
  updated_at: "2026-05-31T00:00:00.000Z",
};

describe("agenr_fetch shared tool flow", () => {
  it("parses id and subject selectors", () => {
    expect(parseFetchToolParams({ id: "entry-1" }, READER)).toEqual({ id: "entry-1", subject: undefined });
    expect(parseFetchToolParams({ subject: "Skeln architecture" }, READER)).toEqual({ id: undefined, subject: "Skeln architecture" });
  });

  it("returns the full entry body", async () => {
    const outcome = await runFetchMemoryTool(
      { id: "entry-1", subject: undefined },
      {
        entries: {
          getEntry: async (entryId) => (entryId === entry.id ? entry : null),
        },
        embedding: {} as never,
        memory: {
          findEntryBySubject: async () => entry,
          findMostRecentEntry: async () => entry,
          getEntryTrace: async () => null,
        },
      },
    );

    expect(outcome.failed).toBe(false);
    expect(outcome.text).toContain(entry.content);
    expect(outcome.details).toMatchObject({
      status: "ok",
      entryId: entry.id,
      content: entry.content,
    });
  });

  it("rejects entry bodies above the fetch size limit", async () => {
    const oversizedEntry: Entry = {
      ...entry,
      content: "x".repeat(ENTRY_FETCH_MAX_CONTENT_CHARS + 1),
    };

    await expect(
      runFetchMemoryTool(
        { id: "entry-1", subject: undefined },
        {
          entries: {
            getEntry: async () => oversizedEntry,
          },
          embedding: {} as never,
          memory: {
            findEntryBySubject: async () => oversizedEntry,
            findMostRecentEntry: async () => oversizedEntry,
            getEntryTrace: async () => null,
          },
        },
      ),
    ).rejects.toThrow(`exceeds the agenr_fetch limit of ${ENTRY_FETCH_MAX_CONTENT_CHARS}`);
  });
});
