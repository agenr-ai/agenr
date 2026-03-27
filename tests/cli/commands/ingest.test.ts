import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { pluralize, registerIngestCommand } from "../../../src/cli/commands/ingest.js";
import { createProgram } from "../../../src/cli/main.js";
import { APP_VERSION } from "../../../src/version.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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

    const parsed = ingestCommand.parseOptions(["/tmp/session.jsonl", "--verbose", "--dry-run", "--whole-file", "force", "--skip-dedup", "--concurrency", "6"]);

    expect(parsed.operands).toEqual(["/tmp/session.jsonl"]);
    expect(ingestCommand.opts()).toEqual(
      expect.objectContaining({
        verbose: true,
        dryRun: true,
        wholeFile: "force",
        skipDedup: true,
        concurrency: 6,
      }),
    );
  });

  it("parses --skip-dedup as a boolean flag", () => {
    const program = new Command();
    registerIngestCommand(program);

    const ingestCommand = program.commands.find((command) => command.name() === "ingest");
    if (!ingestCommand) {
      throw new Error("Ingest command was not registered.");
    }

    ingestCommand.parseOptions(["/tmp/session.jsonl", "--skip-dedup"]);

    expect(ingestCommand.opts()).toEqual(
      expect.objectContaining({
        skipDedup: true,
      }),
    );
  });

  it("defaults ingest concurrency to 10", () => {
    const program = new Command();
    registerIngestCommand(program);

    const ingestCommand = program.commands.find((command) => command.name() === "ingest");
    if (!ingestCommand) {
      throw new Error("Ingest command was not registered.");
    }

    ingestCommand.parseOptions(["/tmp/session.jsonl"]);

    expect(ingestCommand.opts()).toEqual(
      expect.objectContaining({
        concurrency: 10,
      }),
    );
  });

  it("injects the banner into ingest help output", () => {
    const program = createProgram();
    const ingestCommand = program.commands.find((command) => command.name() === "ingest");

    if (!ingestCommand) {
      throw new Error("Ingest command was not registered.");
    }

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
});

describe("pluralize", () => {
  it('returns "entries" for zero entries', () => {
    expect(pluralize(0, "entry", "entries")).toBe("entries");
  });

  it('returns "entry" for one entry', () => {
    expect(pluralize(1, "entry", "entries")).toBe("entry");
  });

  it('returns "entries" for multiple entries', () => {
    expect(pluralize(2, "entry", "entries")).toBe("entries");
  });

  it("falls back to appending s for regular plurals", () => {
    expect(pluralize(2, "file")).toBe("files");
  });
});

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
