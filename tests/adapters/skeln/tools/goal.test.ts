import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "skeln";

import { registerAgenrSkelnGoalAliasTools } from "../../../../src/adapters/skeln/tools/goal.js";
import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";

describe("registerAgenrSkelnGoalAliasTools", () => {
  it("registers Codex-compatible goal aliases with narrow schemas", async () => {
    const tools: RegisteredTool[] = [];
    registerAgenrSkelnGoalAliasTools(
      {
        registerTool: (tool: RegisteredTool) => {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI,
      Promise.resolve(createServices()),
      async () => ({
        sessionId: "session-1",
        sessionKey: "skeln:session:session-1",
        cwd: "/tmp/project",
      }),
    );

    expect(tools.map((tool) => tool.name)).toEqual(["get_goal", "create_goal", "update_goal"]);
    expect(tools.find((tool) => tool.name === "create_goal")?.parameters).toMatchObject({
      required: ["objective"],
      properties: {
        objective: {
          type: "string",
        },
        token_budget: {
          minimum: 1,
        },
      },
    });
    expect(tools.find((tool) => tool.name === "update_goal")?.parameters).toMatchObject({
      properties: {
        status: {
          enum: ["complete", "blocked"],
        },
      },
    });

    const getGoal = tools.find((tool) => tool.name === "get_goal");
    const result = await getGoal?.execute("tool-1", {}, undefined, undefined, {} as ExtensionContext);
    expect(result?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"goal": null'),
    });
  });
});

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function createServices(): AgenrSkelnServices {
  return {
    workingMemory: {
      run: vi.fn(async () => ({
        ok: false,
        code: "missing_active_set",
        message: "No active working set matched the resolved scope.",
      })),
      renderProjection: vi.fn(),
    },
  } as unknown as AgenrSkelnServices;
}
