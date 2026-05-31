import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import { runGoalAliasTool, type GoalToolResponse } from "../../../src/adapters/shared/goal-tools.js";
import type { MemoryToolParamReader } from "../../../src/adapters/shared/memory-tools.js";
import { createWorkingMemoryService, type WorkingMemoryService } from "../../../src/app/working-memory/service.js";

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
  readStringArray() {
    return undefined;
  },
};

describe("goal alias tools", () => {
  it("creates, reads, blocks, and completes goals with Codex-shaped responses", async () => {
    const { database, dbPath, service } = await createService();

    try {
      const scope = { conversationKey: "goal-1", sessionId: "goal-1", cwd: "/tmp/project" };
      const created = await runGoalAliasTool("create_goal", { objective: "Implement Phase 1.5 goal aliases.", token_budget: 500 }, scope, READER, service);
      expect(created.failed).toBe(false);
      expect(readGoalResponse(created.text)).toMatchObject({
        goal: {
          objective: "Implement Phase 1.5 goal aliases.",
          status: "active",
          revision: 1,
          tokenBudget: 500,
          tokensUsed: 0,
          turnsUsed: 0,
          continuationPolicy: "manual",
        },
        remainingTokens: 500,
        completionBudgetReport: null,
      });

      await expect(
        service.run({
          action: "update",
          scope,
          operation: {
            type: "account_usage",
            usage: {
              tokenDelta: 125,
              turnDelta: 1,
            },
          },
          updateReason: "Host accounted autonomous goal progress.",
          actor: "runtime",
          source: "lifecycle_hook",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "update",
      });

      const duplicate = await runGoalAliasTool("create_goal", { objective: "Duplicate." }, scope, READER, service);
      expect(duplicate).toMatchObject({
        failed: true,
        text: "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
        details: {
          status: "failed",
          code: "active_set_exists",
        },
      });

      const blocked = await runGoalAliasTool("update_goal", { status: "blocked" }, scope, READER, service);
      expect(blocked.failed).toBe(false);
      expect(readGoalResponse(blocked.text)).toMatchObject({
        goal: {
          status: "blocked",
          revision: 2,
          tokensUsed: 125,
          turnsUsed: 1,
        },
        remainingTokens: 375,
        completionBudgetReport: null,
      });

      const completed = await runGoalAliasTool("update_goal", { status: "complete" }, scope, READER, service);
      expect(completed.failed).toBe(false);
      expect(readGoalResponse(completed.text)).toMatchObject({
        goal: {
          status: "complete",
          revision: 3,
          tokenBudget: 500,
          tokensUsed: 125,
        },
        remainingTokens: 375,
        completionBudgetReport: expect.stringContaining("Goal achieved."),
      });

      const getAfterComplete = await runGoalAliasTool("get_goal", {}, scope, READER, service);
      expect(getAfterComplete.failed).toBe(false);
      expect(readGoalResponse(getAfterComplete.text)).toMatchObject({
        goal: {
          status: "complete",
          revision: 3,
        },
      });

      const createAfterComplete = await runGoalAliasTool("create_goal", { objective: "New goal." }, scope, READER, service);
      expect(createAfterComplete).toMatchObject({
        failed: true,
        details: {
          status: "failed",
          code: "active_set_exists",
        },
      });
    } finally {
      await database.close();
      await fs.rm(dbPath, { force: true });
    }
  });

  it("rejects unsupported update_goal statuses", async () => {
    const service = {
      run: async () => {
        throw new Error("invalid status should not reach the service");
      },
      renderProjection: async () => {
        throw new Error("not used");
      },
    } as unknown as WorkingMemoryService;

    await expect(runGoalAliasTool("update_goal", { status: "paused" }, { conversationKey: "session-1" }, READER, service)).resolves.toMatchObject({
      failed: true,
      text: "update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system",
      details: {
        status: "failed",
        code: "invalid_request",
      },
    });
  });
});

function readGoalResponse(text: string): GoalToolResponse {
  return JSON.parse(text) as GoalToolResponse;
}

async function createService(): Promise<{ database: SqlDatabase; dbPath: string; service: ReturnType<typeof createWorkingMemoryService> }> {
  const dbPath = path.join(os.tmpdir(), `agenr-goal-tools-${randomUUID()}.sqlite`);
  const database = await createDatabase(dbPath);
  const repository = createWorkingMemoryRepository(database);
  const service = createWorkingMemoryService(
    { workingMemory: true },
    {
      repository,
      sourceLabel: "test",
      now: () => new Date("2026-05-30T12:00:00.000Z"),
    },
  );

  return { database, dbPath, service };
}
