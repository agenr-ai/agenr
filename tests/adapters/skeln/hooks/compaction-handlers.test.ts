import { describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "../../../../src/adapters/skeln/skeln-types.js";
import { handleSkelnSessionBeforeCompact } from "../../../../src/adapters/skeln/hooks/compaction-handlers.js";
import * as sessionMemoryRouting from "../../../../src/adapters/skeln/hooks/session-memory-routing.js";
import type { AgenrSkelnSessionScope } from "../../../../src/adapters/skeln/types.js";

describe("handleSkelnSessionBeforeCompact", () => {
  const scope: AgenrSkelnSessionScope = {
    sessionId: "session-1",
    sessionKey: "skeln:session:session-1:cwd:/tmp/project",
    cwd: "/tmp/project",
  };

  it("routes session_before_compact through the shared session-memory router", async () => {
    const routeTrigger = vi.spyOn(sessionMemoryRouting, "routeSkelnSessionMemoryTrigger").mockResolvedValue(undefined);

    await handleSkelnSessionBeforeCompact(
      { messageCount: 12 },
      createContext(),
      Promise.resolve({
        skelnConfig: { memoryPolicy: { episodes: { enabled: false } } },
        config: { dbPath: "/tmp/knowledge.db" },
        dreaming: {},
      } as never),
      async () => scope,
    );

    expect(routeTrigger).toHaveBeenCalledOnce();
    routeTrigger.mockRestore();
  });
});

function createContext(): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session.jsonl",
      getBranch: () => [{ type: "message" }],
    },
  } as ExtensionContext;
}
