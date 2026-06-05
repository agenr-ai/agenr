import type { ReconcilePassSummary } from "../../../core/dreaming/types.js";
import type {
  ClaimKeyScenario,
  ClaimKeyScenarioActualState,
  ClaimKeyScenarioAssertionResult,
  ClaimKeyScenarioProposalMatch,
  ClaimKeyScenarioRowMatch,
} from "./types.js";

/**
 * Builds the full assertion result list for one executed scenario.
 *
 * @param scenario - Scenario definition that declared the expectations.
 * @param actual - Observable runtime state captured from the sandbox.
 * @returns Ordered assertion results used for diffs and final status.
 */
export function buildClaimKeyScenarioAssertions(scenario: ClaimKeyScenario, actual: ClaimKeyScenarioActualState): ClaimKeyScenarioAssertionResult[] {
  const results: ClaimKeyScenarioAssertionResult[] = [];

  if (actual.executionError) {
    results.push({
      label: "execution",
      passed: false,
      actual: actual.executionError,
      message: actual.executionError,
    });
  }

  for (const contains of scenario.expect.warnings?.contains ?? []) {
    const passed = actual.warnings.some((warning) => warning.includes(contains));
    results.push({
      label: `warnings.contains:${contains}`,
      passed,
      expected: contains,
      actual: actual.warnings,
      message: passed ? undefined : `Expected one warning containing "${contains}".`,
    });
  }

  for (const absent of scenario.expect.warnings?.absent ?? []) {
    const passed = !actual.warnings.some((warning) => warning.includes(absent));
    results.push({
      label: `warnings.absent:${absent}`,
      passed,
      expected: absent,
      actual: actual.warnings,
      message: passed ? undefined : `Expected no warning containing "${absent}".`,
    });
  }

  if (scenario.expect.rowCount) {
    for (const [key, expected] of Object.entries(scenario.expect.rowCount)) {
      const actualValue = actual.rowCount[key as keyof typeof actual.rowCount];
      results.push(compareScalar(`rowCount.${key}`, expected, actualValue));
    }
  }

  for (const [index, expectation] of (scenario.expect.rows ?? []).entries()) {
    const matches = actual.rows.filter((row) => rowMatches(row, expectation.match));
    if (matches.length !== 1) {
      results.push({
        label: `rows[${index}].match`,
        passed: false,
        expected: expectation.match,
        actual: matches.map((row) => row.id),
        message: `Expected exactly one row match but found ${matches.length}.`,
      });
      continue;
    }

    const row = matches[0];
    for (const [field, expected] of Object.entries(expectation.assert)) {
      const actualValue = row[field as keyof typeof row];
      results.push(compareScalar(`rows[${index}].${field}`, expected, actualValue));
    }
  }

  for (const [index, expectation] of (scenario.expect.proposals ?? []).entries()) {
    const matches = actual.proposals.filter((proposal) => proposalMatches(proposal, expectation.match));
    if (matches.length !== 1) {
      results.push({
        label: `proposals[${index}].match`,
        passed: false,
        expected: expectation.match,
        actual: matches.map((proposal) => proposal.id),
        message: `Expected exactly one proposal match but found ${matches.length}.`,
      });
      continue;
    }

    const proposal = matches[0];
    for (const [field, expected] of Object.entries(expectation.assert)) {
      const actualValue = proposal[field as keyof typeof proposal];
      results.push(compareScalar(`proposals[${index}].${field}`, expected, actualValue));
    }
  }

  if (scenario.expect.storeResult !== undefined) {
    if (scenario.expect.storeResult === null) {
      results.push(compareScalar("storeResult", null, actual.storeResult));
    } else {
      for (const [field, expected] of Object.entries(scenario.expect.storeResult)) {
        const actualValue = actual.storeResult?.[field as keyof NonNullable<typeof actual.storeResult>] ?? null;
        results.push(compareScalar(`storeResult.${field}`, expected, actualValue));
      }
    }
  }

  if (scenario.expect.dreamingSummary !== undefined) {
    if (scenario.expect.dreamingSummary === null) {
      results.push(compareScalar("dreamingSummary", null, actual.dreamingSummary));
    } else {
      if (scenario.expect.dreamingSummary.status !== undefined) {
        results.push(compareScalar("dreamingSummary.status", scenario.expect.dreamingSummary.status, actual.dreamingSummary?.status ?? null));
      }

      if (scenario.expect.dreamingSummary.summary !== undefined) {
        comparePartialObject("dreamingSummary.summary", scenario.expect.dreamingSummary.summary, actual.dreamingSummary?.summary ?? null, results);
      }
    }
  }

  return results;
}

