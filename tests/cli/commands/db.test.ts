import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { registerDbCommand } from "../../../src/cli/commands/db.js";

describe("registerDbCommand", () => {
  it("registers the db reset subcommand on the program", () => {
    const program = createProgram();
    const dbCommand = program.commands.find((command) => command.name() === "db");

    expect(dbCommand?.commands.some((command) => command.name() === "reset")).toBe(true);
  });

  it("parses the db reset --yes option", () => {
    const program = new Command();
    registerDbCommand(program);

    const dbCommand = program.commands.find((command) => command.name() === "db");
    const resetCommand = dbCommand?.commands.find((command) => command.name() === "reset");

    if (!resetCommand) {
      throw new Error("db reset command was not registered.");
    }

    resetCommand.parseOptions(["--yes"]);

    expect(resetCommand.opts()).toEqual(
      expect.objectContaining({
        yes: true,
      }),
    );
  });
});
