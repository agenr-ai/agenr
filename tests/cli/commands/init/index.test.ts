import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../../../src/cli/main.js";
import { registerInitCommand } from "../../../../src/cli/commands/init/index.js";

describe("registerInitCommand", () => {
  it("registers the init command on the root program", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "init")).toBe(true);
  });

  it("can be registered on a standalone commander program", () => {
    const program = new Command();
    registerInitCommand(program);

    expect(program.commands.some((command) => command.name() === "init")).toBe(true);
  });
});