/**
 * Converts failed assertion results into one concise diff-summary list.
 *
 * @param assertions - Assertion results returned by the runner.
 * @returns Human-readable failure summary lines.
 */
export function summarizeClaimKeyScenarioDiffs(assertions: ClaimKeyScenarioAssertionResult[]): string[] {
  return assertions
    .filter((result) => !result.passed)
    .map((result) => result.message ?? `${result.label} failed.`)
    .slice(0, 20);
}

/**
 * Compares two scalar values using equality-only semantics plus nullish matching.
 *
 * @param label - Assertion label used in artifacts and CLI output.
 * @param expected - Expected scalar value.
 * @param actual - Actual runtime value.
 * @returns One assertion result row.
 */
function compareScalar(label: string, expected: unknown, actual: unknown): ClaimKeyScenarioAssertionResult {
  const passed = scalarMatches(expected, actual);
  return {
    label,
    passed,
    expected,
    actual,
    message: passed ? undefined : `Expected ${label} to equal ${formatValue(expected)} but received ${formatValue(actual)}.`,
  };
}

/**
 * Recursively compares one expected partial object against the actual summary.
 *
 * @param label - Assertion path prefix.
 * @param expected - Expected partial object or array.
 * @param actual - Actual runtime value.
 * @param results - Mutable assertion result sink.
 */
function comparePartialObject(
  label: string,
  expected: Partial<ReconcilePassSummary> | unknown,
  actual: unknown,
  results: ClaimKeyScenarioAssertionResult[],
): void {
  if (expected === null || typeof expected !== "object") {
    results.push(compareScalar(label, expected, actual));
    return;
  }

  if (Array.isArray(expected)) {
    const passed = Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => deepEqual(item, actual[index]));
    results.push({
      label,
      passed,
      expected,
      actual,
      message: passed ? undefined : `Expected ${label} to match ${formatValue(expected)} but received ${formatValue(actual)}.`,
    });
    return;
  }

  if (typeof actual !== "object" || actual === null) {
    results.push({
      label,
      passed: false,
      expected,
      actual,
      message: `Expected ${label} to be an object.`,
    });
    return;
  }

  for (const [key, value] of Object.entries(expected)) {
    comparePartialObject(`${label}.${key}`, value, (actual as Record<string, unknown>)[key], results);
  }
}

/**
 * Checks whether one entry row satisfies the requested match predicate.
 *
 * @param row - Entry row from the sandbox.
 * @param match - Scenario match predicate.
 * @returns True when every declared match key is equal.
 */
function rowMatches(row: ClaimKeyScenarioActualState["rows"][number], match: ClaimKeyScenarioRowMatch): boolean {
  return Object.entries(match).every(([key, expected]) => scalarMatches(expected, row[key as keyof typeof row]));
}

/**
 * Checks whether one proposal row satisfies the requested match predicate.
 *
 * @param proposal - Proposal snapshot from the sandbox.
 * @param match - Scenario match predicate.
 * @returns True when every declared match key is equal.
 */
function proposalMatches(proposal: ClaimKeyScenarioActualState["proposals"][number], match: ClaimKeyScenarioProposalMatch): boolean {
  return Object.entries(match).every(([key, expected]) => scalarMatches(expected, proposal[key as keyof typeof proposal]));
}

/**
 * Compares expected and actual scalar values with nullish tolerance.
 *
 * @param expected - Expected value from the scenario.
 * @param actual - Actual runtime value.
 * @returns True when the scalar values match.
 */
function scalarMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }

  return Object.is(expected, actual);
}

/**
 * Checks whether two arbitrary values are deeply equal.
 *
 * @param left - Left-hand value.
 * @param right - Right-hand value.
 * @returns True when both values are structurally identical.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return scalarMatches(left, right);
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => deepEqual(value, (right as Record<string, unknown>)[key]));
}

/**
 * Formats an arbitrary value for concise assertion messages.
 *
 * @param value - Runtime value to format.
 * @returns Stable JSON-ish string.
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return JSON.stringify(value);
}
