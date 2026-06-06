import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { registerRecallCommand } from "../../../src/cli/commands/recall.js";

describe("registerRecallCommand", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("registers the recall command on the program", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "recall")).toBe(true);
  });

  it("requires the query argument", async () => {
    const program = new Command();
    registerRecallCommand(program);

    const recallCommand = program.commands.find((command) => command.name() === "recall");
    if (!recallCommand) {
      throw new Error("Recall command was not registered.");
    }

    recallCommand.configureOutput({
      writeErr: () => {},
      outputError: () => {},
    });
    recallCommand.exitOverride();

    await expect(recallCommand.parseAsync([], { from: "user" })).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });

  it("parses recall command options", () => {
    const program = new Command();
    registerRecallCommand(program);

    const recallCommand = program.commands.find((command) => command.name() === "recall");
    if (!recallCommand) {
      throw new Error("Recall command was not registered.");
    }

    const parsed = recallCommand.parseOptions([
      "hybrid retrieval",
      "--limit",
      "5",
      "--threshold",
      "0.4",
      "--budget",
      "300",
      "--types",
      "fact,decision",
      "--tags",
      "codex,workflow",
      "--since",
      "7d",
      "--until",
      "2026-03-01",
      "--around",
      "yesterday",
      "--as-of",
      "2026-03-01",
      "--around-radius",
      "21",
      "--verbose",
    ]);

    expect(parsed.operands).toEqual(["hybrid retrieval"]);
    expect(recallCommand.opts()).toEqual(
      expect.objectContaining({
        limit: 5,
        threshold: 0.4,
        budget: 300,
        types: ["fact", "decision"],
        tags: ["codex", "workflow"],
        since: "7d",
        until: "2026-03-01",
        around: "yesterday",
        asOf: "2026-03-01",
        aroundRadius: 21,
        verbose: true,
      }),
    );
  });

  it("normalizes recall input before invoking the core recall service", async () => {
    const recallMock = vi.fn(async () => []);

    vi.resetModules();
    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/db/recall-adapter.js", () => ({
      createRecallAdapter: vi.fn(() => ({ search: vi.fn() })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
      })),
    }));
    vi.doMock("../../../src/core/recall/index.js", () => ({
      recall: recallMock,
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      ui: {
        error: (text: string) => text,
      },
    }));

    const { registerRecallCommand: registerMockedRecallCommand } = await import("../../../src/cli/commands/recall.js");
    const program = new Command();
    registerMockedRecallCommand(program);

    await program.parseAsync(
      ["recall", "  hybrid retrieval  ", "--tags", " codex , workflow , codex ", "--since", " 7d ", "--around", " yesterday ", "--as-of", " 2026-03-01 "],
      {
        from: "user",
      },
    );

    expect(recallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hybrid retrieval",
        tags: ["codex", "workflow"],
        since: "7d",
        around: "yesterday",
        asOf: "2026-03-01",
      }),
      expect.anything(),
      expect.objectContaining({
        trace: expect.any(Object),
      }),
    );
  });

  it("preserves class-backed recall port methods when the cross-encoder is wired", async () => {
    const recallMock = vi.fn(async () => []);

    class RecallAdapterStub {
      public async embed(): Promise<number[]> {
        return [];
      }

      public async vectorSearch(): Promise<[]> {
        return [];
      }

      public async ftsSearch(): Promise<[]> {
        return [];
      }

      public async hydrateEntries(): Promise<[]> {
        return [];
      }

      public async recordRecallEvents(): Promise<void> {
        return;
      }
    }

    vi.resetModules();
    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/db/recall-adapter.js", () => ({
      createRecallAdapter: vi.fn(() => new RecallAdapterStub()),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      resolveModel: vi.fn(() => ({
        modelId: "gpt-5.4-nano",
      })),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
        credentials: {
          openaiApiKey: "sk-cross-encoder",
        },
      })),
    }));
    vi.doMock("../../../src/core/recall/index.js", () => ({
      recall: recallMock,
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      ui: {
        error: (text: string) => text,
      },
    }));

    const { registerRecallCommand: registerMockedRecallCommand } = await import("../../../src/cli/commands/recall.js");
    const program = new Command();
    registerMockedRecallCommand(program);

    await program.parseAsync(["recall", "hybrid retrieval"], { from: "user" });

    expect(recallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hybrid retrieval",
      }),
      expect.objectContaining({
        crossEncoder: expect.any(Object),
        ftsSearch: expect.any(Function),
        vectorSearch: expect.any(Function),
        hydrateEntries: expect.any(Function),
        recordRecallEvents: expect.any(Function),
      }),
      expect.objectContaining({
        trace: expect.any(Object),
      }),
    );
  });

  it("renders claim-centric trust annotations in verbose recall output", async () => {
    const stepMock = vi.fn();
    vi.resetModules();
    vi.doMock("@clack/prompts", () => ({
      ...createClackMock(),
      log: {
        step: stepMock,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/db/recall-adapter.js", () => ({
      createRecallAdapter: vi.fn(() => ({ search: vi.fn() })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
      })),
    }));
    vi.doMock("../../../src/core/recall/index.js", () => ({
      recall: vi.fn(async () => [
        {
          entry: {
            id: "entry-1",
            type: "decision",
            subject: "deployment approach",
            content: "Before the migration we used webpack.",
            importance: 8,
            expiry: "permanent",
            tags: ["deploy"],
            quality_score: 0.5,
            recall_count: 0,
            created_at: "2026-02-01T00:00:00.000Z",
            updated_at: "2026-02-01T00:00:00.000Z",
            claim_key: "deployment/approach",
            claim_key_status: "trusted",
            superseded_by: "entry-2",
            valid_to: "2026-03-20T00:00:00.000Z",
          },
          score: 0.88,
          scores: {
            vector: 0.8,
            lexical: 0.6,
            recency: 0.5,
            importance: 0.8,
            relevance: 0.72,
            historicalLineage: 0.08,
            claimKeyTrustPenalty: 0,
            claimKeyRedundancyPenalty: 0,
          },
        },
      ]),
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      ui: {
        bold: (text: string) => text,
        error: (text: string) => text,
      },
    }));

    const { registerRecallCommand: registerMockedRecallCommand } = await import("../../../src/cli/commands/recall.js");
    const program = new Command();
    registerMockedRecallCommand(program);

    await program.parseAsync(["recall", "previous deployment approach", "--verbose", "--as-of", "2026-03-01"], { from: "user" });

    const rendered = stepMock.mock.calls[0]?.[0] as string;
    expect(rendered).toContain("state=current");
    expect(rendered).toContain("claim_status=trusted");
    expect(rendered).toContain("slot_policy=exclusive");
    expect(rendered).toContain("family=deployment/approach");
    expect(rendered).toContain("as_of 2026-03-01T00:00:00.000Z via validity");
    expect(rendered).toContain("why=semantic similarity 0.80; lexical overlap 0.60; historical lineage boost 0.08");
    expect(rendered).toContain("historicalLineage=0.08");
  });

  it("warns when recall had to degrade into lexical-only mode", async () => {
    const warnMock = vi.fn();
    vi.resetModules();
    vi.doMock("@clack/prompts", () => ({
      ...createClackMock(),
      log: {
        step: vi.fn(),
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
      },
    }));
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/db/recall-adapter.js", () => ({
      createRecallAdapter: vi.fn(() => ({ search: vi.fn() })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
      })),
    }));
    const recallMock = vi.fn(async (_request, _adapter, options) => {
      options?.trace?.reportSummary({
        filtering: {
          types: [],
          tags: [],
        },
        ranking: {
          limit: 10,
          threshold: 0,
          budget: null,
        },
        candidateCounts: {
          merged: 1,
          thresholdQualified: 1,
          budgetAccepted: 1,
          finalRanked: 1,
          returned: 1,
        },
        claimKey: {
          historicalBoosted: 0,
          tentativeLineageSuppressed: 0,
          trustPenalized: 0,
          redundancyPenalized: 0,
        },
        degraded: {
          active: true,
          reasons: ["query_embedding_failed"],
          lexicalOnly: true,
          notices: ["Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking."],
        },
        timings: {
          mergeCandidatesMs: 0,
          scoreCandidatesMs: 0,
          thresholdMs: 0,
          budgetMs: 0,
          shapeResultsMs: 0,
        },
      });
      return [];
    });
    vi.doMock("../../../src/core/recall/index.js", () => ({
      recall: recallMock,
    }));
    vi.doMock("../../../src/ui.js", () => ({
      banner: vi.fn(() => "agenr"),
      ui: {
        error: (text: string) => text,
      },
    }));

    const { registerRecallCommand: registerMockedRecallCommand } = await import("../../../src/cli/commands/recall.js");
    const program = new Command();
    registerMockedRecallCommand(program);

    await program.parseAsync(["recall", "who is on call"], { from: "user" });

    expect(warnMock).toHaveBeenCalledWith("Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking.");
  });
});

function createClackMock() {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
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
