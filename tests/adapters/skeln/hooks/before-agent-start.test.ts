import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../../../src/adapters/skeln/skeln-types.js";

import type { SessionStartDeps } from "../../../../src/app/session-start/index.js";
import { resolveRuntimeCapabilities } from "../../../../src/app/features/capabilities.js";
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

  it("does not inject predecessor continuity text until OpenClaw-style continuity lands", async () => {
    const coreEntry = createEntry({
      id: "core-1",
      subject: "branching workflow",
      content: "Branch from local master before editing shared runtime code.",
      expiry: "core",
      importance: 10,
    });
    const services = createServices({
      sessionStart: createSessionStartDeps([coreEntry]),
      sessionTreeLineage: true,
      sessionMemoryRepository: {
        getLatestLineageEdgeForChild: vi.fn(async () => ({
          id: "edge-1",
          childSessionKey: scope.sessionKey,
          parentSessionKey: "parent-session",
          reason: "resume" as const,
          observedAt: "2026-05-30T00:00:00.000Z",
        })),
        listSessionArtifacts: vi.fn(async () => [
          {
            id: "summary-1",
            kind: "continuity_summary" as const,
            sessionKey: "parent-session",
            source: "skeln",
            sourceId: "summary-1",
            contentHash: "hash-1",
            summary: "The previous session summary.",
            createdAt: "2026-05-30T00:00:00.000Z",
          },
        ]),
        listSessionArtifactsBySourceRef: vi.fn(async () => []),
        upsertLineageEdge: vi.fn(),
        upsertSessionArtifact: vi.fn(),
        recordTriggerIntake: vi.fn(),
      },
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

    expect(extractText(result?.message)).not.toContain("The previous session summary.");
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
      memoryTrace: expect.arrayContaining([
        expect.objectContaining({ kind: "system_prompt", action: "injected" }),
        expect.objectContaining({ kind: "session_start_recall", action: "skipped", reason: "no matching entries" }),
        expect.objectContaining({ kind: "working_context", action: "skipped", reason: "features.workingMemory=false" }),
      ]),
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
      memoryTrace: expect.arrayContaining([
        expect.objectContaining({ kind: "session_start_recall", action: "skipped", reason: "memoryPolicy.sessionStart.enabled=false" }),
      ]),
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

    expect(result?.systemPrompt).toContain("## Memory Recall");
    expect(result?.memoryTrace).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "before_turn_recall", action: "skipped", reason: "memoryPolicy.beforeTurn.enabled=false" })]),
    );
  });

  it("returns transient working context without a persisted recall message", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
      skelnConfig: {
        memoryPolicy: {
          beforeTurn: {
            enabled: false,
          },
        },
      },
      workingProjection: "<agenr_work_context>\nObjective: Keep active task state.\n</agenr_work_context>",
    });
    const sessionStartTracker = createSessionStartTracker();
    sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What next?",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(extractText(result?.transientMessages?.[0])).toContain("<agenr_work_context>");
    expect(extractText(result?.transientMessages?.[0])).toContain("Objective: Keep active task state.");
    expect(result?.workingContextAudit).toEqual({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
      sourceRef: expect.stringContaining("skeln:before-turn:"),
      bytes: expect.any(Number),
      summary: "Working set ws-test rev 1",
    });
    expect(result?.message).toBeUndefined();
  });

  it("resolves a fresh working-context audit pointer on each later agent turn", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
      skelnConfig: {
        memoryPolicy: {
          beforeTurn: {
            enabled: false,
          },
          workingContext: {
            enabled: true,
          },
        },
      },
      workingProjection: "<agenr_work_context>\nObjective: Keep active task state.\n</agenr_work_context>",
    });
    const sessionStartTracker = createSessionStartTracker();
    sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

    const first = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "First turn.",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );
    const second = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "Second turn.",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(services.workingMemory.renderProjection).toHaveBeenCalledTimes(2);
    expect(first?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
    expect(second?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
    expect(extractText(first?.transientMessages?.[0])).toContain("<agenr_work_context>");
    expect(extractText(second?.transientMessages?.[0])).toContain("<agenr_work_context>");
  });

  it("does not inject stub working context when no active set resolves", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
      skelnConfig: {
        memoryPolicy: {
          beforeTurn: {
            enabled: false,
          },
        },
      },
      workingMemoryEnabled: true,
      workingStubProjection: "<agenr_work_context>\nReason: missing_active_set\n</agenr_work_context>",
    });
    const sessionStartTracker = createSessionStartTracker();
    sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What next?",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result?.systemPrompt).toContain("## Memory Recall");
    expect(result?.memoryTrace).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "working_context", action: "skipped", reason: "working projection stub" })]),
    );
    expect(result?.transientMessages).toBeUndefined();
  });

  it("preserves transient working context when session-start recall fails", async () => {
    const services = createServices({
      sessionStart: {
        repository: {
          listCoreEntries: vi.fn(async () => {
            throw new Error("session start failed");
          }),
        },
        recall: {
          embed: vi.fn(),
          ftsSearch: vi.fn(),
          vectorSearch: vi.fn(),
          hydrateEntries: vi.fn(async () => []),
          recordRecallEvents: vi.fn(),
        },
      },
      workingProjection: "<agenr_work_context>\nObjective: Keep active task state.\n</agenr_work_context>",
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

    expect(result?.systemPrompt).toContain("## Memory Recall");
    expect(extractText(result?.transientMessages?.[0])).toContain("Objective: Keep active task state.");
    expect(result?.message).toBeUndefined();
  });

  it("skips working-context injection when disabled by memory policy", async () => {
    const services = createServices({
      sessionStart: createSessionStartDeps([]),
      skelnConfig: {
        memoryPolicy: {
          beforeTurn: {
            enabled: false,
          },
          workingContext: {
            enabled: false,
          },
        },
      },
      workingProjection: "<agenr_work_context>\nObjective: Keep active task state.\n</agenr_work_context>",
    });
    const sessionStartTracker = createSessionStartTracker();
    sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

    const result = await handleAgenrSkelnBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "What next?",
        systemPrompt: "Base prompt.",
      },
      createContext([{ role: "user", content: "earlier question" }]),
      {
        servicesPromise: Promise.resolve(services),
        sessionStartTracker,
        resolveScope: async () => scope,
      },
    );

    expect(result?.systemPrompt).toContain("## Memory Recall");
    expect(result?.memoryTrace).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "working_context", action: "skipped", reason: "memoryPolicy.workingContext.enabled=false" })]),
    );
    expect(result?.transientMessages).toBeUndefined();
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

