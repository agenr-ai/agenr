/**
 * Canonical operation-type manifest for working-memory mutations.
 *
 * Adapters and handlers derive visibility and trust rules from these lists.
 */
import type { AgenrWorkUpdateOperation } from "../mutations.js";

const MODEL_VISIBLE_OPERATION_TYPES = [
  "set_objective",
  "replace_plan",
  "merge_checkpoint",
  "add_file_note",
  "add_command_note",
  "record_decision",
  "record_assumption",
  "set_next_actions",
  "add_candidate",
] as const;

/** Operations reserved for trusted host runtime paths (not model-visible). */
const TRUSTED_HOST_ONLY_OPERATION_TYPES = ["configure_budget", "account_usage", "set_continuation_policy"] as const;

/** All host-only operation types accepted on the update path. */
const HOST_ONLY_OPERATION_TYPES = ["set_status", ...TRUSTED_HOST_ONLY_OPERATION_TYPES] as const;

/** All operation types accepted on the working-memory update path. */
const WORKING_UPDATE_OPERATION_TYPES = [...MODEL_VISIBLE_OPERATION_TYPES, ...HOST_ONLY_OPERATION_TYPES] as const;

/** Union of model-visible working-memory operation types. */
export type ModelVisibleOperationType = (typeof MODEL_VISIBLE_OPERATION_TYPES)[number];

/** Union of host-only working-memory operation types. */
export type HostOnlyOperationType = (typeof HOST_ONLY_OPERATION_TYPES)[number];

/** Union of operations reserved for trusted host callers. */
export type TrustedHostOnlyOperationType = (typeof TRUSTED_HOST_ONLY_OPERATION_TYPES)[number];

/** Union of all working-memory update operation types. */
export type WorkingUpdateOperationType = (typeof WORKING_UPDATE_OPERATION_TYPES)[number];

/** Returns true when an operation type is exposed to model callers. */
export function isModelVisibleOperationType(type: string): type is ModelVisibleOperationType {
  return (MODEL_VISIBLE_OPERATION_TYPES as readonly string[]).includes(type);
}

/** Returns true when an operation type is accepted on the update path but not model-visible. */
export function isHostOnlyOperationType(type: string): type is HostOnlyOperationType {
  return (HOST_ONLY_OPERATION_TYPES as readonly string[]).includes(type);
}

/** Returns true when an operation is reserved for trusted host callers. */
export function isTrustedHostOnlyWorkingOperation(type: string): type is TrustedHostOnlyOperationType {
  return (TRUSTED_HOST_ONLY_OPERATION_TYPES as readonly string[]).includes(type);
}

/** Returns true when an operation type is accepted on the update path. */
export function isWorkingUpdateOperationType(type: string): type is AgenrWorkUpdateOperation["type"] {
  return isModelVisibleOperationType(type) || isHostOnlyOperationType(type);
}

export { HOST_ONLY_OPERATION_TYPES, MODEL_VISIBLE_OPERATION_TYPES, TRUSTED_HOST_ONLY_OPERATION_TYPES, WORKING_UPDATE_OPERATION_TYPES };
