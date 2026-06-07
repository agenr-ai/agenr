import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveStateDir as resolveOpenClawStateDir } from "openclaw/plugin-sdk/state-paths";
import type { Mock } from "vitest";
import { vi } from "vitest";

import { createDreamPort } from "../../src/adapters/db/dreaming-port.js";
import { createMemoryRepository } from "../../src/adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../src/adapters/db/session-start-repository.js";
import type { SqlDatabase } from "../../src/adapters/db/client.js";
import { createNoopAgenrDebugSink } from "../../src/adapters/openclaw/debug/index.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../src/adapters/openclaw/types.js";
import { resolveRuntimeCapabilities } from "../../src/app/features/capabilities.js";
import type { EmbeddingPort, LlmPort, RecallPorts } from "../../src/core/ports.js";
import { createStubAgenrHostMemorySurface } from "./host-memory-stubs.js";
import {
  createOpenClawTestFeatureFlags,
  createOpenClawWorkingMemoryHostSurface,
  isOpenClawWorkingMemoryEnabled,
  type OpenClawWorkingMemoryTestOptions,
} from "./openclaw-working-memory.js";

/** OpenClaw LLM client mock handle supplied by each before-prompt-build test file. */
export interface OpenClawBeforePromptBuildLlmMocks {
  createOpenClawLlmClient: Mock;
}

/** Options for building OpenClaw before-prompt-build service doubles in adapter tests. */
export interface OpenClawBeforePromptBuildServiceOptions extends OpenClawWorkingMemoryTestOptions {
  available?: boolean;
  recall?: RecallPorts;
  pluginConfig?: AgenrOpenClawServices["pluginConfig"];
  episodeSummaryRunImplementation?: LlmPort["complete"];
  debugSink?: AgenrOpenClawServices["debugSink"];
}

type TestOpenClawHost = AgenrOpenClawHost & {
  __testLlm: {
    episodeSummaryRunImplementation: LlmPort["complete"];
  };
};

/**
 * Builds one OpenClaw services object for before-prompt-build adapter tests.
 *
 * @param database - Open test database backing recall and session-start repositories.
 * @param llmMocks - Hoisted LLM client mock from the calling test file.
 * @param options - Recall, policy, and optional working-memory projection doubles.
 * @returns Composed services matching the production OpenClaw runtime shape.
 */
export function createOpenClawBeforePromptBuildServices(
  database: SqlDatabase,
  llmMocks: OpenClawBeforePromptBuildLlmMocks,
  options: OpenClawBeforePromptBuildServiceOptions = {},
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
  const openClaw = createOpenClawTestHost({
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
  llmMocks.createOpenClawLlmClient.mockImplementation(async (host: AgenrOpenClawHost, _modelRef?: string, label?: string): Promise<LlmPort> => {
    const testHost = host as TestOpenClawHost;
    if (label === "episode model override") {
      return createLlmPort(testHost.__testLlm.episodeSummaryRunImplementation);
    }

    throw new Error(`Unexpected OpenClaw LLM client label: ${label ?? "missing"}`);
  });

  const featureFlags = createOpenClawTestFeatureFlags(options);
  const workingMemoryRepository = isOpenClawWorkingMemoryEnabled(options) ? ({} as AgenrOpenClawServices["workingMemoryRepository"]) : undefined;
  const capabilities = resolveRuntimeCapabilities(featureFlags, { workingMemoryRepository });
  const hostMemorySurface = isOpenClawWorkingMemoryEnabled(options) ? createOpenClawWorkingMemoryHostSurface(options) : createStubAgenrHostMemorySurface();

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
    ...hostMemorySurface,
    capabilities,
    runtimePolicy: {
      featureFlags,
      capabilities,
    },
    async close() {
      await database.close();
    },
  };
}

/** Creates one OpenClaw host double for before-prompt-build adapter tests. */
function createOpenClawTestHost(options: { episodeSummaryRunImplementation: LlmPort["complete"] }): TestOpenClawHost {
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

/** Creates one isolated SQLite database path for OpenClaw before-prompt-build tests. */
export function createOpenClawBeforePromptBuildDatabasePath(): string {
  return path.join(os.tmpdir(), `agenr-openclaw-${randomUUID()}.sqlite`);
}
