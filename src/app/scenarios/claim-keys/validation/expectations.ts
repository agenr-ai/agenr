import { requireClaimKeySource, requireClaimKeyStatus, requireClaimSupportMode } from "../../../../core/claim-key-lifecycle.js";
import type {
  ClaimKeyScenarioExpectations,
  ClaimKeyScenarioProposalAssert,
  ClaimKeyScenarioProposalMatch,
  ClaimKeyScenarioRowAssert,
  ClaimKeyScenarioRowMatch,
  ClaimKeyScenarioWarningExpectation,
} from "../types.js";
import {
  readNullableNumber,
  readNullableString,
  readObject,
  readOptionalClaimKeyQualitySummary,
  readProposalScope,
  readOptionalSurgeonRunStatus,
  readOptionalStringArray,
  readRequiredBoolean,
  readRequiredInteger,
  readRequiredString,
} from "./shared.js";

const EXPECTATION_KEYS = new Set(["warnings", "rows", "rowCount", "proposals", "storeResult", "surgeonSummary"]);
const WARNING_KEYS = new Set(["contains", "absent"]);
const ROW_EXPECTATION_KEYS = new Set(["match", "assert"]);
const ROW_MATCH_KEYS = new Set(["id", "subject", "content", "claim_key"]);
const ROW_ASSERT_KEYS = new Set([
  "claim_key",
  "claim_key_raw",
  "claim_key_status",
  "claim_key_source",
  "claim_key_confidence",
  "claim_key_rationale",
  "claim_support_source_kind",
  "claim_support_locator",
  "claim_support_observed_at",
  "claim_support_mode",
  "superseded_by",
  "retired",
  "retired_reason",
  "subject",
  "content",
]);
const PROPOSAL_EXPECTATION_KEYS = new Set(["match", "assert"]);
const PROPOSAL_MATCH_KEYS = new Set(["id", "groupId", "issueKind", "source"]);
const PROPOSAL_ASSERT_KEYS = new Set(["issueKind", "scope", "source", "eligibleForApply", "confidence"]);
const ROW_COUNT_KEYS = new Set(["entries", "activeEntries", "entriesWithClaimKey", "proposals"]);
const STORE_RESULT_KEYS = new Set(["stored", "skipped", "rejected"]);
const SURGEON_SUMMARY_KEYS = new Set(["status", "summary"]);

/**
 * Reads one expectation block and rejects unsupported fields.
 *
 * @param value - Raw expectation payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated expectation block.
 */
export function readExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations {
  const record = readObject(value, "Scenario expect", filePath, EXPECTATION_KEYS);
  const warnings = readWarningExpectation(record.warnings, filePath);
  const rows = readRowExpectations(record.rows, filePath);
  const rowCount = readRowCountExpectation(record.rowCount, filePath);
  const proposals = readProposalExpectations(record.proposals, filePath);
  const storeResult = readStoreResultExpectation(record.storeResult, filePath);
  const surgeonSummary = readSurgeonSummaryExpectation(record.surgeonSummary, filePath);

  return {
    ...(warnings ? { warnings } : {}),
    ...(rows ? { rows } : {}),
    ...(rowCount ? { rowCount } : {}),
    ...(proposals ? { proposals } : {}),
    ...(storeResult !== undefined ? { storeResult } : {}),
    ...(surgeonSummary !== undefined ? { surgeonSummary } : {}),
  };
}

/**
 * Reads one optional warning-expectation block.
 *
 * @param value - Raw warnings payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated warning expectation when present.
 */
function readWarningExpectation(value: unknown, filePath: string): ClaimKeyScenarioWarningExpectation | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario expect.warnings", filePath, WARNING_KEYS);
  const contains = readOptionalStringArray(record.contains, "expect.warnings.contains", filePath);
  const absent = readOptionalStringArray(record.absent, "expect.warnings.absent", filePath);

  return {
    ...(contains ? { contains } : {}),
    ...(absent ? { absent } : {}),
  };
}

/**
 * Reads entry-row expectations.
 *
 * @param value - Raw row-expectation payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated row expectations when present.
 */
function readRowExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations["rows"] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: expect.rows must be an array.`);
  }

  return value.map((row, index) => {
    const record = readObject(row, `expect.rows[${index}]`, filePath, ROW_EXPECTATION_KEYS);
    return {
      match: readRowMatch(record.match, `${filePath} expect.rows[${index}]`),
      assert: readRowAssert(record.assert, `${filePath} expect.rows[${index}]`),
    };
  });
}

/**
 * Reads surgeon-proposal expectations.
 *
 * @param value - Raw proposal-expectation payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated proposal expectations when present.
 */
function readProposalExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations["proposals"] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: expect.proposals must be an array.`);
  }

  return value.map((proposal, index) => {
    const record = readObject(proposal, `expect.proposals[${index}]`, filePath, PROPOSAL_EXPECTATION_KEYS);
    return {
      match: readProposalMatch(record.match, `${filePath} expect.proposals[${index}]`),
      assert: readProposalAssert(record.assert, `${filePath} expect.proposals[${index}]`),
    };
  });
}

