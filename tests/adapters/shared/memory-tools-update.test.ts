import { describe, expect, it, vi } from "vitest";

import { runUpdateMemoryTool } from "../../../src/adapters/shared/memory-tools.js";
import type { DatabasePort } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";

const durable: Durable = {
  id: "entry-1",
  type: "fact",
  subject: "Workspace scope",
  content: "The agenr repo uses pnpm workspaces.",
  importance: 7,
  expiry: "permanent",
  tags: ["agenr"],
  quality_score: 0.5,
  recall_count: 0,
  project: "openclaw",
  created_at: "2026-05-31T00:00:00.000Z",
  updated_at: "2026-05-31T00:00:00.000Z",
};

describe("agenr_update shared tool flow", () => {
  it("rejects calls with no update fields", async () => {
    await expect(
      runUpdateMemoryTool(
        {
          id: "entry-1",
          subject: undefined,
          importance: undefined,
          expiry: undefined,
          claimKeyInput: undefined,
          validFrom: undefined,
          validTo: undefined,
          project: undefined,
        },
        buildServices(),
        buildOptions(),
      ),
    ).rejects.toThrow("Provide at least one update field.");
  });

  it("updates project metadata in place", async () => {
    const updateDurable = vi.fn(async () => true);
    const outcome = await runUpdateMemoryTool(
      {
        id: "entry-1",
        subject: undefined,
        importance: undefined,
        expiry: undefined,
        claimKeyInput: undefined,
        validFrom: undefined,
        validTo: undefined,
        project: "agenr",
      },
      buildServices(updateDurable),
      buildOptions(),
    );

    expect(outcome.failed).toBe(false);
    expect(updateDurable).toHaveBeenCalledWith("entry-1", { project: "agenr" });
    expect(outcome.details).toMatchObject({
      status: "updated",
      durableId: durable.id,
      project: "agenr",
    });
  });

  it("clears project metadata when project is an empty string", async () => {
    const updateDurable = vi.fn(async () => true);
    const outcome = await runUpdateMemoryTool(
      {
        id: "entry-1",
        subject: undefined,
        importance: undefined,
        expiry: undefined,
        claimKeyInput: undefined,
        validFrom: undefined,
        validTo: undefined,
        project: "",
      },
      buildServices(updateDurable),
      buildOptions(),
    );

    expect(outcome.failed).toBe(false);
    expect(updateDurable).toHaveBeenCalledWith("entry-1", { project: "" });
    expect(outcome.details).toMatchObject({
      status: "updated",
      project: null,
    });
  });
});

function buildServices(updateDurable: DatabasePort["updateDurable"] = async () => true) {
  return {
    durables: {
      getDurable: async (durableId: string) => (durableId === durable.id ? durable : null),
      updateDurable,
    } as DatabasePort,
    embedding: {} as never,
    memory: {
      findDurableBySubject: async () => durable,
      findMostRecentDurable: async () => durable,
      getDurableTrace: async () => null,
    },
  };
}

function buildOptions() {
  return {
    session: {
      sessionId: "session-1",
      agentId: "main",
      channel: "webchat",
      chatType: "direct",
    },
    sourcePrefix: "openclaw-session" as const,
  };
}
