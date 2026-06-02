import { Command } from "commander";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { registerDbCommand, resolveResetPath } from "../../../src/cli/commands/db.js";

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

describe("resolveResetPath", () => {
  it("resolves relative file URLs to the correct local file", () => {
    expect(resolveResetPath("file:relative%20db/knowledge.db")).toEqual({
      deletePath: path.resolve("relative db", "knowledge.db"),
      displayPath: path.resolve("relative db", "knowledge.db"),
    });
  });
});