/**
 * Reads row-count expectations.
 *
 * @param value - Raw row-count payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated row-count expectations when present.
 */
function readRowCountExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["rowCount"] {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario expect.rowCount", filePath, ROW_COUNT_KEYS);

  return {
    ...(record.entries !== undefined ? { entries: readRequiredInteger(record.entries, "expect.rowCount.entries", filePath) } : {}),
    ...(record.activeEntries !== undefined ? { activeEntries: readRequiredInteger(record.activeEntries, "expect.rowCount.activeEntries", filePath) } : {}),
    ...(record.entriesWithClaimKey !== undefined
      ? { entriesWithClaimKey: readRequiredInteger(record.entriesWithClaimKey, "expect.rowCount.entriesWithClaimKey", filePath) }
      : {}),
    ...(record.proposals !== undefined ? { proposals: readRequiredInteger(record.proposals, "expect.rowCount.proposals", filePath) } : {}),
  };
}

/**
 * Reads store-result expectations.
 *
 * @param value - Raw store-result payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Partial store-result expectation, null, or undefined.
 */
function readStoreResultExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["storeResult"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const record = readObject(value, "Scenario expect.storeResult", filePath, STORE_RESULT_KEYS);
  return {
    ...(record.stored !== undefined ? { stored: readRequiredInteger(record.stored, "expect.storeResult.stored", filePath) } : {}),
    ...(record.skipped !== undefined ? { skipped: readRequiredInteger(record.skipped, "expect.storeResult.skipped", filePath) } : {}),
    ...(record.rejected !== undefined ? { rejected: readRequiredInteger(record.rejected, "expect.storeResult.rejected", filePath) } : {}),
  };
}

/**
 * Reads surgeon-summary expectations.
 *
 * @param value - Raw surgeon-summary payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Surgeon-summary expectation, null, or undefined.
 */
function readSurgeonSummaryExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["surgeonSummary"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const record = readObject(value, "Scenario expect.surgeonSummary", filePath, SURGEON_SUMMARY_KEYS);

  return {
    ...(record.status !== undefined ? { status: readOptionalSurgeonRunStatus(record.status, "expect.surgeonSummary.status", filePath) } : {}),
    ...(record.summary !== undefined ? { summary: readOptionalClaimKeyQualitySummary(record.summary, "expect.surgeonSummary.summary", filePath) } : {}),
  };
}

/**
 * Reads one row-match block and ensures at least one key is present.
 *
 * @param value - Raw row-match payload.
 * @param label - Human-readable validation label.
 * @returns Validated row match.
 */
