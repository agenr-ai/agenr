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

    await program.parseAsync(["recall", "  hybrid retrieval  ", "--tags", " codex , workflow , codex ", "--since", " 7d ", "--around", " yesterday "], {
      from: "user",
    });

    expect(recallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hybrid retrieval",
        tags: ["codex", "workflow"],
        since: "7d",
        around: "yesterday",
      }),
      expect.anything(),
    );
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