function createContext(branchMessages: Array<{ role: string; content: string }>): ExtensionContext {
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
  } as unknown as ExtensionContext;
}

function createServices(input: {
  sessionStart: SessionStartDeps;
  skelnConfig?: AgenrSkelnServices["skelnConfig"];
  workingProjection?: string;
  workingStubProjection?: string;
  workingMemoryEnabled?: boolean;
  sessionTreeLineage?: boolean;
  sessionMemoryRepository?: AgenrSkelnServices["sessionMemoryRepository"];
}): AgenrSkelnServices {
  const featureFlags = {
    workingMemory: (input.workingMemoryEnabled ?? input.workingProjection !== undefined) || input.workingStubProjection !== undefined,
    sessionTreeLineage: input.sessionTreeLineage ?? false,
    sessionTreeCompaction: false,
    goalContinuation: false,
  };
  const workingMemoryRepository = featureFlags.workingMemory ? ({} as AgenrSkelnServices["workingMemoryRepository"]) : undefined;

  return {
    sessionStart: input.sessionStart,
    sessionMemoryRepository: input.sessionMemoryRepository,
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
    featureFlags,
    capabilities: resolveRuntimeCapabilities(featureFlags, {
      workingMemoryRepository,
      sessionMemoryRepository: input.sessionMemoryRepository,
    }),
    workingMemory: {
      run: vi.fn(),
      renderProjection: vi.fn(async (request: string | { sourceRef: string }) => {
        const sourceRef = typeof request === "string" ? request : request.sourceRef;
        if (input.workingStubProjection) {
          return {
            kind: "working_set" as const,
            renderMode: "stub" as const,
            content: input.workingStubProjection,
            sourceRef,
            byteLength: Buffer.byteLength(input.workingStubProjection, "utf8"),
          };
        }

        const content = input.workingProjection ?? "";
        return {
          kind: "working_set" as const,
          renderMode: input.workingProjection ? ("full" as const) : ("stub" as const),
          content,
          ...(input.workingProjection
            ? {
                workingSetId: "ws-test",
                revision: 1,
              }
            : {}),
          sourceRef,
          byteLength: Buffer.byteLength(content, "utf8"),
        };
      }),
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
      hydrateEntries: vi.fn(async () => []),
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
    quality_score: 1,
    recall_count: 0,
    retired: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const first = content[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}
