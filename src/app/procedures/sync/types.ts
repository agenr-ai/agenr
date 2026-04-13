import type { Procedure, ProcedureDefinition } from "../../../core/types.js";

/**
 * Stable prepared procedure payload derived from one authored YAML file.
 */
export interface PreparedProcedureCandidate {
  /** Absolute source file path. */
  filePath: string;
  /** Canonical normalized procedure body. */
  procedure: ProcedureDefinition;
  /** Deterministic flattened recall text. */
  recallText: string;
  /** Stable hash for the normalized procedure body. */
  revisionHash: string;
  /** Stable hash for the exact authored YAML source. */
  sourceHash: string;
}

/**
 * Invalid procedure file discovered during sync planning.
 */
export interface ProcedureSyncInvalidItem {
  /** Planning action for this file. */
  action: "invalid";
  /** Absolute source file path. */
  filePath: string;
  /** Human-readable validation or planning error. */
  error: string;
}

/**
 * Planned create for a procedure key that has no active stored revision.
 */
export interface ProcedureSyncCreateItem {
  /** Planning action for this file. */
  action: "create";
  /** Prepared procedure candidate derived from YAML. */
  candidate: PreparedProcedureCandidate;
}

/**
 * Planned in-place source update for a procedure whose normalized body is unchanged.
 */
export interface ProcedureSyncUpdateSourceOnlyItem {
  /** Planning action for this file. */
  action: "update_source_only";
  /** Prepared procedure candidate derived from YAML. */
  candidate: PreparedProcedureCandidate;
  /** Existing active procedure revision that will be updated in place. */
  existing: Procedure;
}

/**
 * Planned semantic supersession for a procedure whose normalized body changed.
 */
export interface ProcedureSyncSupersedeItem {
  /** Planning action for this file. */
  action: "supersede";
  /** Prepared procedure candidate derived from YAML. */
  candidate: PreparedProcedureCandidate;
  /** Existing active procedure revision that will become historical. */
  existing: Procedure;
}

/**
 * Planned no-op for a procedure file that already matches the active stored revision.
 */
export interface ProcedureSyncUnchangedItem {
  /** Planning action for this file. */
  action: "unchanged";
  /** Prepared procedure candidate derived from YAML. */
  candidate: PreparedProcedureCandidate;
  /** Existing active procedure revision that already matches the candidate. */
  existing: Procedure;
}

/**
 * Per-file sync planning outcome.
 */
export type ProcedureSyncPlanItem =
  | ProcedureSyncInvalidItem
  | ProcedureSyncCreateItem
  | ProcedureSyncUpdateSourceOnlyItem
  | ProcedureSyncSupersedeItem
  | ProcedureSyncUnchangedItem;

/**
 * Aggregate counts summarizing one sync plan.
 */
export interface ProcedureSyncPlanTotals {
  /** Number of discovered files considered by the planner. */
  discovered: number;
  /** Number of files that will create a new active procedure. */
  create: number;
  /** Number of files that will update source metadata in place. */
  updateSourceOnly: number;
  /** Number of files that will supersede an existing active revision. */
  supersede: number;
  /** Number of files that already match the active stored revision. */
  unchanged: number;
  /** Number of invalid files. */
  invalid: number;
}

/**
 * Pure sync plan generated from repo-authored procedure files plus current DB state.
 */
export interface ProcedureSyncPlan {
  /** Original target file or directory supplied by the caller. */
  targetPath: string;
  /** Discovery-order absolute file paths considered by the planner. */
  files: string[];
  /** Per-file planning outcomes in discovery order. */
  items: ProcedureSyncPlanItem[];
  /** Aggregate plan counts. */
  totals: ProcedureSyncPlanTotals;
}

/**
 * Per-file execution outcome after applying one prepared sync plan.
 */
export interface ProcedureSyncExecutionItem {
  /** Absolute source file path. */
  filePath: string;
  /** Stable procedure key when the file parsed successfully. */
  procedureKey?: string;
  /** Canonical stored procedure identifier written or reused by execution. */
  procedureId?: string;
  /** Previous active procedure identifier for supersession results. */
  previousProcedureId?: string;
  /** Final execution action for this file. */
  action: "created" | "updated_source_only" | "superseded" | "unchanged";
}

/**
 * Aggregate counts summarizing one sync execution.
 */
export interface ProcedureSyncExecutionTotals {
  /** Number of newly created active procedures. */
  created: number;
  /** Number of in-place source updates. */
  updatedSourceOnly: number;
  /** Number of semantic supersessions. */
  superseded: number;
  /** Number of unchanged files carried through from the plan. */
  unchanged: number;
}

/**
 * Execution result emitted after applying a valid sync plan.
 */
export interface ProcedureSyncExecutionResult {
  /** Original sync plan that drove the execution. */
  plan: ProcedureSyncPlan;
  /** Per-file execution outcomes. */
  items: ProcedureSyncExecutionItem[];
  /** Aggregate execution counts. */
  totals: ProcedureSyncExecutionTotals;
}
