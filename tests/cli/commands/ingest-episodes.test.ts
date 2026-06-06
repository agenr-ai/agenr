import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestPath } from "../../helpers/temp-paths.js";

describe("registerIngestEpisodesCommand", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("skips write-time embeddings when --no-embed is passed", async () => {
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      EMBEDDING_MODEL: "text-embedding-3-small",
      createEmbeddingClient: vi.fn(),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    const { resolveEpisodeEmbeddingSetup } = await import("../../../src/cli/commands/ingest-episodes.js");

    const result = resolveEpisodeEmbeddingSetup({}, { noEmbed: true });

    expect(result).toEqual({
      statusLabel: "skipped (--no-embed)",
    });
  });

  it("uses the embedding-only backfill path when --embed-only is passed", async () => {
    const backfillEpisodeEmbeddings = vi.fn(async () => ({
      totalMissing: 1,
      attempted: 1,
      embedded: 1,
      failed: 0,
      estimatedInputTokens: 10,
    }));

    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("node:fs/promises", () => ({
      default: {},
      stat: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        listEpisodesWithoutEmbeddings: vi.fn(async () => [
          {
            id: "episode-1",
            source: "openclaw",
            sourceId: "episode-1",
            startedAt: "2026-03-30T09:00:00.000Z",
            endedAt: "2026-03-30T09:30:00.000Z",
            summary: "Missing embedding",
            tags: [],
            createdAt: "2026-03-30T09:30:00.000Z",
            updatedAt: "2026-03-30T09:30:00.000Z",
            embedding: [],
          },
        ]),
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      EMBEDDING_MODEL: "text-embedding-3-small",
      createEmbeddingClient: vi.fn(() => ({
        embed: vi.fn(async () => [[1, 0]]),
      })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: vi.fn(),
      resolveLlmApiKey: vi.fn(),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/session/session-registry.js", () => ({
      loadOpenClawSessionRegistry: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/openclaw/session/transcript-files.js", () => ({
      openClawTranscriptFiles: {
        discoverFiles: vi.fn(),
      },
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/episode-ingest/index.js", () => ({
      prepareEpisodeIngest: vi.fn(),
      createEpisodeIngestPlan: vi.fn(),
      executeEpisodeIngestPlan: vi.fn(),
      backfillEpisodeEmbeddings,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({})),
      resolveDbPath: vi.fn(() => "/tmp/knowledge.db"),
    }));
    vi.doMock("../../../src/logger.js", () => ({
      setVerbose: vi.fn(),
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      formatLabel: vi.fn((label: string, value: string) => `${label}: ${value}`),
      ui: {
        error: (text: string) => text,
      },
    }));

    const { registerIngestEpisodesCommand } = await import("../../../src/cli/commands/ingest-episodes.js");
    const program = new Command();
    registerIngestEpisodesCommand(program);

    await program.parseAsync(["node", "test", "episodes", "--embed-only"], {
      from: "node",
    });

    expect(backfillEpisodeEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("normalizes the target path and model override before preflight", async () => {
    const statMock = vi.fn(async () => ({
      isFile: () => false,
    }));
    const createDatabaseMock = vi.fn(async () => ({
      close: vi.fn(async () => undefined),
    }));
    const createLlmClientMock = vi.fn(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(),
      metadata: {
        model: {
          cost: {},
        },
        usage: {},
      },
    }));
    const prepareEpisodeIngestMock = vi.fn(async () => ({
      files: ["/tmp/sessions/session-1.jsonl"],
      totals: {
        discovered: 1,
        skippedExists: 1,
        skippedShort: 0,
        skippedActive: 0,
        invalid: 0,
        candidates: 0,
      },
    }));

    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("node:fs/promises", () => ({
      default: {
        stat: statMock,
      },
      stat: statMock,
    }));
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: createDatabaseMock,
    }));
    vi.doMock("../../../src/adapters/db/episode-ingest-support.js", () => ({
      createEpisodeIngestSupportPort: vi.fn(() => ({
        countEntries: vi.fn(async () => 0),
        hasRelevantProvenanceMatch: vi.fn(async () => true),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      EMBEDDING_MODEL: "text-embedding-3-small",
      createEmbeddingClient: vi.fn(() => ({
        embed: vi.fn(async () => [[1, 0]]),
      })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: createLlmClientMock,
      resolveLlmApiKey: vi.fn(() => "sk-test"),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/session/session-registry.js", () => ({
      loadOpenClawSessionRegistry: vi.fn(async () => ({})),
    }));
    vi.doMock("../../../src/adapters/openclaw/session/transcript-files.js", () => ({
      openClawTranscriptFiles: {
        discoverFiles: vi.fn(),
      },
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/episode-ingest/index.js", () => ({
      prepareEpisodeIngest: prepareEpisodeIngestMock,
      createEpisodeIngestPlan: vi.fn(() => ({
        candidates: [],
        estimate: {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        },
        model: {
          modelRef: "anthropic/claude-sonnet-4-6",
        },
      })),
      executeEpisodeIngestPlan: vi.fn(),
      backfillEpisodeEmbeddings: vi.fn(),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({})),
      resolveDbPath: vi.fn(() => "/tmp/ignored.db"),
    }));
    vi.doMock("../../../src/logger.js", () => ({
      setVerbose: vi.fn(),
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      formatLabel: vi.fn((label: string, value: string) => `${label}: ${value}`),
      ui: {
        error: (text: string) => text,
      },
    }));

    const { registerIngestEpisodesCommand } = await import("../../../src/cli/commands/ingest-episodes.js");
    const program = new Command();
    registerIngestEpisodesCommand(program);

    await program.parseAsync(["node", "test", "episodes", "  /tmp/sessions  ", "--db", "  /tmp/knowledge.db  ", "--model", " anthropic/claude-sonnet-4-6 "], {
      from: "node",
    });

    expect(createDatabaseMock).toHaveBeenCalledWith(resolveTestPath("/tmp/knowledge.db"));
    expect(statMock).toHaveBeenCalledWith(resolveTestPath("/tmp/sessions"));
    expect(createLlmClientMock).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", {});
    expect(prepareEpisodeIngestMock).toHaveBeenCalledWith(
      resolveTestPath("/tmp/sessions"),
      expect.anything(),
      expect.objectContaining({
        preflightConcurrency: 10,
      }),
    );
  });
});

function createClackMock() {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn(async () => true),
    isCancel: vi.fn(() => false),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
    log: {
      step: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}
