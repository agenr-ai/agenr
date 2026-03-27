import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { registerRecallCommand } from "../../../src/cli/commands/recall.js";

describe("registerRecallCommand", () => {
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
});
