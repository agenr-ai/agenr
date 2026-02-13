import { describe, expect, test } from "vitest";

import { analyzeTypecheckOutputForAdapter, shouldAcceptTypecheckResult, type TypecheckResult } from "../../src/cli/generator";

const PROJECT_ROOT = "/repo";
const ADAPTER_PATH = "/repo/data/adapters/sandbox/owner/toast.ts";

function createTypecheckResult(overrides: Partial<TypecheckResult>): TypecheckResult {
  return {
    ok: false,
    exitCode: 2,
    output: "",
    rawOutput: "",
    filteredOutput: "",
    hasTypeScriptDiagnostics: false,
    hasAdapterDiagnostics: false,
    ...overrides,
  };
}

describe("generator typecheck gating", () => {
  test("fails when generated adapter has TypeScript diagnostics", () => {
    const output = [
      "data/adapters/sandbox/owner/toast.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 1 error in data/adapters/sandbox/owner/toast.ts:14",
    ].join("\n");

    const analysis = analyzeTypecheckOutputForAdapter(output, PROJECT_ROOT, ADAPTER_PATH);
    expect(analysis.hasTypeScriptDiagnostics).toBe(true);
    expect(analysis.hasAdapterDiagnostics).toBe(true);
    expect(analysis.filteredOutput).toContain("TS2322");

    const shouldPass = shouldAcceptTypecheckResult(
      createTypecheckResult({
        ...analysis,
        output: analysis.filteredOutput,
      }),
    );
    expect(shouldPass).toBe(false);
  });

  test("passes when only unrelated TypeScript diagnostics exist", () => {
    const output = "src/index.ts(2,1): error TS2304: Cannot find name 'missingSymbol'.";
    const analysis = analyzeTypecheckOutputForAdapter(output, PROJECT_ROOT, ADAPTER_PATH);

    expect(analysis.hasTypeScriptDiagnostics).toBe(true);
    expect(analysis.hasAdapterDiagnostics).toBe(false);
    expect(analysis.filteredOutput).toContain("no errors were reported in generated adapter");
    expect(analysis.filteredOutput).toContain("data/adapters/sandbox/owner/toast.ts");

    const shouldPass = shouldAcceptTypecheckResult(
      createTypecheckResult({
        ...analysis,
        output: analysis.filteredOutput,
      }),
    );
    expect(shouldPass).toBe(true);
  });

  test("passes when TypeScript emits global diagnostics with no file path", () => {
    const output = "error TS2688: Cannot find type definition file for 'bun'.";
    const analysis = analyzeTypecheckOutputForAdapter(output, PROJECT_ROOT, ADAPTER_PATH);

    expect(analysis.hasTypeScriptDiagnostics).toBe(true);
    expect(analysis.hasAdapterDiagnostics).toBe(false);

    const shouldPass = shouldAcceptTypecheckResult(
      createTypecheckResult({
        ...analysis,
        output: analysis.filteredOutput,
      }),
    );
    expect(shouldPass).toBe(true);
  });

  test("fails when non-TypeScript toolchain errors occur", () => {
    const output = 'error: script "typecheck" exited with code 127';
    const analysis = analyzeTypecheckOutputForAdapter(output, PROJECT_ROOT, ADAPTER_PATH);

    expect(analysis.hasTypeScriptDiagnostics).toBe(false);
    expect(analysis.hasAdapterDiagnostics).toBe(false);
    expect(analysis.filteredOutput).toBe(output);

    const shouldPass = shouldAcceptTypecheckResult(
      createTypecheckResult({
        ...analysis,
        output: analysis.filteredOutput,
      }),
    );
    expect(shouldPass).toBe(false);
  });

  test("passes on clean exit code even when output is empty", () => {
    const analysis = analyzeTypecheckOutputForAdapter("", PROJECT_ROOT, ADAPTER_PATH);
    const shouldPass = shouldAcceptTypecheckResult(
      createTypecheckResult({
        ok: true,
        exitCode: 0,
        ...analysis,
      }),
    );

    expect(shouldPass).toBe(true);
  });
});
