import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  BeforeResetEvent,
  PluginHookAgentContext,
} from "../../src/openclaw-plugin/types.js";

type BeforePromptBuildHandler = (
  event: BeforePromptBuildEvent,
  ctx: PluginHookAgentContext,
) => Promise<BeforePromptBuildResult | undefined>;

type BeforeResetHandler = (event: BeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void>;

const indexModulePath = "../../src/openclaw-plugin/index.js";
const recallModulePath = "../../src/openclaw-plugin/recall.js";
const sessionQueryModulePath = "../../src/openclaw-plugin/session-query.js";
const dbClientModulePath = "../../src/db/client.js";
const configModulePath = "../../src/config.js";
const feedbackModulePath = "../../src/db/feedback.js";
const coRecallModulePath = "../../src/db/co-recall.js";
const reviewQueueModulePath = "../../src/db/review-queue.js";
const toolsModulePath = "../../src/openclaw-plugin/tools.js";

async function registerPlugin(pluginConfig?: Record<string, unknown>): Promise<{
  beforePromptBuildHandler: BeforePromptBuildHandler;
  beforeResetHandler: BeforeResetHandler;
}> {
  const mod = await import(indexModulePath);
  const plugin = mod.default;

  let beforePromptBuildHandler: BeforePromptBuildHandler | null = null;
  let beforeResetHandler: BeforeResetHandler | null = null;

  const api = {
    id: "agenr",
    name: "agenr",
    pluginConfig,
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    on: (hook: string, handler: unknown) => {
      if (hook === "before_prompt_build") {
        beforePromptBuildHandler = handler as BeforePromptBuildHandler;
      }
      if (hook === "before_reset") {
        beforeResetHandler = handler as BeforeResetHandler;
      }
    },
  };

  plugin.register(api as never);

  if (!beforePromptBuildHandler || !beforeResetHandler) {
    throw new Error("Expected before_prompt_build and before_reset handlers");
  }

  return {
    beforePromptBuildHandler,
    beforeResetHandler,
  };
}

function buildRecallResults(ids: string[]): {
  query: string;
  results: Array<{ entry: { id: string; type: string; subject: string; content: string }; score: number }>;
} {
  return {
    query: "",
    results: ids.map((id) => ({
      entry: {
        id,
        type: "fact",
        subject: `subject-${id}`,
        content: `content-${id}`,
      },
      score: 0.9,
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock(recallModulePath);
  vi.doUnmock(sessionQueryModulePath);
  vi.doUnmock(dbClientModulePath);
  vi.doUnmock(configModulePath);
  vi.doUnmock(feedbackModulePath);
  vi.doUnmock(coRecallModulePath);
  vi.doUnmock(reviewQueueModulePath);
  vi.doUnmock(toolsModulePath);
});

describe("openclaw plugin before_reset phase 2", () => {
  it("calls strengthenCoRecallEdges with used IDs returned from feedback", async () => {
    vi.resetModules();

    const fakeDb = { execute: vi.fn(async () => ({ rows: [], rowsAffected: 0 })) };
    const strengthenCoRecallEdges = vi.fn(async () => undefined);
    const computeRecallFeedback = vi.fn(async () => ({
      usedIds: ["e1", "e2"],
      correctedIds: [],
      updatedIds: [],
    }));

    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => buildRecallResults(["e1", "e2"])),
      formatRecallAsMarkdown: vi.fn(() => ""),
    }));
    vi.doMock(sessionQueryModulePath, () => ({
      buildSemanticSeed: vi.fn(() => ""),
      extractLastExchangeText: vi.fn(() => ""),
      extractRecentTurns: vi.fn(async () => ""),
      findPreviousSessionFile: vi.fn(async () => null),
      stripPromptMetadata: vi.fn((text: string) => text),
    }));
    vi.doMock(dbClientModulePath, () => ({
      getDb: vi.fn(() => fakeDb),
      initDb: vi.fn(async () => undefined),
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(configModulePath, () => ({
      readConfig: vi.fn(() => ({ models: { extraction: "x", claimExtraction: "x", contradictionJudge: "x", handoffSummary: "x" } })),
    }));
    vi.doMock(feedbackModulePath, () => ({ computeRecallFeedback }));
    vi.doMock(coRecallModulePath, () => ({
      strengthenCoRecallEdges,
    }));
    vi.doMock(reviewQueueModulePath, () => ({
      checkAndFlagLowQuality: vi.fn(async () => undefined),
    }));
    vi.doMock(toolsModulePath, () => ({
      runExtractTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runRecallTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runRetireTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runStoreTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    }));

    const { beforePromptBuildHandler, beforeResetHandler } = await registerPlugin({ signalsEnabled: false });

    await beforePromptBuildHandler({ prompt: "test" }, { sessionKey: "agent:main:phase2-strengthen" });
    await beforeResetHandler(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "final response" }] }],
      },
      { sessionKey: "agent:main:phase2-strengthen" },
    );

    expect(computeRecallFeedback).toHaveBeenCalledTimes(1);
    expect(strengthenCoRecallEdges).toHaveBeenCalledTimes(1);
    expect(strengthenCoRecallEdges).toHaveBeenCalledWith(fakeDb, ["e1", "e2"], expect.any(String));
  });

  it("checks low-quality thresholds after feedback updates", async () => {
    vi.resetModules();

    const fakeDb = {
      execute: vi.fn(async (query: string | { sql: string }) => {
        const sql = typeof query === "string" ? query : query.sql;
        if (sql.includes("SELECT id, quality_score, recall_count")) {
          return {
            rows: [
              { id: "e1", quality_score: 0.15, recall_count: 12 },
              { id: "e2", quality_score: 0.42, recall_count: 15 },
            ],
            rowsAffected: 0,
          };
        }
        return { rows: [], rowsAffected: 0 };
      }),
    };

    const checkAndFlagLowQuality = vi.fn(async () => undefined);

    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => buildRecallResults(["e1", "e2"])),
      formatRecallAsMarkdown: vi.fn(() => ""),
    }));
    vi.doMock(sessionQueryModulePath, () => ({
      buildSemanticSeed: vi.fn(() => ""),
      extractLastExchangeText: vi.fn(() => ""),
      extractRecentTurns: vi.fn(async () => ""),
      findPreviousSessionFile: vi.fn(async () => null),
      stripPromptMetadata: vi.fn((text: string) => text),
    }));
    vi.doMock(dbClientModulePath, () => ({
      getDb: vi.fn(() => fakeDb),
      initDb: vi.fn(async () => undefined),
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(configModulePath, () => ({
      readConfig: vi.fn(() => ({ models: { extraction: "x", claimExtraction: "x", contradictionJudge: "x", handoffSummary: "x" } })),
    }));
    vi.doMock(feedbackModulePath, () => ({
      computeRecallFeedback: vi.fn(async () => ({
        usedIds: [],
        correctedIds: [],
        updatedIds: ["e1", "e2"],
      })),
    }));
    vi.doMock(coRecallModulePath, () => ({
      strengthenCoRecallEdges: vi.fn(async () => undefined),
    }));
    vi.doMock(reviewQueueModulePath, () => ({
      checkAndFlagLowQuality,
    }));
    vi.doMock(toolsModulePath, () => ({
      runExtractTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runRecallTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runRetireTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      runStoreTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    }));

    const { beforePromptBuildHandler, beforeResetHandler } = await registerPlugin({ signalsEnabled: false });

    await beforePromptBuildHandler({ prompt: "test" }, { sessionKey: "agent:main:phase2-low-quality" });
    await beforeResetHandler(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "final response" }] }],
      },
      { sessionKey: "agent:main:phase2-low-quality" },
    );

    expect(checkAndFlagLowQuality).toHaveBeenCalledTimes(2);
    expect(checkAndFlagLowQuality).toHaveBeenNthCalledWith(1, fakeDb, "e1", 0.15, 12);
    expect(checkAndFlagLowQuality).toHaveBeenNthCalledWith(2, fakeDb, "e2", 0.42, 15);
  });
});
