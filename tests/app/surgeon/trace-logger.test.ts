import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTraceLogger } from "../../../src/app/surgeon/trace-logger.js";
import type { Logger } from "../../../src/logger.js";

describe("createTraceLogger", () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      await rm(tempPaths.pop() ?? "", { recursive: true, force: true });
    }
  });

  it("writes compact high-signal JSONL records instead of raw streaming events", async () => {
    const traceDir = await createTempDirectory(tempPaths, "agenr-trace-logger-");
    const tracePath = path.join(traceDir, "surgeon-trace.jsonl");
    const logger = createStubLogger();
    const traceLogger = createTraceLogger({
      verbose: false,
      tracePath,
      logger,
      budgetTracker: {
        totals: () => ({
          inputTokens: 1200,
          outputTokens: 300,
          costUsd: 0.04,
          lastInputTokens: 800,
        }),
        remaining: () => ({
          currentContextTokens: 1500,
          contextLimit: 4096,
          remainingContextTokens: 2596,
          costCapUsd: 1,
          remainingCostUsd: 0.96,
        }),
      },
    });

    traceLogger.onEvent({ type: "agent_start" } as AgentEvent);
    traceLogger.onEvent({ type: "turn_start" } as AgentEvent);
    traceLogger.onEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"entry',
        partial: {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4-mini",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      },
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as AgentEvent);
    traceLogger.onEvent({
      type: "message_end",
      message: {
        role: "user",
        content: "Begin retirement pass.",
        timestamp: Date.now(),
      },
    } as AgentEvent);
    traceLogger.onEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the actionable cleanup pool first." },
          {
            type: "toolCall",
            id: "tool-query",
            name: "query_candidates",
            arguments: { scope: "actionable", limit: 20 },
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          cost: { input: 0.01, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.04 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as AgentEvent);
    traceLogger.onEvent({
      type: "tool_execution_start",
      toolCallId: "tool-query",
      toolName: "query_candidates",
      args: { scope: "actionable", limit: 20 },
    } as AgentEvent);
    traceLogger.onEvent({
      type: "tool_execution_end",
      toolCallId: "tool-query",
      toolName: "query_candidates",
      isError: false,
      result: {
        content: [{ type: "text", text: "very large rendered text" }],
        details: {
          count: 1,
          candidates: [
            {
              id: "entry-1",
              subject: "entry one",
              embedding: Array.from({ length: 32 }, (_, index) => index),
            },
          ],
        },
      },
    } as AgentEvent);
    traceLogger.logAction({
      id: "action-1",
      runId: "run-1",
      actionType: "retire",
      entryIds: ["entry-1"],
      reasoning: "Retire the oldest safe candidate first.",
      details: {
        protected: false,
      },
      recallDelta: null,
      createdAt: "2026-04-12T19:00:00.000Z",
    });
    traceLogger.onEvent({ type: "turn_end" } as AgentEvent);
    traceLogger.onEvent({ type: "agent_end", messages: [] } as AgentEvent);
    traceLogger.close();

    const records = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; [key: string]: unknown });

    expect(records.map((record) => record.kind)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "assistant_message",
      "tool_start",
      "tool_end",
      "surgeon_action",
      "turn_summary",
      "agent_end",
    ]);

    expect(records.some((record) => record.kind === "message_update")).toBe(false);
    expect(records[3]).toEqual(
      expect.objectContaining({
        kind: "assistant_message",
        text: "Checking the actionable cleanup pool first.",
        toolCalls: [
          expect.objectContaining({
            name: "query_candidates",
            args: { scope: "actionable", limit: 20 },
          }),
        ],
      }),
    );
    expect(records[5]).toEqual(
      expect.objectContaining({
        kind: "tool_end",
        result: {
          count: 1,
          candidates: [
            {
              id: "entry-1",
              subject: "entry one",
              embedding: {
                omitted: "embedding",
                dimensions: 32,
              },
            },
          ],
        },
      }),
    );
    expect(records[7]).toEqual(
      expect.objectContaining({
        kind: "turn_summary",
        totals: {
          inputTokens: 1200,
          outputTokens: 300,
          costUsd: 0.04,
        },
      }),
    );
  });
});

function createStubLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function createTempDirectory(tempPaths: string[], prefix: string): Promise<string> {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}
