import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgenrDebugSink, createNoopAgenrDebugSink } from "../../../../src/adapters/openclaw/debug/index.js";

describe("agenr OpenClaw debug sink", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "agenr-debug-sink-")));
  });

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns a no-op sink when debug logging is disabled", async () => {
    const sink = createAgenrDebugSink({
      enabled: false,
      eventLevel: "basic",
      perSessionFiles: false,
      maxTopCandidates: 10,
    });

    expect(sink.enabled).toBe(false);
    await expect(sink.emit({ type: "tool_call", tool: "agenr_recall", params: {} })).resolves.toBeUndefined();
  });

  it("writes one JSONL line per emit call when enabled", async () => {
    const logPath = path.join(tempRoot, "logs", "agenr.jsonl");
    const sink = createAgenrDebugSink({
      enabled: true,
      logPath,
      eventLevel: "basic",
      perSessionFiles: false,
      maxTopCandidates: 5,
    });
    expect(sink.enabled).toBe(true);

    await sink.emit({ type: "tool_call", tool: "agenr_recall", sessionId: "sess-1", params: { query: "hello" } });
    await sink.emit({
      type: "tool_result",
      tool: "agenr_recall",
      sessionId: "sess-1",
      summary: {
        count: 0,
        routing: { requested: "auto", detectedIntent: "durables", queried: ["durables"], reason: "ok" },
        selectedEntryIds: [],
        episodeIds: [],
        selectedProcedureKey: null,
        notices: [],
        procedureNotices: [],
      },
    });
    await sink.close();

    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe("tool_call");
    expect(first.tool).toBe("agenr_recall");
    expect(typeof first.ts).toBe("string");
    const second = JSON.parse(lines[1]!);
    expect(second.type).toBe("tool_result");
    expect(second.summary.routing.requested).toBe("auto");
  });

  it("splits log files per session when perSessionFiles is enabled", async () => {
    const logPath = path.join(tempRoot, "agenr.jsonl");
    const sink = createAgenrDebugSink({
      enabled: true,
      logPath,
      eventLevel: "basic",
      perSessionFiles: true,
      maxTopCandidates: 5,
    });

    await sink.emit({ type: "tool_call", tool: "agenr_recall", sessionId: "alpha", params: {} });
    await sink.emit({ type: "tool_call", tool: "agenr_recall", sessionId: "beta", params: {} });
    await sink.close();

    const alphaContent = await readFile(path.join(tempRoot, "agenr.alpha.jsonl"), "utf8");
    const betaContent = await readFile(path.join(tempRoot, "agenr.beta.jsonl"), "utf8");
    expect(alphaContent.trim().split("\n")).toHaveLength(1);
    expect(betaContent.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(alphaContent.trim()).sessionId).toBe("alpha");
    expect(JSON.parse(betaContent.trim()).sessionId).toBe("beta");
  });

  it("prevents further emits once closed", async () => {
    const logPath = path.join(tempRoot, "agenr.jsonl");
    const sink = createAgenrDebugSink({
      enabled: true,
      logPath,
      eventLevel: "basic",
      perSessionFiles: false,
      maxTopCandidates: 5,
    });
    await sink.emit({ type: "tool_call", tool: "agenr_recall", params: {} });
    await sink.close();
    await sink.emit({ type: "tool_call", tool: "agenr_recall", params: {} });

    const content = await readFile(logPath, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });

  it("exposes a shared no-op sink that never touches the filesystem", async () => {
    const sink = createNoopAgenrDebugSink();
    const spy = vi.spyOn(console, "error");
    await sink.emit({ type: "tool_call", tool: "agenr_recall", params: {} });
    await sink.close();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
