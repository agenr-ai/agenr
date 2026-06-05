import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngestPathOptions } from "../../../src/app/ingestion/service.js";
import { pluralize, registerIngestCommand } from "../../../src/cli/commands/ingest.js";
import { createProgram } from "../../../src/cli/main.js";
import { APP_VERSION } from "../../../src/version.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("registerIngestCommand", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("registers the ingest command group on the program", () => {
    const program = createProgram();
    const ingestCommand = findIngestCommand(program);

    expect(ingestCommand).toBeDefined();
    expect(ingestCommand?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["durables", "episodes", "procedures"]));
  });

  it("requires the entries path argument", async () => {
    const program = new Command();
    registerIngestCommand(program);

    const entriesCommand = requireSubcommand(program, "durables");

    entriesCommand.configureOutput({
      writeErr: () => {},
      outputError: () => {},
    });
    entriesCommand.exitOverride();

    await expect(entriesCommand.parseAsync([], { from: "user" })).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });

  it("parses entries command options", () => {
    const program = new Command();
    registerIngestCommand(program);

    const entriesCommand = requireSubcommand(program, "durables");

    const parsed = entriesCommand.parseOptions(["/tmp/session.jsonl", "--verbose", "--dry-run", "--whole-file", "force", "--skip-dedup", "--concurrency", "6"]);

    expect(parsed.operands).toEqual(["/tmp/session.jsonl"]);
    expect(entriesCommand.opts()).toEqual(
      expect.objectContaining({
        verbose: true,
        dryRun: true,
        wholeFile: "force",
        skipDedup: true,
        concurrency: 6,
      }),
    );
  });

  it("parses entries --skip-dedup as a boolean flag", () => {
    const program = new Command();
    registerIngestCommand(program);

    const entriesCommand = requireSubcommand(program, "durables");

    entriesCommand.parseOptions(["/tmp/session.jsonl", "--skip-dedup"]);

    expect(entriesCommand.opts()).toEqual(
      expect.objectContaining({
        skipDedup: true,
      }),
    );
  });

  it("leaves entries concurrency unset until runtime resolution", () => {
    const program = new Command();
    registerIngestCommand(program);

    const entriesCommand = requireSubcommand(program, "durables");

    entriesCommand.parseOptions(["/tmp/session.jsonl"]);

    expect(entriesCommand.opts()).not.toHaveProperty("concurrency");
  });

  it("allows omitting the episodes path when --embed-only is used", () => {
    const program = new Command();
    registerIngestCommand(program);

    const episodesCommand = requireSubcommand(program, "episodes");
    const parsed = episodesCommand.parseOptions(["--embed-only"]);

    expect(parsed.operands).toEqual([]);
    expect(episodesCommand.opts()).toEqual(
      expect.objectContaining({
        embedOnly: true,
      }),
    );
  });

  it("parses episode ingest options", () => {
    const program = new Command();
    registerIngestCommand(program);

    const episodesCommand = requireSubcommand(program, "episodes");

    const parsed = episodesCommand.parseOptions([
      "/tmp/sessions",
      "--db",
      "/tmp/knowledge.db",
      "--recent",
      "30d",
      "--regenerate",
      "--dry-run",
      "--verbose",
      "--concurrency",
      "12",
      "--model",
      "anthropic/claude-sonnet-4-6",
    ]);

    expect(parsed.operands).toEqual(["/tmp/sessions"]);
    expect(episodesCommand.opts()).toEqual(
      expect.objectContaining({
        db: "/tmp/knowledge.db",
        recent: "30d",
        regenerate: true,
        dryRun: true,
        verbose: true,
        concurrency: 12,
        model: "anthropic/claude-sonnet-4-6",
      }),
    );
  });

  it("defaults episode ingest concurrency to 10", () => {
    const program = new Command();
    registerIngestCommand(program);

    const episodesCommand = requireSubcommand(program, "episodes");

    episodesCommand.parseOptions(["/tmp/sessions"]);

    expect(episodesCommand.opts()).toEqual(
      expect.objectContaining({
        concurrency: 10,
      }),
    );
  });

  it("injects the banner into ingest help output", () => {
    const program = createProgram();
    const ingestCommand = requireIngestCommand(program);

    const output: string[] = [];
    ingestCommand.configureOutput({
      writeOut: (text: string) => {
        output.push(text);
      },
      writeErr: () => {},
      outputError: () => {},
    });

    ingestCommand.outputHelp();

    const help = stripAnsi(output.join("")).toLowerCase();

    expect(help).toContain("agenr");
    expect(help).toContain(APP_VERSION.toLowerCase());
  });

  it("normalizes the entries path before discovering transcript files", async () => {
    const discoverFilesMock = vi.fn(async () => []);

    vi.resetModules();
    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/transcript-files.js", () => ({
      localTranscriptFiles: {
        discoverFiles: discoverFilesMock,
      },
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: vi.fn(() => ({
        complete: vi.fn(),
        completeJson: vi.fn(),
      })),
      resolveLlmApiKey: vi.fn(() => "sk-test"),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/ingestion/index.js", () => ({
      DEFAULT_INGEST_CONCURRENCY: 10,
      ingestDiscoveredFiles: vi.fn(),
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
        extractionContext: undefined,
      })),
      resolveClaimExtractionConfig: vi.fn(() => ({
        enabled: false,
      })),
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

    const { registerIngestCommand: registerMockedIngestCommand } = await import("../../../src/cli/commands/ingest.js");
    const program = new Command();
    registerMockedIngestCommand(program);

    await program.parseAsync(["node", "test", "ingest", "durables", "  /tmp/transcripts  "], {
      from: "node",
    });

    expect(discoverFilesMock).toHaveBeenCalledWith("/tmp/transcripts");
  });

  it("updates the non-verbose spinner with in-phase dedup and claim-extraction progress", async () => {
    const clackMock = createClackMock();
    const ingestDiscoveredFilesMock = vi.fn(async (_files: string[], _ports: unknown, options: IngestPathOptions) => {
      options.onExtractionProgress?.(2, 2);
      options.onStageProgress?.({ phase: "dedup_start", totalEntries: 4 });
      options.onDedupProgress?.({
        completedClusters: 12,
        totalClusters: 47,
        completedEntries: 388,
        totalEntries: 1098,
      });
      options.onStageProgress?.({ phase: "claim_extraction_start", totalEntries: 4 });
      options.onClaimExtractionProgress?.({
        phase: "primary",
        completedEntries: 437,
        totalEntries: 1098,
        totalEligibleEntries: 1098,
      });
      options.onClaimExtractionProgress?.({
        phase: "retry",
        completedEntries: 21,
        totalEntries: 94,
        totalEligibleEntries: 1098,
      });
      options.onStageProgress?.({ phase: "store_start", totalEntries: 4 });
      options.onBulkWriteProgress?.({ phase: "prepare_start" });
      options.onBulkWriteProgress?.({ phase: "finalize_start" });
      return {
        files: ["/tmp/session-a.jsonl", "/tmp/session-b.jsonl"],
        extractionRuns: [],
        dedupResult: { removedCount: 0 },
        dedupUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          calls: 0,
        },
        storeResults: new Map(),
        claimKeyHealth: null,
      };
    });

    vi.resetModules();
    vi.doMock("@clack/prompts", () => clackMock);
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/transcript-files.js", () => ({
      localTranscriptFiles: {
        discoverFiles: vi.fn(async () => ["/tmp/session-a.jsonl", "/tmp/session-b.jsonl"]),
      },
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: vi.fn(() => ({
        complete: vi.fn(),
        completeJson: vi.fn(),
      })),
      resolveLlmApiKey: vi.fn(() => "sk-test"),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/ingestion/index.js", () => ({
      DEFAULT_INGEST_CONCURRENCY: 10,
      ingestDiscoveredFiles: ingestDiscoveredFilesMock,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
        extractionContext: undefined,
      })),
      resolveClaimExtractionConfig: vi.fn(() => ({
        enabled: false,
      })),
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

    const { registerIngestCommand: registerMockedIngestCommand } = await import("../../../src/cli/commands/ingest.js");
    const program = new Command();
    registerMockedIngestCommand(program);

    await program.parseAsync(["node", "test", "ingest", "durables", "/tmp/transcripts"], {
      from: "node",
    });

    const spinnerInstance = (clackMock.spinner as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const messages = (spinnerInstance?.message as ReturnType<typeof vi.fn>).mock.calls.map(([message]: [string]) => message);

    expect(messages).toEqual(
      expect.arrayContaining([
        "Processing transcripts... (2/2 extracted)",
        "Deduplicating entries...",
        "Deduplicating entries... 12/47 clusters arbitrated (388/1098 entries covered)",
        "Extracting claim keys...",
        "Extracting claim keys... 437/1098 entries",
        "Retrying unresolved claim keys... 21/94 entries",
        "Running store pipeline for 4 durables...",
        "Preparing database indexes for bulk ingest...",
        "Rebuilding indexes after bulk ingest...",
      ]),
    );
  });

  it("overrides claim extraction concurrency from the CLI flag", async () => {
    const ingestDiscoveredFilesMock = vi.fn(async () => ({
      files: ["/tmp/session-a.jsonl"],
      extractionRuns: [],
      dedupResult: { removedCount: 0 },
      dedupUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        calls: 0,
      },
      storeResults: new Map(),
      claimKeyHealth: null,
    }));

    vi.resetModules();
    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/transcript-files.js", () => ({
      localTranscriptFiles: {
        discoverFiles: vi.fn(async () => ["/tmp/session-a.jsonl"]),
      },
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: vi.fn(() => ({
        complete: vi.fn(),
        completeJson: vi.fn(),
      })),
      resolveLlmApiKey: vi.fn(() => "sk-test"),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/ingestion/index.js", () => ({
      DEFAULT_INGEST_CONCURRENCY: 10,
      ingestDiscoveredFiles: ingestDiscoveredFilesMock,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
        extractionContext: undefined,
      })),
      resolveClaimExtractionConfig: vi.fn(() => ({
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
        concurrency: 3,
      })),
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

    const { registerIngestCommand: registerMockedIngestCommand } = await import("../../../src/cli/commands/ingest.js");
    const program = new Command();
    registerMockedIngestCommand(program);

    await program.parseAsync(["node", "test", "ingest", "durables", "/tmp/transcripts", "--concurrency", "50"], {
      from: "node",
    });

    expect(ingestDiscoveredFilesMock).toHaveBeenCalledWith(
      ["/tmp/session-a.jsonl"],
      expect.any(Object),
      expect.objectContaining({
        concurrency: 50,
        claimExtractionConfig: expect.objectContaining({
          concurrency: 50,
        }),
      }),
    );
  });

  it("uses config concurrency for extraction, dedup, and claim extraction when the CLI flag is omitted", async () => {
    const ingestDiscoveredFilesMock = vi.fn(async () => ({
      files: ["/tmp/session-a.jsonl"],
      extractionRuns: [],
      dedupResult: { removedCount: 0 },
      dedupUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        calls: 0,
      },
      storeResults: new Map(),
      claimKeyHealth: null,
    }));

    vi.resetModules();
    vi.doMock("@clack/prompts", () => createClackMock());
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient: vi.fn(() => ({ embed: vi.fn() })),
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/transcript-files.js", () => ({
      localTranscriptFiles: {
        discoverFiles: vi.fn(async () => ["/tmp/session-a.jsonl"]),
      },
    }));
    vi.doMock("../../../src/adapters/llm.js", () => ({
      createLlmClient: vi.fn(() => ({
        complete: vi.fn(),
        completeJson: vi.fn(),
      })),
      resolveLlmApiKey: vi.fn(() => "sk-test"),
      resolveModel: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      })),
    }));
    vi.doMock("../../../src/adapters/openclaw/transcript/parser.js", () => ({
      openClawTranscriptParser: {
        parseFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/ingestion/index.js", () => ({
      DEFAULT_INGEST_CONCURRENCY: 10,
      ingestDiscoveredFiles: ingestDiscoveredFilesMock,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
        extractionContext: undefined,
      })),
      resolveClaimExtractionConfig: vi.fn(() => ({
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
        concurrency: 7,
      })),
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

    const { registerIngestCommand: registerMockedIngestCommand } = await import("../../../src/cli/commands/ingest.js");
    const program = new Command();
    registerMockedIngestCommand(program);

    await program.parseAsync(["node", "test", "ingest", "durables", "/tmp/transcripts"], {
      from: "node",
    });

    expect(ingestDiscoveredFilesMock).toHaveBeenCalledWith(
      ["/tmp/session-a.jsonl"],
      expect.any(Object),
      expect.objectContaining({
        concurrency: 7,
        claimExtractionConfig: expect.objectContaining({
          concurrency: 7,
        }),
      }),
    );
  });
});

describe("pluralize", () => {
  it('returns "durables" for zero entries', () => {
    expect(pluralize(0, "entry", "durables")).toBe("durables");
  });

  it('returns "entry" for one entry', () => {
    expect(pluralize(1, "entry", "durables")).toBe("entry");
  });

  it('returns "durables" for multiple entries', () => {
    expect(pluralize(2, "entry", "durables")).toBe("durables");
  });

  it("falls back to appending s for regular plurals", () => {
    expect(pluralize(2, "file")).toBe("files");
  });
});

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

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

function findIngestCommand(program: Command) {
  return program.commands.find((command) => command.name() === "ingest");
}

function requireIngestCommand(program: Command): Command {
  const ingestCommand = findIngestCommand(program);
  if (!ingestCommand) {
    throw new Error("Ingest command was not registered.");
  }

  return ingestCommand;
}

function requireSubcommand(program: Command, name: "durables" | "episodes"): Command {
  const ingestCommand = requireIngestCommand(program);
  const subcommand = ingestCommand.commands.find((command) => command.name() === name);
  if (!subcommand) {
    throw new Error(`Ingest ${name} subcommand was not registered.`);
  }

  return subcommand;
}
