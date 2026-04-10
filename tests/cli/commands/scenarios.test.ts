import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { ClaimKeyScenarioConfigurationError, type ClaimKeyScenarioSummary } from "../../../src/app/scenarios/claim-keys/index.js";
import { registerScenariosCommand } from "../../../src/cli/commands/scenarios.js";
import { createProgram } from "../../../src/cli/main.js";

describe("registerScenariosCommand", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("registers the scenarios command group on the program", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "scenarios")).toBe(true);
  });

  it("parses list filters", () => {
    const program = new Command();
    registerScenariosCommand(program);

    const scenariosCommand = requireScenariosCommand(program);
    const listCommand = requireSubcommand(scenariosCommand, "list");
    const parsed = listCommand.parseOptions(["--kind", "store", "--tag", "trusted", "--tag", "manual", "--json"]);

    expect(parsed.operands).toEqual([]);
    expect(listCommand.opts()).toEqual(
      expect.objectContaining({
        kind: "store",
        tag: ["trusted", "manual"],
        json: true,
      }),
    );
  });

  it("parses run filters and preserve flags", () => {
    const program = new Command();
    registerScenariosCommand(program);

    const scenariosCommand = requireScenariosCommand(program);
    const runCommand = requireSubcommand(scenariosCommand, "run");
    const parsed = runCommand.parseOptions([
      "--id",
      "claim-keys.store.manual-key-trusted",
      "--id",
      "claim-keys.surgeon.malformed-key-normalized",
      "--kind",
      "store",
      "--tag",
      "trusted",
      "--preserve-on-failure",
      "--preserve",
      "--verbose",
      "--json",
      "--fail-fast",
    ]);

    expect(parsed.operands).toEqual([]);
    expect(runCommand.opts()).toEqual(
      expect.objectContaining({
        id: ["claim-keys.store.manual-key-trusted", "claim-keys.surgeon.malformed-key-normalized"],
        kind: "store",
        tag: ["trusted"],
        preserveOnFailure: true,
        preserve: true,
        verbose: true,
        json: true,
        failFast: true,
      }),
    );
  });

  it("renders list output through dependency overrides", async () => {
    const program = new Command();
    const stdout = createOutputCapture();

    registerScenariosCommand(program, {
      stdout,
      listScenarios: async () => [
        {
          id: "claim-keys.store.manual-key-trusted",
          kind: "store",
          filePath: "/tmp/manual-key-trusted.json",
          description: "Manual claim key stays trusted.",
          tags: ["store", "trusted"],
          input: {
            entries: [],
          },
          expect: {},
        },
      ],
    });

    await program.parseAsync(["scenarios", "list"], { from: "user" });

    expect(stdout.output).toContain("claim-keys.store.manual-key-trusted [store]");
    expect(stdout.output).toContain("/tmp/manual-key-trusted.json");
  });

  it("renders JSON list output through dependency overrides", async () => {
    const program = new Command();
    const stdout = createOutputCapture();

    registerScenariosCommand(program, {
      stdout,
      listScenarios: async () => [
        {
          id: "claim-keys.store.manual-key-trusted",
          kind: "store",
          filePath: "/tmp/manual-key-trusted.json",
          description: "Manual claim key stays trusted.",
          tags: ["store", "trusted"],
          input: {
            entries: [],
          },
          expect: {},
        },
      ],
    });

    await program.parseAsync(["scenarios", "list", "--json"], { from: "user" });

    expect(JSON.parse(stdout.output)).toEqual([
      expect.objectContaining({
        id: "claim-keys.store.manual-key-trusted",
        kind: "store",
      }),
    ]);
  });

  it("sets exit code 1 when the run summary includes failures", async () => {
    const program = new Command();
    const stdout = createOutputCapture();

    registerScenariosCommand(program, {
      stdout,
      runScenarios: async (): Promise<ClaimKeyScenarioSummary> => ({
        runId: "run-1",
        matchedCount: 1,
        passedCount: 0,
        failedCount: 1,
        artifactRoot: "/tmp/artifacts",
        results: [
          {
            scenarioId: "claim-keys.store.manual-key-trusted",
            kind: "store",
            filePath: "/tmp/manual-key-trusted.json",
            status: "failed",
            durationMs: 10,
            assertionResults: [],
            warnings: [],
            diffSummary: ["Expected claim key mismatch."],
          },
        ],
      }),
    });

    await program.parseAsync(["scenarios", "run"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(stdout.output).toContain("FAIL  claim-keys.store.manual-key-trusted");
  });

  it("renders JSON run output and forwards fail-fast", async () => {
    const program = new Command();
    const stdout = createOutputCapture();
    let capturedOptions: unknown;

    registerScenariosCommand(program, {
      stdout,
      runScenarios: async (options): Promise<ClaimKeyScenarioSummary> => {
        capturedOptions = options;
        return {
          runId: "run-1",
          matchedCount: 1,
          passedCount: 1,
          failedCount: 0,
          artifactRoot: "/tmp/artifacts",
          results: [
            {
              scenarioId: "claim-keys.store.manual-key-trusted",
              kind: "store",
              filePath: "/tmp/manual-key-trusted.json",
              status: "passed",
              durationMs: 10,
              assertionResults: [],
              warnings: [],
              diffSummary: [],
            },
          ],
        };
      },
    });

    await program.parseAsync(["scenarios", "run", "--id", "claim-keys.store.manual-key-trusted", "--fail-fast", "--json"], { from: "user" });

    expect(capturedOptions).toEqual(
      expect.objectContaining({
        ids: ["claim-keys.store.manual-key-trusted"],
        failFast: true,
      }),
    );
    expect(JSON.parse(stdout.output)).toEqual(
      expect.objectContaining({
        matchedCount: 1,
        passedCount: 1,
        failedCount: 0,
      }),
    );
  });

  it("normalizes repeated ids and tags before invoking the runtime", async () => {
    const program = new Command();
    const stdout = createOutputCapture();
    let capturedOptions: unknown;

    registerScenariosCommand(program, {
      stdout,
      runScenarios: async (options): Promise<ClaimKeyScenarioSummary> => {
        capturedOptions = options;
        return {
          runId: "run-1",
          matchedCount: 1,
          passedCount: 1,
          failedCount: 0,
          artifactRoot: "/tmp/artifacts",
          results: [
            {
              scenarioId: "claim-keys.store.manual-key-trusted",
              kind: "store",
              filePath: "/tmp/manual-key-trusted.json",
              status: "passed",
              durationMs: 10,
              assertionResults: [],
              warnings: [],
              diffSummary: [],
            },
          ],
        };
      },
    });

    await program.parseAsync(
      [
        "scenarios",
        "run",
        "--id",
        " claim-keys.store.manual-key-trusted ",
        "--id",
        "claim-keys.store.manual-key-trusted",
        "--tag",
        " trusted ",
        "--tag",
        "trusted",
      ],
      { from: "user" },
    );

    expect(capturedOptions).toEqual(
      expect.objectContaining({
        ids: ["claim-keys.store.manual-key-trusted"],
        tags: ["trusted"],
      }),
    );
  });

  it("sets exit code 2 on configuration failures", async () => {
    const program = new Command();
    const stderr = createOutputCapture();

    registerScenariosCommand(program, {
      stderr,
      runScenarios: async () => {
        throw new ClaimKeyScenarioConfigurationError("invalid scenario");
      },
    });

    await program.parseAsync(["scenarios", "run"], { from: "user" });

    expect(process.exitCode).toBe(2);
    expect(stderr.output).toContain("invalid scenario");
  });
});

function requireScenariosCommand(program: Command): Command {
  const scenariosCommand = program.commands.find((command) => command.name() === "scenarios");
  if (!scenariosCommand) {
    throw new Error("Scenarios command was not registered.");
  }

  return scenariosCommand;
}

function requireSubcommand(program: Command, name: "list" | "run"): Command {
  const subcommand = program.commands.find((command) => command.name() === name);
  if (!subcommand) {
    throw new Error(`Scenarios ${name} subcommand was not registered.`);
  }

  return subcommand;
}

function createOutputCapture(): { output: string; write(text: string): boolean } {
  return {
    output: "",
    write(text: string): boolean {
      this.output += text;
      return true;
    },
  };
}
