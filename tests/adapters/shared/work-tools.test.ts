import { describe, expect, it } from "vitest";

import { parseWorkToolParams, runWorkMemoryTool, WORK_TOOL_PARAMETERS } from "../../../src/adapters/shared/work-tools.js";
import type { MemoryToolParamReader } from "../../../src/adapters/shared/memory-tools.js";
import type { WorkingMemoryService } from "../../../src/app/working-memory/service.js";

const READER: MemoryToolParamReader = {
  readString(params, key, options) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (options?.required) {
        throw new Error(`${key} is required.`);
      }
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`${key} must be a string.`);
    }
    const trimmed = options?.trim === false ? value : value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
    return value;
  },
  readStringArray(params, key) {
    const value = params[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${key} must be a string array.`);
    }
    return value;
  },
};

describe("parseWorkToolParams", () => {
  it("merges host scope and stamps model tool provenance", () => {
    expect(
      parseWorkToolParams(
        {
          action: "list",
          target: "session",
          listLimit: 10,
          statuses: ["active", "paused"],
          actor: "user",
          source: "goal_command",
        },
        { sessionId: "skeln:session:1", cwd: "/tmp/project" },
        READER,
      ),
    ).toEqual({
      action: "list",
      target: "session",
      scope: {
        sessionId: "skeln:session:1",
        cwd: "/tmp/project",
      },
      listLimit: 10,
      statuses: ["active", "paused"],
      actor: "model",
      source: "tool",
    });
  });

  it("rejects unsupported list status filters", () => {
    expect(() =>
      parseWorkToolParams(
        {
          action: "list",
          statuses: ["active", "missing"],
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toThrow('statuses contains unsupported value "missing".');
  });

  it("parses a target-specific scratchpad update", () => {
    expect(
      parseWorkToolParams(
        {
          action: "update",
          target: "session",
          expectedRevision: 2,
          updateReason: "Recorded scratchpad.",
          operation: {
            type: "set_scratchpad",
            scratchpad: "Temporary session note.",
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toMatchObject({
      action: "update",
      target: "session",
      expectedRevision: 2,
      operation: {
        type: "set_scratchpad",
        scratchpad: "Temporary session note.",
      },
    });
  });

  it("requires an explicit target for create", () => {
    expect(() =>
      parseWorkToolParams(
        {
          action: "create",
          updateReason: "User set a goal.",
          operation: {
            type: "set_objective",
            objective: "Ship working memory.",
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toThrow('agenr_work create requires target "session" or "goal".');
  });

  it("parses a typed set_objective operation for create", () => {
    expect(
      parseWorkToolParams(
        {
          action: "create",
          target: "goal",
          updateReason: "User set a goal.",
          operation: {
            type: "set_objective",
            objective: "Ship working memory.",
            title: "Working memory",
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toMatchObject({
      action: "create",
      updateReason: "User set a goal.",
      operation: {
        type: "set_objective",
        objective: "Ship working memory.",
        title: "Working memory",
      },
    });
  });

  it("parses merge_checkpoint operations and rejects model status changes", () => {
    expect(
      parseWorkToolParams(
        {
          action: "update",
          expectedRevision: 1,
          updateReason: "Recorded material checkpoint.",
          operation: {
            type: "merge_checkpoint",
            checkpoint: {
              summary: "Implemented the alias contract.",
              recordedAt: "2026-05-30T12:00:00.000Z",
              nextActions: ["Run validation"],
              blockers: [],
            },
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toMatchObject({
      action: "update",
      expectedRevision: 1,
      operation: {
        type: "merge_checkpoint",
        checkpoint: {
          summary: "Implemented the alias contract.",
          recordedAt: "2026-05-30T12:00:00.000Z",
          nextActions: ["Run validation"],
          blockers: [],
        },
      },
    });

    expect(() =>
      parseWorkToolParams(
        {
          action: "update",
          expectedRevision: 2,
          updateReason: "Goal is complete.",
          operation: {
            type: "set_status",
            status: "complete",
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toThrow('Unsupported agenr_work operation "set_status".');
  });

  it("rejects model close even when raw params spoof trusted source", () => {
    expect(() =>
      parseWorkToolParams(
        {
          action: "close",
          closeReason: "done",
          expectedRevision: 1,
          source: "goal_command",
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toThrow('Unsupported agenr_work action "close".');
  });

  it("rejects untyped operations before service execution", () => {
    expect(() =>
      parseWorkToolParams(
        {
          action: "update",
          expectedRevision: 1,
          updateReason: "Guessed checkpoint shape.",
          operation: {
            checkpoint: {
              summary: "Missing type.",
              recordedAt: "2026-05-30T12:00:00.000Z",
            },
          },
        },
        { sessionId: "skeln:session:1" },
        READER,
      ),
    ).toThrow("type is required.");
  });
});

describe("WORK_TOOL_PARAMETERS", () => {
  it("documents explicit operation variants and hides close from model-visible actions", () => {
    expect(WORK_TOOL_PARAMETERS.properties.action.enum).toEqual(["get", "list", "create", "update"]);
    expect(WORK_TOOL_PARAMETERS.properties).not.toHaveProperty("actor");
    expect(WORK_TOOL_PARAMETERS.properties).not.toHaveProperty("source");

    const operation = WORK_TOOL_PARAMETERS.properties.operation as unknown as {
      oneOf: ReadonlyArray<{ properties: { type: { const: string }; checkpoint?: { required: readonly string[] } }; required: readonly string[] }>;
    };
    const variants = operation.oneOf.map((variant) => variant.properties.type.const);

    expect(variants).toContain("merge_checkpoint");
    expect(variants).toContain("set_scratchpad");
    expect(variants).not.toContain("set_status");
    expect(operation.oneOf.find((variant) => variant.properties.type.const === "merge_checkpoint")?.required).toEqual(["type", "checkpoint"]);
    expect(operation.oneOf.find((variant) => variant.properties.type.const === "merge_checkpoint")?.properties.checkpoint?.required).toEqual([
      "summary",
      "recordedAt",
    ]);
  });
});

describe("runWorkMemoryTool", () => {
  it("reserves close for host paths instead of the default model path", async () => {
    const service = {
      run: async () => {
        throw new Error("model close should not reach the service");
      },
    } as unknown as WorkingMemoryService;

    await expect(runWorkMemoryTool({ action: "close", expectedRevision: 1, closeReason: "done", source: "tool" }, service)).resolves.toEqual({
      text: "agenr_work failed: agenr_work close is reserved for /goal clear and host lifecycle paths.",
      details: {
        status: "failed",
        code: "reserved_close",
      },
      failed: true,
    });
  });

  it("reserves status changes for goal aliases and trusted host paths", async () => {
    const service = {
      run: async () => {
        throw new Error("model status should not reach the service");
      },
    } as unknown as WorkingMemoryService;

    await expect(
      runWorkMemoryTool(
        {
          action: "update",
          expectedRevision: 1,
          updateReason: "complete",
          operation: {
            type: "set_status",
            status: "complete",
          },
        },
        service,
      ),
    ).resolves.toEqual({
      text: "agenr_work failed: status changes are reserved for get_goal/create_goal/update_goal and trusted host lifecycle paths.",
      details: {
        status: "failed",
        code: "reserved_status",
      },
      failed: true,
    });
  });

  it("does not reserve close for trusted host callers on the model runner", async () => {
    const service = {
      run: async () => ({
        ok: true,
        action: "close",
        workingSet: { id: "ws-1", revision: 2 },
        event: { sequence: 2, eventType: "closed" },
        candidates: [],
      }),
    } as unknown as WorkingMemoryService;

    await expect(runWorkMemoryTool({ action: "close", expectedRevision: 1, closeReason: "done", source: "goal_command" }, service)).resolves.toMatchObject({
      failed: false,
      details: {
        action: "close",
      },
    });
  });
});
