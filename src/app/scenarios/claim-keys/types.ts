import type { ReconcilePassSummary, DreamRunProposal, DreamRunStatus } from "../../../core/dreaming/types.js";
import type { Durable, StoreDurableInput, StoreResult } from "../../../core/types.js";
import type { DeepPartial } from "./validation/shared.js";

/**
 * Supported claim-key scenario kinds.
 */
export type ClaimKeyScenarioKind = "ingest" | "store" | "dreaming";

/**
 * Optional sandbox controls for one scenario file.
 */
export interface ClaimKeyScenarioSandboxConfig {
  reset?: boolean;
  preserveOnFailure?: boolean;
  preserveAlways?: boolean;
  name?: string;
}

/**
 * Seed entry shape accepted by scenario setup.
 */
export interface ClaimKeyScenarioSeedEntry extends Partial<
  Pick<
    Durable,
    | "id"
    | "type"
    | "subject"
    | "content"
    | "importance"
    | "expiry"
    | "tags"
    | "source_file"
    | "source_context"
    | "claim_key"
    | "claim_key_raw"
    | "claim_key_status"
    | "claim_key_source"
    | "claim_key_confidence"
    | "claim_key_rationale"
    | "claim_support_source_kind"
    | "claim_support_locator"
    | "claim_support_observed_at"
    | "claim_support_mode"
    | "superseded_by"
    | "valid_from"
    | "valid_to"
    | "supersession_kind"
    | "supersession_reason"
    | "user_id"
    | "project"
    | "created_at"
    | "updated_at"
  >
> {
  type: Durable["type"];
  subject: Durable["subject"];
  content: Durable["content"];
}

/**
 * Scenario setup fields applied before the main flow runs.
 */
export interface ClaimKeyScenarioSetup {
  seedEntries?: ClaimKeyScenarioSeedEntry[];
  seedFixtureFile?: string;
  preRunDreaming?: unknown;
}

/**
 * Optional model-fixture files used for deterministic scenario execution.
 */
export interface ClaimKeyScenarioModelFixtures {
  extractionResponsesFile?: string;
  claimExtractionResponsesFile?: string;
}

/**
 * Narrow ingest options supported by the scenario runner.
 */
export interface ClaimKeyScenarioIngestOptions {
  verbose?: boolean;
  surface?: string;
  project?: string;
}

/**
 * Ingest scenario input payload.
 */
export interface ClaimKeyIngestScenarioInput {
  transcriptFile: string;
  ingestOptions?: ClaimKeyScenarioIngestOptions;
  modelFixtures?: ClaimKeyScenarioModelFixtures;
}

/**
 * Narrow store options supported by the scenario runner.
 */
export interface ClaimKeyScenarioStoreOptions {
  claimExtraction?: boolean;
  verbose?: boolean;
}

/**
 * Store scenario input payload.
 */
export interface ClaimKeyStoreScenarioInput {
  entries: StoreDurableInput[];
  storeOptions?: ClaimKeyScenarioStoreOptions;
  modelFixtures?: ClaimKeyScenarioModelFixtures;
}

/**
 * Narrow dreaming options supported by the scenario runner.
 */
export interface ClaimKeyScenarioDreamingOptions {
  apply?: boolean;
  verbose?: boolean;
  project?: string | null;
  durableIds?: string[];
  claimKeyPrefix?: string;
  type?: string;
  includeInactive?: boolean;
}

/**
 * Dreaming scenario input payload.
 */
export interface ClaimKeyDreamingScenarioInput {
  pass: "claim_key_quality";
  dreamingOptions?: ClaimKeyScenarioDreamingOptions;
  modelFixtures?: ClaimKeyScenarioModelFixtures;
}

/**
 * Row match predicate used for entry assertions.
 */
export interface ClaimKeyScenarioRowMatch {
  id?: string;
  subject?: string;
  content?: string;
  claim_key?: string;
}

/**
 * Equality-only entry assertions used in v1 scenarios.
 */
export interface ClaimKeyScenarioRowAssert {
  claim_key?: string | null;
  claim_key_raw?: string | null;
  claim_key_status?: string | null;
  claim_key_source?: string | null;
  claim_key_confidence?: number | null;
  claim_key_rationale?: string | null;
  claim_support_source_kind?: string | null;
  claim_support_locator?: string | null;
  claim_support_observed_at?: string | null;
  claim_support_mode?: string | null;
  superseded_by?: string | null;
  valid_to?: string | null;
  supersession_reason?: string | null;
  subject?: string;
  content?: string;
}

/**
 * One entry-row assertion block.
 */
export interface ClaimKeyScenarioRowExpectation {
  match: ClaimKeyScenarioRowMatch;
  assert: ClaimKeyScenarioRowAssert;
}

/**
 * Proposal match predicate used for dreaming proposal assertions.
 */
export interface ClaimKeyScenarioProposalMatch {
  id?: string;
  groupId?: string;
  issueKind?: string;
  source?: string;
}

/**
 * Equality-only dreaming proposal assertions used in v1 scenarios.
 */
export interface ClaimKeyScenarioProposalAssert {
  issueKind?: string;
  scope?: DreamRunProposal["scope"];
  source?: string;
  eligibleForApply?: boolean;
  confidence?: number | null;
}

