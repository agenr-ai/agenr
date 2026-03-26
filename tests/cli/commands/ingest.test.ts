import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerIngestCommand } from "../../../src/cli/commands/ingest.js";
import { createProgram } from "../../../src/cli/main.js";

describe("registerIngestCommand", () => {
  it("registers the ingest command on the program", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "ingest")).toBe(true);
  });

  it("requires the path argument", async () => {
    const program = new Command();
    registerIngestCommand(program);

    const ingestCommand = program.commands.find((command) => command.name() === "ingest");
    if (!ingestCommand) {
      throw new Error("Ingest command was not registered.");
    }

    ingestCommand.configureOutput({
      writeErr: () => {},
      outputError: () => {},
    });
    ingestCommand.exitOverride();

    await expect(ingestCommand.parseAsync([], { from: "user" })).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });

  it("parses ingest command options", () => {
    const program = new Command();
    registerIngestCommand(program);

    const ingestCommand = program.commands.find((command) => command.name() === "ingest");
    if (!ingestCommand) {
      throw new Error("Ingest command was not registered.");
    }

    const parsed = ingestCommand.parseOptions(["/tmp/session.jsonl", "--verbose", "--dry-run", "--whole-file", "force", "--skip-embeddings"]);

    expect(parsed.operands).toEqual(["/tmp/session.jsonl"]);
    expect(ingestCommand.opts()).toEqual(
      expect.objectContaining({
        verbose: true,
        dryRun: true,
        wholeFile: "force",
        skipEmbeddings: true,
      }),
    );
  });
});
