import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../../src/adapters/db/working-memory-repository.js";
import { createAgenrWorkTool } from "../../../../src/adapters/openclaw/tools/work.js";
import { resolveRuntimeCapabilities } from "../../../../src/app/features/capabilities.js";
import { createWorkingMemoryService } from "../../../../src/app/working-memory/service.js";
import { createStubAgenrHostMemorySurface } from "../../../helpers/host-memory-stubs.js";
import { closeTestDatabase, removeTestPath } from "../../../helpers/temp-paths.js";

describe("createAgenrWorkTool", () => {
  it("merges host scope and returns a formatted working-memory outcome", async () => {
    const dbPath = path.join(os.tmpdir(), `agenr-openclaw-work-tool-${randomUUID()}.db`);
    const database = await createDatabase(dbPath);
    const repository = createWorkingMemoryRepository(database);
    const workingMemory = createWorkingMemoryService({ workingMemory: true }, { repository, sourceLabel: "openclaw" });
    const featureFlags = {
      workingMemory: true,
      sessionTreeLineage: false,
      sessionTreeCompaction: false,
      goalContinuation: false,
    };

    try {
      const servicesPromise = Promise.resolve({
        ...createStubAgenrHostMemorySurface({ workingMemory }),
        workingMemory,
        capabilities: resolveRuntimeCapabilities(featureFlags, { workingMemoryRepository: repository }),
      });
      const logger = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const tool = createAgenrWorkTool(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:webchat:test",
          workspaceDir: "/tmp/project",
          agentId: "main",
        },
        servicesPromise,
        logger,
      );

      const createResult = await tool.execute("tool-1", {
        action: "create",
        target: "session",
        updateReason: "Start session working set.",
        operation: {
          type: "set_objective",
          objective: "Ship OpenClaw working memory.",
        },
      });
      expect(createResult.details).toMatchObject({
        status: "ok",
        action: "create",
      });

      const getResult = await tool.execute("tool-2", { action: "get" });
      expect(getResult.details).toMatchObject({
        status: "ok",
        action: "get",
      });
      expect(getResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Ship OpenClaw working memory."),
      });

      const listResult = await tool.execute("tool-3", { action: "list" });
      expect(listResult.details).toMatchObject({
        status: "ok",
        action: "list",
        count: 1,
        workingSets: [
          {
            status: "active",
            objective: "Ship OpenClaw working memory.",
            scopeKind: "session",
          },
        ],
      });
      expect(listResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Ship OpenClaw working memory."),
      });
    } finally {
      await closeTestDatabase(database);
      await removeTestPath(dbPath);
    }
  });

  it("refuses to run when OpenClaw scope falls back to unknown identity", async () => {
    const workingMemory = {
      run: vi.fn(),
    };
    const servicesPromise = Promise.resolve({
      ...createStubAgenrHostMemorySurface({ workingMemory }),
      workingMemory,
      capabilities: resolveRuntimeCapabilities(
        {
          workingMemory: true,
          sessionTreeLineage: false,
          sessionTreeCompaction: false,
          goalContinuation: false,
        },
        { workingMemoryRepository: {} as never },
      ),
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const tool = createAgenrWorkTool({}, servicesPromise, logger);

    const result = await tool.execute("tool-1", { action: "get" });

    expect(workingMemory.run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[agenr] tool=agenr_work session=unknown failed: OpenClaw session identity is unavailable; refusing to mutate a session working set because the "unknown" fallback could collide across sessions.',
    );
    expect(result.details).toMatchObject({
      status: "failed",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: 'OpenClaw session identity is unavailable; refusing to mutate a session working set because the "unknown" fallback could collide across sessions.',
    });
  });
});