/**
 * One proposal assertion block.
 */
export interface ClaimKeyScenarioProposalExpectation {
  match: ClaimKeyScenarioProposalMatch;
  assert: ClaimKeyScenarioProposalAssert;
}

/**
 * Warning substring expectations for one scenario.
 */
export interface ClaimKeyScenarioWarningExpectation {
  contains?: string[];
  absent?: string[];
}

/**
 * Row-count expectations supported in v1.
 */
export interface ClaimKeyScenarioRowCountExpectation {
  durables?: number;
  activeDurables?: number;
  entriesWithClaimKey?: number;
  proposals?: number;
}

/**
 * Dreaming summary assertion shape supported by the runner.
 */
export interface ClaimKeyScenarioDreamingSummaryExpectation {
  status?: DreamRunStatus;
  summary?: DeepPartial<ReconcilePassSummary> | null;
}

/**
 * Observable expectations for one scenario.
 */
export interface ClaimKeyScenarioExpectations {
  warnings?: ClaimKeyScenarioWarningExpectation;
  rows?: ClaimKeyScenarioRowExpectation[];
  rowCount?: ClaimKeyScenarioRowCountExpectation;
  proposals?: ClaimKeyScenarioProposalExpectation[];
  storeResult?: Partial<StoreResult> | null;
  dreamingSummary?: ClaimKeyScenarioDreamingSummaryExpectation | null;
}

/**
 * Canonical loaded claim-key scenario file.
 */
export type ClaimKeyScenario =
  | {
      id: string;
      kind: "ingest";
      input: ClaimKeyIngestScenarioInput;
      expect: ClaimKeyScenarioExpectations;
      filePath: string;
      description?: string;
      tags?: string[];
      sandbox?: ClaimKeyScenarioSandboxConfig;
      setup?: ClaimKeyScenarioSetup;
      notes?: string | string[];
    }
  | {
      id: string;
      kind: "store";
      input: ClaimKeyStoreScenarioInput;
      expect: ClaimKeyScenarioExpectations;
      filePath: string;
      description?: string;
      tags?: string[];
      sandbox?: ClaimKeyScenarioSandboxConfig;
      setup?: ClaimKeyScenarioSetup;
      notes?: string | string[];
    }
  | {
      id: string;
      kind: "dreaming";
      input: ClaimKeyDreamingScenarioInput;
      expect: ClaimKeyScenarioExpectations;
      filePath: string;
      description?: string;
      tags?: string[];
      sandbox?: ClaimKeyScenarioSandboxConfig;
      setup?: ClaimKeyScenarioSetup;
      notes?: string | string[];
    };

/**
 * Filter and execution options accepted by the scenario runtime.
 */
export interface ClaimKeyScenarioRunOptions {
  rootDir?: string;
  ids?: string[];
  kind?: ClaimKeyScenarioKind;
  tags?: string[];
  preserveOnFailure?: boolean;
  preserveAlways?: boolean;
  failFast?: boolean;
  verbose?: boolean;
}

/**
 * One assertion result emitted for artifact writing and debug output.
 */
export interface ClaimKeyScenarioAssertionResult {
  label: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

/**
 * Aggregated row counts captured after one scenario run.
 */
export interface ClaimKeyScenarioRowCounts {
  durables: number;
  activeDurables: number;
  entriesWithClaimKey: number;
  proposals: number;
}

/**
 * Structured proposal snapshot used by artifacts and assertions.
 */
export interface ClaimKeyScenarioProposalSnapshot {
  id: string;
  runId: string;
  groupId: string;
  issueKind: string;
  scope: DreamRunProposal["scope"];
  durableIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  createdAt: string;
}

/**
 * Structured dreaming summary snapshot used by artifacts and assertions.
 */
export interface ClaimKeyScenarioDreamingSummarySnapshot {
  runId: string;
  status: DreamRunStatus;
  passType: string;
  summary: ReconcilePassSummary | null;
}

/**
 * Actual observable state captured from one scenario sandbox.
 */
export interface ClaimKeyScenarioActualState {
  warnings: string[];
  rows: Durable[];
  rowCount: ClaimKeyScenarioRowCounts;
  proposals: ClaimKeyScenarioProposalSnapshot[];
  storeResult: StoreResult | null;
  dreamingSummary: ClaimKeyScenarioDreamingSummarySnapshot | null;
  executionError?: string;
}

/**
 * Per-scenario runtime result returned to the CLI.
 */
export interface ClaimKeyScenarioRunResult {
  scenarioId: string;
  kind: ClaimKeyScenarioKind;
  filePath: string;
  status: "passed" | "failed";
  durationMs: number;
  preservedSandboxPath?: string;
  assertionResults: ClaimKeyScenarioAssertionResult[];
  warnings: string[];
  diffSummary: string[];
}

/**
 * Aggregate runtime summary returned after one claim-key scenario run set.
 */
export interface ClaimKeyScenarioSummary {
  runId: string;
  matchedCount: number;
  passedCount: number;
  failedCount: number;
  artifactRoot: string;
  results: ClaimKeyScenarioRunResult[];
}
