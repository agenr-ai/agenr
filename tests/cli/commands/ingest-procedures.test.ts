import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../../src/cli/main.js";

describe("registerIngestProceduresCommand", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("registers the procedures ingest command", () => {
    const program = createProgram();
    const ingestCommand = program.commands.find((command) => command.name() === "ingest");

    expect(ingestCommand?.commands.map((command) => command.name())).toContain("procedures");
  });

  it("defaults the procedures path to procedures on dry runs", async () => {
    const clackMock = createClackMock();
    const prepareProcedureSync = vi.fn(async () => createProcedurePlan());
    const executeProcedureSync = vi.fn();
    const createEmbeddingClient = vi.fn();

    vi.doMock("@clack/prompts", () => clackMock);
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient,
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/procedure-files.js", () => ({
      localProcedureFiles: {
        discoverFiles: vi.fn(),
        readFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/procedures/sync/index.js", () => ({
      prepareProcedureSync,
      executeProcedureSync,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
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

    const { registerIngestProceduresCommand } = await import("../../../src/cli/commands/ingest-procedures.js");
    const parent = new Command();
    registerIngestProceduresCommand(parent);

    await parent.parseAsync(["procedures", "--dry-run"], { from: "user" });

    expect(prepareProcedureSync).toHaveBeenCalledWith(
      "procedures",
      expect.objectContaining({
        db: expect.any(Object),
        files: expect.any(Object),
      }),
    );
    expect(executeProcedureSync).not.toHaveBeenCalled();
    expect(createEmbeddingClient).not.toHaveBeenCalled();
  });

  it("executes a non-dry-run procedure sync with embeddings", async () => {
    const clackMock = createClackMock();
    const prepareProcedureSync = vi.fn(async () => createProcedurePlan());
    const executeProcedureSync = vi.fn(async (plan) => ({
      plan,
      items: [
        {
          action: "created",
          filePath: "/repo/procedures/agenr-release.yaml",
          procedureKey: "agenr/release",
          procedureId: "procedure-release",
        },
      ],
      totals: {
        created: 1,
        updatedSourceOnly: 0,
        superseded: 0,
        unchanged: 0,
      },
    }));
    const createEmbeddingClient = vi.fn(() => ({
      embed: vi.fn(async () => [[1]]),
    }));

    vi.doMock("@clack/prompts", () => clackMock);
    vi.doMock("../../../src/adapters/db/client.js", () => ({
      createDatabase: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("../../../src/adapters/embeddings.js", () => ({
      createEmbeddingClient,
      resolveEmbeddingApiKey: vi.fn(() => "sk-test"),
      resolveEmbeddingModel: vi.fn(() => "text-embedding-3-small"),
    }));
    vi.doMock("../../../src/adapters/files/procedure-files.js", () => ({
      localProcedureFiles: {
        discoverFiles: vi.fn(),
        readFile: vi.fn(),
      },
    }));
    vi.doMock("../../../src/app/procedures/sync/index.js", () => ({
      prepareProcedureSync,
      executeProcedureSync,
    }));
    vi.doMock("../../../src/config.js", () => ({
      readConfig: vi.fn(() => ({
        dbPath: "/tmp/knowledge.db",
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

    const { registerIngestProceduresCommand } = await import("../../../src/cli/commands/ingest-procedures.js");
    const parent = new Command();
    registerIngestProceduresCommand(parent);

    await parent.parseAsync(["procedures", "custom-procedures"], { from: "user" });

    expect(prepareProcedureSync).toHaveBeenCalledWith(
      "custom-procedures",
      expect.objectContaining({
        db: expect.any(Object),
        files: expect.any(Object),
      }),
    );
    expect(createEmbeddingClient).toHaveBeenCalled();
    expect(executeProcedureSync).toHaveBeenCalledTimes(1);
  });
});

function createClackMock() {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
    },
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  };
}

function createProcedurePlan() {
  return {
    targetPath: "procedures",
    files: ["/repo/procedures/agenr-release.yaml"],
    items: [
      {
        action: "create",
        candidate: {
          filePath: "/repo/procedures/agenr-release.yaml",
          procedure: {
            procedure_key: "agenr/release",
            title: "Release agenr and publish packages",
            goal: "Ship a release safely.",
            when_to_use: [],
            when_not_to_use: [],
            prerequisites: [],
            steps: [
              {
                id: "read-reference",
                kind: "read_reference",
                instruction: "Read the reference.",
                ref: {
                  kind: "doc",
                  path: "README.md",
                },
              },
            ],
            verification: ["Procedure completed."],
            failure_modes: ["Procedure failed."],
            sources: [
              {
                kind: "doc",
                path: "README.md",
              },
            ],
          },
          recallText: "procedure_key: agenr/release",
          revisionHash: "revision-hash",
          sourceHash: "source-hash",
        },
      },
    ],
    totals: {
      discovered: 1,
      create: 1,
      updateSourceOnly: 0,
      supersede: 0,
      unchanged: 0,
      invalid: 0,
    },
  };
}
