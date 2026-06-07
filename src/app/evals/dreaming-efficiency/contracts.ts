import type { DreamEfficiencySummary } from "../../../core/dreaming/types.js";
import type { EvalDreamRunFixture } from "../dream-run-fixture.js";
import type { RecallEvalFixtureDurable, RecallEvalSandboxRequest, RecallEvalSandboxResult } from "../recall/contracts.js";

/** Pre-baked dreaming run completion summary fixture for Option A evals. */
export type DreamingEfficiencyDreamRunFixture = EvalDreamRunFixture;

/** Optional response-shaping flags for dreaming-efficiency eval cases. */
export interface DreamingEfficiencyEvalCaseOptions {
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
}

/** Application-layer request contract for one dreaming-efficiency eval case. */
export interface DreamingEfficiencyEvalCaseRequest {
  caseId: string;
  description?: string;
  sandbox?: RecallEvalSandboxRequest;
  memoryPool: RecallEvalFixtureDurable[];
  dreamRunFixture: DreamingEfficiencyDreamRunFixture;
  options?: DreamingEfficiencyEvalCaseOptions;
}

/** Timing metadata emitted by the dreaming-efficiency eval seam. */
export interface DreamingEfficiencyEvalCaseTimings {
  totalMs?: number;
  sandboxSetupMs?: number;
  fixtureProvisionMs?: number;
}

/** Error payload returned when the dreaming-efficiency eval case fails. */
export interface DreamingEfficiencyEvalCaseError {
  code: "sandbox_setup_failed" | "fixture_provision_failed" | "efficiency_resolution_failed" | "internal_error";
  message: string;
  details?: unknown;
}

/** Stable response envelope returned by the dreaming-efficiency eval seam. */
export interface DreamingEfficiencyEvalCaseResponse {
  status: "ok" | "error";
  caseId: string;
  efficiency?: DreamEfficiencySummary;
  profileInjectionTokenEstimate?: number;
  storeOnlyEquivalentTokenEstimate?: number;
  timings?: DreamingEfficiencyEvalCaseTimings;
  sandbox?: RecallEvalSandboxResult;
  error?: DreamingEfficiencyEvalCaseError;
}
