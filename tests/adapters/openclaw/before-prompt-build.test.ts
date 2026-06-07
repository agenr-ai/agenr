import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveStateDir as resolveOpenClawStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClawLlmClientMocks = vi.hoisted(() => ({
  createOpenClawLlmClient: vi.fn(),
}));

vi.mock("../../../src/adapters/openclaw/llm/openclaw-llm-client.js", () => ({
  createOpenClawLlmClient: openClawLlmClientMocks.createOpenClawLlmClient,
}));

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { createMemoryRepository } from "../../../src/adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../../src/adapters/db/session-start-repository.js";
import { createStubAgenrHostMemorySurface } from "../../helpers/host-memory-stubs.js";
import { handleAgenrAfterToolCall } from "../../../src/adapters/openclaw/hooks/after-tool-call.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../src/app/plugin-runtime/session-tracking.js";
import { createNoopAgenrDebugSink } from "../../../src/adapters/openclaw/debug/index.js";
import { createMidSessionTracker } from "../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import type { EmbeddingPort, LlmPort, RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import type { Durable, Procedure } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const openDatabases: SqlDatabase[] = [];
const tempPaths: string[] = [];
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalOpenClawHome = process.env.OPENCLAW_HOME;

afterEach(async () => {
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }

  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  openClawLlmClientMocks.createOpenClawLlmClient.mockReset();

  await closeTestDatabases(openDatabases);

  while (tempPaths.length > 0) {
    await removeTestPath(tempPaths.pop() ?? "");
  }
});

