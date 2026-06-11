import path from "node:path";

import { describe, expect, it } from "vitest";

import type { GoalContinuationCommand, GoalContinuationHostPort } from "../../../src/app/goal-continuation/service.js";
import { createAgenrSkelnServices } from "../../../src/app/skeln/runtime.js";
import { createTempRoot, usePluginRuntimeEnv, writeJson } from "../../app/plugin-runtime/helpers.js";

describe("createAgenrSkelnServices", () => {
  usePluginRuntimeEnv();

  it("creates claim extraction from agenr config credentials", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      auth: "openai-api-key",
      credentials: {
        openaiApiKey: "agenr-claim-key",
      },
      claimExtraction: {
        enabled: true,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeDefined();
    expect(services.claimExtraction?.config.enabled).toBe(true);

    await services.close();
  });

  it("skips claim extraction when disabled in agenr config", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      auth: "openai-api-key",
      credentials: {
        openaiApiKey: "agenr-claim-key",
      },
      claimExtraction: {
        enabled: false,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeUndefined();

    await services.close();
  });

  it("disables claim extraction when agenr credential resolution fails", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      claimExtraction: {
        enabled: true,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeUndefined();

    await services.close();
  });

  it("returns host wrapper metadata alongside shared memory services", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.skelnConfig).toEqual({ dbPath });
    expect(services.sessionStart.repository).toBeDefined();
    expect(services.beforeTurn.recall).toBe(services.recall);
    expect(services.workingMemory).toBeDefined();
    expect(services.workingMemoryRepository).toBeDefined();
    expect(services.routeSessionMemoryTrigger).toBeTypeOf("function");
    expect(services.goalContinuation).toBeDefined();
    expect(services.capabilities).toEqual({
      workingMemory: "disabled",
      sessionMemory: "enabled",
      shutdownEpisodes: true,
      goalContinuation: "disabled",
    });

    await services.close();
  });

  it("disables goal working sets when skeln goals is false", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
      features: {
        workingMemory: true,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath, goals: false });

    expect(services.skelnConfig.goals).toBe(false);
    await expect(
      services.workingMemory.run({
        action: "create",
        target: "goal",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Should not create.",
        },
        updateReason: "Attempted goal create while disabled.",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_request",
      message: "Goal working sets are disabled for this host.",
    });

    await services.close();
  });

  it("routes continuation commands through a registered host port", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
      features: {
        workingMemory: true,
        goalContinuation: true,
      },
    });

    const commands: GoalContinuationCommand[] = [];
    const goalContinuationHostPort: GoalContinuationHostPort = {
      runCommand: async (command) => {
        commands.push(command);
        return { ok: true, scheduled: true };
      },
    };

    const services = await createAgenrSkelnServices({ dbPath, goalContinuationHostPort });

    try {
      expect(services.capabilities.goalContinuation).toBe("enabled");

      const scope = {
        conversationKey: "session-1",
        sessionId: "session-1",
        cwd: "/tmp/project",
      };
      const created = await services.workingMemory.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Continue autonomously when idle.",
        },
        updateReason: "Created goal for continuation wiring test.",
        source: "goal_command",
        continuationPolicy: "on_idle",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("expected goal create to succeed");
      }

      const result = await services.goalContinuation.runCommand({
        kind: "schedule_continuation",
        workingSetId: created.workingSet.id,
        scope,
        reason: "policy_on_idle",
      });

      expect(result).toEqual({ ok: true, scheduled: true });
      expect(commands).toEqual([
        {
          kind: "schedule_continuation",
          workingSetId: created.workingSet.id,
          scope,
          reason: "policy_on_idle",
        },
      ]);
    } finally {
      await services.close();
    }
  });

  it("resolves feature flags from agenr config at the composition boundary", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
      features: {
        workingMemory: true,
        sessionTreeLineage: false,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.runtimePolicy.featureFlags).toEqual({
      workingMemory: true,
      sessionTreeLineage: false,
      sessionTreeCompaction: true,
      goalContinuation: false,
    });

    await services.close();
  });
});