function readRowMatch(value: unknown, label: string): ClaimKeyScenarioRowMatch {
  const record = readObject(value, `${label} match`, label, ROW_MATCH_KEYS);
  const match: ClaimKeyScenarioRowMatch = {
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.match.id`, label) } : {}),
    ...(record.subject !== undefined ? { subject: readRequiredString(record.subject, `${label}.match.subject`, label) } : {}),
    ...(record.content !== undefined ? { content: readRequiredString(record.content, `${label}.match.content`, label) } : {}),
    ...(record.claim_key !== undefined ? { claim_key: readRequiredString(record.claim_key, `${label}.match.claim_key`, label) } : {}),
  };

  if (Object.keys(match).length === 0) {
    throw new Error(`Invalid scenario ${label}: row match must define at least one key.`);
  }

  return match;
}

/**
 * Reads one row-assert block.
 *
 * @param value - Raw row-assert payload.
 * @param label - Human-readable validation label.
 * @returns Validated row assertions.
 */
function readRowAssert(value: unknown, label: string): ClaimKeyScenarioRowAssert {
  const record = readObject(value, `${label} assert`, label, ROW_ASSERT_KEYS);
  return {
    ...(record.claim_key !== undefined ? { claim_key: readNullableString(record.claim_key, `${label}.assert.claim_key`, label) } : {}),
    ...(record.claim_key_raw !== undefined ? { claim_key_raw: readNullableString(record.claim_key_raw, `${label}.assert.claim_key_raw`, label) } : {}),
    ...(record.claim_key_status !== undefined
      ? { claim_key_status: readNullableClaimKeyStatus(record.claim_key_status, `${label}.assert.claim_key_status`, label) }
      : {}),
    ...(record.claim_key_source !== undefined
      ? { claim_key_source: readNullableClaimKeySource(record.claim_key_source, `${label}.assert.claim_key_source`, label) }
      : {}),
    ...(record.claim_key_confidence !== undefined
      ? { claim_key_confidence: readNullableNumber(record.claim_key_confidence, `${label}.assert.claim_key_confidence`, label) }
      : {}),
    ...(record.claim_key_rationale !== undefined
      ? { claim_key_rationale: readNullableString(record.claim_key_rationale, `${label}.assert.claim_key_rationale`, label) }
      : {}),
    ...(record.claim_support_source_kind !== undefined
      ? { claim_support_source_kind: readNullableString(record.claim_support_source_kind, `${label}.assert.claim_support_source_kind`, label) }
      : {}),
    ...(record.claim_support_locator !== undefined
      ? { claim_support_locator: readNullableString(record.claim_support_locator, `${label}.assert.claim_support_locator`, label) }
      : {}),
    ...(record.claim_support_observed_at !== undefined
      ? { claim_support_observed_at: readNullableString(record.claim_support_observed_at, `${label}.assert.claim_support_observed_at`, label) }
      : {}),
    ...(record.claim_support_mode !== undefined
      ? { claim_support_mode: readNullableClaimSupportMode(record.claim_support_mode, `${label}.assert.claim_support_mode`, label) }
      : {}),
    ...(record.superseded_by !== undefined ? { superseded_by: readNullableString(record.superseded_by, `${label}.assert.superseded_by`, label) } : {}),
    ...(record.retired !== undefined ? { retired: readRequiredBoolean(record.retired, `${label}.assert.retired`, label) } : {}),
    ...(record.retired_reason !== undefined ? { retired_reason: readNullableString(record.retired_reason, `${label}.assert.retired_reason`, label) } : {}),
    ...(record.subject !== undefined ? { subject: readRequiredString(record.subject, `${label}.assert.subject`, label) } : {}),
    ...(record.content !== undefined ? { content: readRequiredString(record.content, `${label}.assert.content`, label) } : {}),
  };
}

/**
 * Reads one proposal-match block and ensures at least one key is present.
 *
 * @param value - Raw proposal-match payload.
 * @param label - Human-readable validation label.
 * @returns Validated proposal match.
 */
function readProposalMatch(value: unknown, label: string): ClaimKeyScenarioProposalMatch {
  const record = readObject(value, `${label} match`, label, PROPOSAL_MATCH_KEYS);
  const match: ClaimKeyScenarioProposalMatch = {
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.match.id`, label) } : {}),
    ...(record.groupId !== undefined ? { groupId: readRequiredString(record.groupId, `${label}.match.groupId`, label) } : {}),
    ...(record.issueKind !== undefined ? { issueKind: readRequiredString(record.issueKind, `${label}.match.issueKind`, label) } : {}),
    ...(record.source !== undefined ? { source: readRequiredString(record.source, `${label}.match.source`, label) } : {}),
  };

  if (Object.keys(match).length === 0) {
    throw new Error(`Invalid scenario ${label}: proposal match must define at least one key.`);
  }

  return match;
}

/**
 * Reads one proposal-assert block.
 *
 * @param value - Raw proposal-assert payload.
 * @param label - Human-readable validation label.
 * @returns Validated proposal assertions.
 */
function readProposalAssert(value: unknown, label: string): ClaimKeyScenarioProposalAssert {
  const record = readObject(value, `${label} assert`, label, PROPOSAL_ASSERT_KEYS);
  return {
    ...(record.issueKind !== undefined ? { issueKind: readRequiredString(record.issueKind, `${label}.assert.issueKind`, label) } : {}),
    ...(record.scope !== undefined ? { scope: readProposalScope(record.scope, `${label}.assert.scope`, label) } : {}),
    ...(record.source !== undefined ? { source: readRequiredString(record.source, `${label}.assert.source`, label) } : {}),
    ...(record.eligibleForApply !== undefined
      ? { eligibleForApply: readRequiredBoolean(record.eligibleForApply, `${label}.assert.eligibleForApply`, label) }
      : {}),
    ...(record.confidence !== undefined ? { confidence: readNullableNumber(record.confidence, `${label}.assert.confidence`, label) } : {}),
  };
}

/**
 * Reads one nullable claim-key status used by equality assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed status or null.
 */
function readNullableClaimKeyStatus(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimKeyStatus(value, `${filePath}: ${label}`);
}

/**
 * Reads one nullable claim-key source used by equality assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed source or null.
 */
function readNullableClaimKeySource(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimKeySource(value, `${filePath}: ${label}`);
}

/**
 * Reads one nullable claim-support mode used by equality assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed support mode or null.
 */
function readNullableClaimSupportMode(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimSupportMode(value, `${filePath}: ${label}`);
}