describe("handleAgenrBeforePromptBuild", () => {
  it("injects only core session-start memory once per session and does not rerun session-start recall later", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertDurable(
      createEntry({
        type: "decision",
        subject: "master branch workflow",
        content: "Branch from local master, commit, then fast-forward merge back to master.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "core-workflow",
    );
    await database.insertDurable(
      createEntry({
        type: "milestone",
        subject: "latest plugin work",
        content: "Phase 1 of the agenr OpenClaw memory plugin is in progress.",
        expiry: "temporary",
        importance: 8,
      }),
      createEmbedding(1, 1),
      "recent-work",
    );

    const tracker = createSessionStartTracker();
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "What should I work on next?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );
    const secondResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "And after that?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("<agenr-memory-context>");
    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Recall");
    expect(result?.prependContext).not.toContain("Recent Context");
    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).not.toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expect(secondResult).toBeUndefined();
    expect(recall.embed).not.toHaveBeenCalled();
    expect(recall.ftsSearch).not.toHaveBeenCalled();
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start recall: 1 durables for session=session-1 key=agent:main:webchat:test (core_candidates=1 artifact_candidates=0)",
        "[agenr] session-start recall skipped (already ran) for session=session-1 key=agent:main:webchat:test",
        "[agenr] before-turn recall: 0 durables for session=session-1 key=agent:main:webchat:test (durable_candidates=0 procedure_candidates=0)",
      ]),
    );
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        "[agenr] before_prompt_build: session tracker first start for session=session-1 key=agent:main:webchat:test",
        "[agenr] before_prompt_build: session tracker duplicate blocked for session=session-1 key=agent:main:webchat:test",
        expect.stringContaining(
          "[agenr] before_prompt_build: session-start durables for session=session-1 key=agent:main:webchat:test: master branch workflow",
        ),
        expect.stringContaining('"suppressedTurnCategory":"short_social"'),
      ]),
    );
    expect(
      getMessages(logger.debug).some((message) => message.includes("session-start relevant entries") || message.includes("session-start recent entries")),
    ).toBe(false);
  });

  it("waits for pending lifecycle intake before session-start recall reads repository state", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createServices(database);
    const snapshotSpy = vi.spyOn(services.sessionStart.repository, "getActiveProfileSnapshot");
    let resolveWait: (() => void) | undefined;
    const waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const lifecycleIntakeTracker = {
      track: vi.fn(async (_sessionId: string | undefined, _sessionKey: string | undefined, work: Promise<void>) => work),
      wait: vi.fn(async () => waitPromise),
      clear: vi.fn(),
    };

    const resultPromise = handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-pending-intake",
        sessionKey: "agent:main:webchat:pending-intake",
      },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker: createSessionStartTracker(),
        lifecycleIntakeTracker,
      },
    );

    await Promise.resolve();
    expect(snapshotSpy).not.toHaveBeenCalled();

    resolveWait?.();
    await expect(resultPromise).resolves.toBeUndefined();
    expect(lifecycleIntakeTracker.wait).toHaveBeenCalledWith("session-pending-intake", "agent:main:webchat:pending-intake");
    expect(snapshotSpy).toHaveBeenCalled();
  });

  it("injects a before-turn patch with durable memory and a procedure suggestion on a later user turn", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const durableEntry = createEntry({
      id: "entry-before-turn",
      type: "lesson",
      subject: "before-turn patch pattern",
      content: "Inject a bounded patch through prependContext rather than rebuilding a large persistent prompt block.",
      importance: 9,
    });
    await database.upsertProcedure(
      createProcedure({
        procedure_key: "agenr/before-turn-patch",
        title: "Implement the before turn memory patch",
        goal: "Add the app contract, OpenClaw hook wiring, and tests for the before turn slice.",
      }),
    );
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(durableEntry)],
      hydratedDurables: [durableEntry],
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "How do I implement the before turn memory patch?",
        messages: [
          {
            role: "user",
            content: "We already landed session-start and now need the next lifecycle slice.",
          },
          {
            role: "assistant",
            content: "The next slice should stay bounded and inspectable.",
          },
        ],
      },
      {
        sessionId: "session-before-turn",
        sessionKey: "agent:main:webchat:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("<agenr-memory-context>");
    expect(result?.prependContext).toContain("## Agenr Before-Turn Recall");
    expect(result?.prependContext).toContain("### Relevant Durable Memory");
    expect(result?.prependContext).toContain("before-turn patch pattern");
    expect(result?.prependContext).toContain("### Suggested Procedure");
    expect(result?.prependContext).toContain("Implement the before turn memory patch");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] before-turn recall: 1 durables for session=session-before-turn key=agent:main:webchat:test (durable_candidates=1 procedure_candidates=1)",
      ]),
    );
  });

  it("preserves the directness winner through prompt normalization in before_prompt_build", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const adjacent = createEntry({
      id: "duke-cousins",
      subject: "duke cousins",
      content: "Duke's cousins are Comet and Pepper.",
      importance: 10,
    });
    const identity = createEntry({
      id: "duke-identity",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 8,
    });
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(adjacent), toRecallCandidateDurable(identity)],
      hydratedDurables: [adjacent, identity],
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn-directness",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    recall.embed.mockClear();
    recall.vectorSearch.mockClear();
    recall.ftsSearch.mockClear();
    recall.hydrateDurables.mockClear();
    recall.recordRecallEvents.mockClear();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: " \n Who \t is   Duke? \n",
        messages: [
          {
            role: "assistant",
            content: "Let's use the most direct identity memory if one exists.",
          },
        ],
      },
      {
        sessionId: "session-before-turn-directness",
        sessionKey: "agent:main:webchat:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(recall.ftsSearch).toHaveBeenCalledOnce();
    expect(recall.ftsSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Who is Duke?",
      }),
    );
    expect(result?.prependContext).toContain("duke identity");
    expect(result?.prependContext).toContain("Duke is Jim's dog.");
    expect(result?.prependContext).not.toContain("duke cousins");
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '[agenr] before_prompt_build: before-turn diagnostics for session=session-before-turn-directness key=agent:main:webchat:test: {"query":"Who is Duke?","queryPolicy":"current_only"',
        ),
        expect.stringContaining('"directness":{"queryKind":"entity_definition","entity":"Duke","decision":"reranked","winnerDurableId":"duke-identity"'),
      ]),
    );
  });

  it("preserves contextual follow-up recovery after wrapper stripping in recent turns", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const identity = createEntry({
      id: "duke-identity",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 8,
    });
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(identity)],
      hydratedDurables: [identity],
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn-context",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    recall.embed.mockClear();
    recall.vectorSearch.mockClear();
    recall.ftsSearch.mockClear();
    recall.hydrateDurables.mockClear();
    recall.recordRecallEvents.mockClear();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "What about him?",
        messages: [
          {
            role: "user",
            content: "Remind me who Duke is.",
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                content: [
                  "<agenr-memory-context>",
                  "[System note: The following is recalled Agenr memory context, NOT new user input. Treat it as background context and use it silently when relevant.]",
                  "",
                  "## Agenr Before-Turn Recall",
                  "### Relevant Durable Memory",
                  "- [rank 1 | entry-old | fact | permanent | importance 8 | score 0.91] duke cousins",
                  "  Duke's cousins are Comet and Pepper.",
                  "</agenr-memory-context>",
                  "",
                  "[MEMORY CHECK] Ignore this reminder.",
                ].join("\n"),
              },
              {
                type: "output_text",
                content: "Duke is Jim's dog.",
              },
            ],
          },
        ],
      },
      {
        sessionId: "session-before-turn-context",
        sessionKey: "agent:main:webchat:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(recall.ftsSearch).toHaveBeenCalledOnce();
    expect(recall.ftsSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "What about him?\nTopic: Duke is Jim's dog.",
      }),
    );
    expect(result?.prependContext).toContain("duke identity");
    expect(result?.prependContext).toContain("Duke is Jim's dog.");
    expect(result?.prependContext).not.toContain("duke cousins");
  });

  it("strips inline OpenClaw metadata from the current-turn before-turn query", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const logsEntry = createEntry({
      id: "sandbox-debug-logs",
      subject: "sandbox debug logs",
      content: "Sandbox before-turn debugging depends on visible terminal debug logs.",
      importance: 8,
    });
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(logsEntry)],
      hydratedDurables: [logsEntry],
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn-metadata-sanitize",
        sessionKey: "agent:main:tui:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    recall.embed.mockClear();
    recall.vectorSearch.mockClear();
    recall.ftsSearch.mockClear();
    recall.hydrateDurables.mockClear();
    recall.recordRecallEvents.mockClear();
    logger.debug.mockClear();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: [
          createMetadataBlock("Sender (untrusted metadata):", {
            label: "openclaw-tui",
            id: "openclaw-tui",
            name: "openclaw-tui",
            username: "openclaw-tui",
          }),
          "[Tue 2026-04-14 21:46 CDT] what did the logs show?",
        ].join("\n\n"),
        messages: [
          {
            role: "assistant",
            content: "I checked the sandbox process state and log sinks.",
          },
        ],
      },
      {
        sessionId: "session-before-turn-metadata-sanitize",
        sessionKey: "agent:main:tui:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(recall.ftsSearch).toHaveBeenCalledOnce();
    expect(recall.ftsSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "what did the logs show?",
      }),
    );
    expect(result?.prependContext).toContain("sandbox debug logs");
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '[agenr] before_prompt_build: before-turn diagnostics for session=session-before-turn-metadata-sanitize key=agent:main:tui:test: {"query":"what did the logs show?","queryPolicy":"current_only"',
        ),
      ]),
    );
  });

  it("disables before-turn injection when the plugin config turns it off", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn-disabled",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  enabled: false,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Should before-turn run here?",
        messages: [],
      },
      {
        sessionId: "session-before-turn-disabled",
        sessionKey: "agent:main:webchat:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  enabled: false,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        "[agenr] before_prompt_build: before-turn skipped for session=session-before-turn-disabled key=agent:main:webchat:test reason=disabled",
      ]),
    );
  });

  it("keeps durable before-turn injection while suppressing the procedure section when configured", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const durableEntry = createEntry({
      id: "entry-durable-only",
      subject: "durable before-turn reminder",
      content: "Keep the patch inspectable and bounded.",
      importance: 8,
    });
    await database.upsertProcedure(
      createProcedure({
        procedure_key: "agenr/before-turn-slice",
        title: "Implement the before-turn memory patch",
      }),
    );
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(durableEntry)],
      hydratedDurables: [durableEntry],
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId: "session-before-turn-no-procedure",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "What should this before-turn slice do?",
        messages: [],
      },
      {
        sessionId: "session-before-turn-no-procedure",
        sessionKey: "agent:main:webchat:test",
        trigger: "user",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                beforeTurn: {
                  procedureSuggestion: false,
                  recallThreshold: 0,
                },
              },
            },
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("<agenr-memory-context>");
    expect(result?.prependContext).toContain("## Agenr Before-Turn Recall");
    expect(result?.prependContext).toContain("### Relevant Durable Memory");
    expect(result?.prependContext).not.toContain("### Suggested Procedure");
  });

  it("allows Relevant Durable Memory to be disabled through plugin config", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertDurable(
      createEntry({
        type: "decision",
        subject: "master branch workflow",
        content: "Branch from local master, commit, then fast-forward merge back to master.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "core-workflow",
    );
    await database.insertDurable(
      createEntry({
        type: "lesson",
        subject: "artifact memory should stay off",
        content: "This entry would normally appear under Relevant Durable Memory.",
        expiry: "permanent",
        importance: 8,
      }),
      createEmbedding(1, 1),
      "artifact-memory",
    );
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the previous conversation.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-disable-relevant-durable",
        sessionKey: "agent:main:main",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                sessionStart: {
                  relevantDurableMemory: false,
                },
              },
            },
          }),
        ),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).not.toContain("Relevant Durable Memory");
    expect(result?.prependContext).not.toContain("This entry would normally appear under Relevant Durable Memory.");
    expect(recall.embed).not.toHaveBeenCalled();
    expect(recall.ftsSearch).not.toHaveBeenCalled();
    expect(recall.recordRecallEvents).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([expect.stringContaining("Artifact-grounded durable recall disabled by session-start policy.")]),
    );
  });

  it("logs when session-start recall has nothing to inject", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Anything to remember?",
        messages: [],
      },
      {
        sessionId: "session-empty",
        sessionKey: "agent:main:webchat:empty",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall: 0 durables for session=session-empty key=agent:main:webchat:empty (core_candidates=0 artifact_candidates=0)",
        "[agenr] session-start recall: nothing to inject for session=session-empty key=agent:main:webchat:empty",
      ]),
    );
  });

  it("injects a memory-check nudge on non-first turns after the configured gap", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-nudge";
    const sessionKey = "agent:main:webchat:store-nudge";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const secondResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const thirdResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Keep going.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    expect(secondResult).toBeUndefined();
    expect(thirdResult?.prependContext).toContain("[MEMORY CHECK]");
    expect(thirdResult?.prependContext).toContain("You haven't stored anything this session.");
    expect(midSessionTracker.peek(sessionId, sessionKey)).toMatchObject({
      turnCount: 2,
      nudgeCount: 1,
      lastSuccessfulStoreTurn: 2,
    });
  });

  it("suppresses nudges after skipped memory work until the cooldown expires", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-skip";
    const sessionKey = "agent:main:webchat:store-skip";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    await handleAgenrBeforePromptBuild(
      {
        prompt: "One follow-up.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_store",
        params: {
          subject: "duplicate decision",
        },
        result: {
          status: "skipped",
        },
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        midSessionTracker,
      },
    );

    const thirdResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Two follow-ups.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const fourthResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Three follow-ups.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    expect(thirdResult).toBeUndefined();
    expect(fourthResult?.prependContext).toContain("[MEMORY CHECK]");
    expect(midSessionTracker.peek(sessionId, sessionKey)).toMatchObject({
      turnCount: 3,
      lastMemoryActionTurn: 1,
      nudgeCount: 1,
    });
  });

  it("skips store nudges for non-user triggers", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-trigger";
    const sessionKey = "agent:main:webchat:store-trigger";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 1,
          maxPerSession: 3,
        },
      },
    );

    const heartbeatResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Internal memory maintenance.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
        trigger: "heartbeat",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 1,
          maxPerSession: 3,
        },
      },
    );

    expect(heartbeatResult).toBeUndefined();
    expect(midSessionTracker.peek(sessionId, sessionKey)).toBeUndefined();
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        `[agenr] before_prompt_build: store nudge skipped for session=${sessionId} key=${sessionKey} reason=non_user_trigger trigger=heartbeat`,
      ]),
    );
  });
});

