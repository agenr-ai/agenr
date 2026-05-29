import { describe, expect, it, vi } from "vitest";

import type { SessionStartDeps } from "../../../../src/app/session-start/index.js";
import type { Entry } from "../../../../src/core/types.js";
import { buildAgenrSkelnInjectionMessage, handleAgenrSkelnBeforeAgentStart } from "../../../../src/adapters/skeln/hooks/before-agent-start.js";
import { createSessionStartTracker } from "../../../../src/app/plugin-runtime/session-tracking.js";
import type { AgenrSkelnServices } from "../../../../src/app/skeln/runtime.js";
import type { AgenrSkelnSessionScope } from "../../../../src/adapters/skeln/types.js";

describe("handleAgenrSkelnBeforeAgentStart", () => {
  const scope: AgenrSkelnSessionScope = {
    sessionId: "session-1",
    sessionKey: "skeln:session:session-1:cwd:/tmp/project",
    cwd: "/tmp/project",
  };

  it("injects session-start recall and memory doctrine on the first turn", async () => {
    const coreEntry = createEntry({
      id: "core-1",
      subject: "branching workflow",
      content: "Branch from local master before editing shared runtime code.",
      expiry: "core",
      importance: 10,
    });
    const services = createServices({
      sessionStart: createSessionStartDeps([coreEntry]),
    });
    const sessionStartTracker = createSessionStartTracker();

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What should I do next?",
        systemPrompt: "You are a helpful assistant.",
      },
      createContext([]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result?.systemPrompt).toContain("## Memory Recall");
    expect(result?.systemPrompt).toContain("You are a helpful assistant.");
    expect(result?.message?.role).toBe("user");
    expect(extractText(result?.message)).toContain("## Agenr Session Recall");
    expect(extractText(result?.message)).toContain("branching workflow");
  });

  it("returns doctrine-only system prompt when session-start recall has nothing to inject", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
    });
    const sessionStartTracker = createSessionStartTracker();

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Base prompt.",
      },
      createContext([]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result).toEqual({
      systemPrompt: expect.stringContaining("## Memory Recall"),
    });
    expect(result?.message).toBeUndefined();
  });

  it("skips session-start injection when disabled by memory policy", async () => {
    const coreEntry = createEntry({
      id: "core-1",
      subject: "branching workflow",
      content: "Branch from local master before editing shared runtime code.",
      expiry: "core",
      importance: 10,
    });
    const services = createServices({
      sessionStart: createSessionStartDeps([coreEntry]),
      skelnConfig: {
        memoryPolicy: {
          sessionStart: {
            enabled: false,
          },
        },
      },
    });
    const sessionStartTracker = createSessionStartTracker();

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Base prompt.",
      },
      createContext([]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result).toEqual({
      systemPrompt: expect.stringContaining("## Memory Recall"),
    });
    expect(result?.message).toBeUndefined();
    expect(extractText(result?.message)).not.toContain("Agenr Session Recall");
  });

  it("skips before-turn injection when disabled by memory policy", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
      skelnConfig: {
        memoryPolicy: {
          beforeTurn: {
            enabled: false,
          },
        },
      },
    });
    const sessionStartTracker = createSessionStartTracker();
    sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What was the previous approach?",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result).toBeUndefined();
  });
});

describe("buildAgenrSkelnInjectionMessage", () => {
  it("builds a hidden user message with text content", () => {
    const message = buildAgenrSkelnInjectionMessage("injected memory");
    expect(message.role).toBe("user");
    expect(extractText(message)).toBe("injected memory");
    expect(message.timestamp).toBeTypeOf("number");
  });
});

function createContext(branchMessages: Array<{ role: string; content: string }>) {
  return {
    sessionManager: {
      getBranch: () =>
        branchMessages.map((message, index) => ({
          type: "message" as const,
          id: `entry-${index}`,
          parentId: null,
          timestamp: index,
          message,
        })),
    },
  };
}

function createServices(input: { sessionStart: SessionStartDeps; skelnConfig?: AgenrSkelnServices["skelnConfig"] }): AgenrSkelnServices {
  return {
    sessionStart: input.sessionStart,
    beforeTurn: {
      recall: {
        embed: vi.fn(),
        ftsSearch: vi.fn(),
        vectorSearch: vi.fn(),
        recordRecallEvents: vi.fn(),
      },
      procedures: {
        listProcedures: vi.fn(),
      },
      embedQuery: vi.fn(),
    },
    skelnConfig: input.skelnConfig ?? {},
  } as unknown as AgenrSkelnServices;
}

function createSessionStartDeps(coreEntries: Entry[]): SessionStartDeps {
  return {
    repository: {
      listCoreEntries: vi.fn(async () => coreEntries),
    },
    recall: {
      embed: vi.fn(),
      ftsSearch: vi.fn(),
      vectorSearch: vi.fn(),
      recordRecallEvents: vi.fn(),
    },
  };
}

function createEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject" | "content">): Entry {
  return {
    type: "fact",
    importance: 7,
    expiry: "permanent",
    tags: [],
    source_file: "test",
    source_context: "test",
    content_hash: "hash",
    norm_content_hash: "norm-hash",
    retired: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function extractText(message: { content?: unknown } | undefined): string {
  if (!message?.content || !Array.isArray(message.content)) {
    return "";
  }

  const first = message.content[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}
