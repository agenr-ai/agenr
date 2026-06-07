import { describe, expect, it } from "vitest";

import { DURABLE_FETCH_MAX_CONTENT_CHARS } from "../../../src/adapters/shared/memory-tool-format.js";
import { parseFetchToolParams, runFetchMemoryTool } from "../../../src/adapters/shared/memory-tools.js";
import type { MemoryToolParamReader } from "../../../src/adapters/shared/memory-tools.js";
import type { DatabasePort } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";

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

const durable: Durable = {
  id: "entry-1",
  type: "fact",
  subject: "Skeln architecture",
  content: "Skeln runtime extensions are reloadable and project-local.",
  importance: 8,
  expiry: "permanent",
  tags: ["skeln"],
  quality_score: 0.5,
  recall_count: 0,
  created_at: "2026-05-31T00:00:00.000Z",
  updated_at: "2026-05-31T00:00:00.000Z",
};

describe("agenr_fetch shared tool flow", () => {
  it("parses id and subject selectors", () => {
    expect(parseFetchToolParams({ id: "entry-1" }, READER)).toEqual({ id: "entry-1", subject: undefined });
    expect(parseFetchToolParams({ subject: "Skeln architecture" }, READER)).toEqual({ id: undefined, subject: "Skeln architecture" });
  });

  it("returns the full durable body", async () => {
    const outcome = await runFetchMemoryTool(
      { id: "entry-1", subject: undefined },
      {
        durables: {
          getDurable: async (durableId: string) => (durableId === durable.id ? durable : null),
        } as DatabasePort,
        embedding: {} as never,
        memory: {
          findDurableBySubject: async () => durable,
          getDurableTrace: async () => null,
        },
      },
    );

    expect(outcome.failed).toBe(false);
    expect(outcome.text).toContain(durable.content);
    expect(outcome.details).toMatchObject({
      status: "ok",
      durableId: durable.id,
      content: durable.content,
    });
  });

  it("rejects durable bodies above the fetch size limit", async () => {
    const oversizedEntry: Durable = {
      ...durable,
      content: "x".repeat(DURABLE_FETCH_MAX_CONTENT_CHARS + 1),
    };

    await expect(
      runFetchMemoryTool(
        { id: "entry-1", subject: undefined },
        {
          durables: {
            getDurable: async (_id: string): Promise<Durable | null> => oversizedEntry,
          } as DatabasePort,
          embedding: {} as never,
          memory: {
            findDurableBySubject: async () => oversizedEntry,
            getDurableTrace: async () => null,
          },
        },
      ),
    ).rejects.toThrow(`exceeds the agenr_fetch limit of ${DURABLE_FETCH_MAX_CONTENT_CHARS}`);
  });
});