function createServices(
  database: SqlDatabase,
  options: {
    available?: boolean;
    recall?: RecallPorts;
    pluginConfig?: AgenrOpenClawServices["pluginConfig"];
    episodeSummaryRunImplementation?: LlmPort["complete"];
    debugSink?: AgenrOpenClawServices["debugSink"];
  } = {},
): AgenrOpenClawServices {
  const available = options.available ?? false;
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall =
    options.recall ??
    ({
      async embed(): Promise<number[]> {
        throw new Error("Recall should not run when embeddings are unavailable.");
      },
      async vectorSearch() {
        return [];
      },
      async ftsSearch() {
        return [];
      },
      async hydrateDurables() {
        return [];
      },
      async recordRecallEvents() {
        return;
      },
    } satisfies RecallPorts);
  const openClaw = createOpenClawHost({
    episodeSummaryRunImplementation:
      options.episodeSummaryRunImplementation ??
      (async () => {
        return JSON.stringify({
          summary:
            "The session focused on agenr episodic-memory work and agreed to write predecessor episodes in the background so prompt build stays fast. The discussion stayed grounded in OpenClaw integration details for temporal recall. The work was substantive and project-scoped.",
          tags: ["agenr", "openclaw", "episodic-memory"],
          activityLevel: "substantial",
          project: "agenr",
        });
      }),
  });
  openClawLlmClientMocks.createOpenClawLlmClient.mockImplementation(async (host: AgenrOpenClawHost, _modelRef?: string, label?: string): Promise<LlmPort> => {
    const testHost = host as TestOpenClawHost;
    if (label === "episode model override") {
      return createLlmPort(testHost.__testLlm.episodeSummaryRunImplementation);
    }

    throw new Error(`Unexpected OpenClaw LLM client label: ${label ?? "missing"}`);
  });

  return {
    openClaw,
    config: {
      dbPath: "test.db",
      configPath: "test-config.json",
    },
    pluginConfig: options.pluginConfig ?? {},
    agenrConfig: {},
    durables: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database),
    dreaming: createDreamPort(database),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
    },
    beforeTurn: {
      recall,
      procedures: database,
      ...(available
        ? {
            embedQuery: async (text: string) => {
              const vectors = await embedding.embed([text]);
              return vectors[0] ?? [];
            },
          }
        : {}),
    },
    embedding,
    recall,
    embeddingStatus: {
      available,
      provider: available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(available ? {} : { error: "Embedding API key is required." }),
    },
    debugSink: options.debugSink ?? createNoopAgenrDebugSink(),
    ...createStubAgenrHostMemorySurface(),
    async close() {
      await database.close();
    },
  };
}

