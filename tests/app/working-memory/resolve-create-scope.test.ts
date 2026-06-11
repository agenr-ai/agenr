import { describe, expect, it, vi } from "vitest";

import { resolveCreateScope } from "../../../src/app/working-memory/selection.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";

describe("resolveCreateScope", () => {
  it("returns resolved scope when no active set exists", async () => {
    const repository = {
      getWorkingSet: vi.fn(async () => undefined),
      findCurrentWorkingSets: vi.fn(async () => []),
    } as unknown as WorkingMemoryRepository;

    await expect(
      resolveCreateScope(
        {
          scope: {
            conversationKey: "session-1",
            cwd: "/tmp/project",
          },
        },
        repository,
      ),
    ).resolves.toEqual({
      ok: true,
      scope: {
        conversationKey: "session-1",
        cwd: "/tmp/project",
        scopeKind: "conversation",
        scopeKey: "conversation:session-1",
      },
    });
  });

  it("returns active_set_exists when an open set matches the scope", async () => {
    const repository = {
      getWorkingSet: vi.fn(async () => undefined),
      findCurrentWorkingSets: vi.fn(async () => [{ id: "ws-1", scopeKey: "conversation:session-1" }]),
    } as unknown as WorkingMemoryRepository;

    await expect(
      resolveCreateScope(
        {
          scope: {
            conversationKey: "session-1",
          },
        },
        repository,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "active_set_exists",
      details: {
        workingSetId: "ws-1",
        scopeKey: "conversation:session-1",
      },
    });
  });

  it("returns not_found when create is scoped by a missing working set id", async () => {
    const repository = {
      getWorkingSet: vi.fn(async () => undefined),
      findCurrentWorkingSets: vi.fn(async () => []),
    } as unknown as WorkingMemoryRepository;

    await expect(
      resolveCreateScope(
        {
          workingSetId: "ws-missing",
        },
        repository,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
      details: {
        workingSetId: "ws-missing",
      },
    });
  });
});
