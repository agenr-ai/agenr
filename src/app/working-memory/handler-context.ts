import type { HostWorkingSetPolicy } from "./host-working-set-policy.js";
import type { WorkingMemoryRepository } from "./repository.js";

/** Shared dependencies passed to working-memory action handlers. */
export interface WorkingMemoryHandlerContext {
  /** Working-memory persistence port. */
  repository: WorkingMemoryRepository;
  /** ISO timestamp used for projections and writes. */
  timestamp: string;
  /** Adapter or runtime source label stored on new rows. */
  sourceLabel?: string;
  /** Host policy governing session and goal working-set exposure. */
  policy: HostWorkingSetPolicy;
}