type TestOpenClawHost = AgenrOpenClawHost & {
  __testLlm: {
    episodeSummaryRunImplementation: LlmPort["complete"];
  };
};

function createOpenClawHost(options: { episodeSummaryRunImplementation: LlmPort["complete"] }): TestOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-test-agent");
  const config = {
    defaultAgent: "main",
    agents: {
      list: [
        {
          id: "main",
          workspace: workspaceDir,
          agentDir,
          model: "openai/gpt-5.4-mini",
        },
      ],
    },
  } as unknown as OpenClawConfig;

  return {
    config,
    runtime: {
      agent: {
        resolveAgentDir: () => agentDir,
        resolveAgentWorkspaceDir: () => workspaceDir,
        runEmbeddedPiAgent: vi.fn(async () => {
          throw new Error("Embedded agent runner should not be used in before-prompt-build tests.");
        }),
      },
      modelAuth: {
        resolveApiKeyForProvider: async () => ({
          apiKey: "openclaw-test-key",
          source: "profile:default",
          mode: "api-key",
        }),
      },
      state: {
        resolveStateDir: (env?: NodeJS.ProcessEnv) => resolveOpenClawStateDir(env),
      },
    },
    __testLlm: {
      episodeSummaryRunImplementation: options.episodeSummaryRunImplementation,
    },
  };
}

