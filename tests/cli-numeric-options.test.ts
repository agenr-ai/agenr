import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parseIntOption } from "../src/cli/option-parsers.js";

describe("CLI numeric option parsing", () => {
  it("parseIntOption parses integers and rejects invalid input", () => {
    expect(parseIntOption("10")).toBe(10);
    expect(() => parseIntOption("nope")).toThrow("Expected an integer");
  });

  it("commander defaults and parsed values are numbers", () => {
    const program = new Command();
    program.option("--limit <n>", "Maximum number of results", parseIntOption, 10);

    program.parse(["node", "test"]);
    expect(program.opts().limit).toBe(10);
    expect(typeof program.opts().limit).toBe("number");

    program.parse(["node", "test", "--limit", "7"]);
    expect(program.opts().limit).toBe(7);
    expect(typeof program.opts().limit).toBe("number");
  });
});

