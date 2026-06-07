import { FORKABLE_SNAPSHOT_FIELD_KEYS, type WorkingSnapshot } from "./snapshot.js";

/** Snapshot field keys copied when seeding a new goal from a session set. */
type ForkableSnapshotFieldKey = (typeof FORKABLE_SNAPSHOT_FIELD_KEYS)[number];

/** Forkable snapshot fields copied when seeding a new goal. */
type ForkableSnapshot = Pick<WorkingSnapshot, ForkableSnapshotFieldKey>;

/** Per-field cloners keyed by {@link FORKABLE_SNAPSHOT_FIELD_KEYS}. */
const FORKABLE_FIELD_CLONERS: {
  [K in ForkableSnapshotFieldKey]: (value: NonNullable<WorkingSnapshot[K]>) => NonNullable<WorkingSnapshot[K]>;
} = {
  currentPlan: (value) => [...value],
  nextActions: (value) => value.map((action) => ({ ...action })),
  checkpoint: (value) => ({
    ...value,
    ...(value.nextActions ? { nextActions: [...value.nextActions] } : {}),
    ...(value.blockers ? { blockers: [...value.blockers] } : {}),
  }),
  scratchpad: (value) => value,
  files: (value) => value.map((file) => ({ ...file })),
  commands: (value) => value.map((command) => ({ ...command })),
  decisions: (value) => value.map((decision) => ({ ...decision })),
  assumptions: (value) => value.map((assumption) => ({ ...assumption })),
};

/**
 * Copies one forkable field from a source snapshot into a target snapshot.
 *
 * @param target - Mutable forkable snapshot accumulator.
 * @param source - Source session snapshot.
 * @param key - Forkable field key to copy.
 */
function copyForkableField<K extends ForkableSnapshotFieldKey>(target: ForkableSnapshot, source: WorkingSnapshot, key: K): void {
  const value = source[key];
  if (value === undefined) {
    return;
  }

  target[key] = FORKABLE_FIELD_CLONERS[key](value);
}

/**
 * Shallow-copies {@link FORKABLE_SNAPSHOT_FIELD_KEYS} from one session snapshot.
 *
 * @param snapshot - Source session snapshot, when present.
 * @returns Forkable snapshot fields safe to merge into a new goal snapshot.
 */
export function cloneForkableSnapshotFields(snapshot: WorkingSnapshot | undefined): WorkingSnapshot {
  if (!snapshot) {
    return {};
  }

  const cloned: ForkableSnapshot = {};
  for (const key of FORKABLE_SNAPSHOT_FIELD_KEYS) {
    copyForkableField(cloned, snapshot, key);
  }

  return cloned;
}

export { FORKABLE_SNAPSHOT_FIELD_KEYS };