function createLlmPort(complete: LlmPort["complete"]): LlmPort {
  return {
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
    },
  };
}

function createObservedRecallPorts(
  options: {
    ftsCandidates?: RecallCandidateDurable[];
    hydratedDurables?: Durable[];
  } = {},
) {
  const hydratedDurablesById = new Map((options.hydratedDurables ?? []).map((durable) => [durable.id, durable]));
  return {
    embed: vi.fn(async (): Promise<number[]> => createEmbedding(0, 1)),
    vectorSearch: vi.fn(async () => []),
    ftsSearch: vi.fn(async () =>
      (options.ftsCandidates ?? []).map((durable) => ({
        durable,
        rank: -1,
        tier: "all_tokens" as const,
      })),
    ),
    hydrateDurables: vi.fn(async (ids: string[]) => ids.flatMap((id) => hydratedDurablesById.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  } satisfies RecallPorts;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function getMessages(logFn: ReturnType<typeof vi.fn>): string[] {
  return logFn.mock.calls.map(([message]) => message as string);
}

function listExecutedSql(executeCalls: unknown[][]): string[] {
  return executeCalls.flatMap(([statementOrSql]) => {
    if (typeof statementOrSql === "string") {
      return [statementOrSql];
    }

    if (hasSqlText(statementOrSql)) {
      return [statementOrSql.sql];
    }

    return [];
  });
}

function hasSqlText(value: unknown): value is { sql: string } {
  return typeof value === "object" && value !== null && "sql" in value && typeof value.sql === "string";
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

function createMetadataBlock(sentinel: string, payload: object): string {
  return [sentinel, "```json", JSON.stringify(payload), "```"].join("\n");
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = new Date("2026-03-27T12:00:00.000Z").toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "test subject",
    content: overrides.content ?? "test content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? "2026-04-01T00:00:00.000Z";
  const body = {
    procedure_key: overrides.procedure_key ?? "agenr/release",
    title: overrides.title ?? "Release agenr and publish packages",
    goal: overrides.goal ?? "Cut a release and publish packages safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when you need to ship a new agenr release."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a local dry run."],
    prerequisites: overrides.prerequisites ?? ["A clean repo state is available."],
    steps: overrides.steps ?? [
      {
        id: "read-doc",
        kind: "read_reference" as const,
        instruction: "Read the release procedure reference.",
        ref: {
          kind: "manual" as const,
          label: "release docs",
        },
      },
    ],
    verification: overrides.verification ?? ["The workflow completed successfully."],
    failure_modes: overrides.failure_modes ?? ["Validation fails before publish."],
    sources: overrides.sources ?? [
      {
        kind: "manual" as const,
        label: "fixture",
      },
    ],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}

function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
