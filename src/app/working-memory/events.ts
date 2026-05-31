import type { AgenrWorkUpdateOperation } from "./mutations.js";

/**
 * Lifecycle event types written outside typed mutation operations.
 */
const WORKING_LIFECYCLE_EVENT_TYPES = ["created", "closed", "abandoned", "heartbeat", "lease_acquired", "lease_released"] as const;

export { WORKING_LIFECYCLE_EVENT_TYPES };

/**
 * Union of lifecycle event types stored in the working-event ledger.
 */
export type WorkingLifecycleEventType = (typeof WORKING_LIFECYCLE_EVENT_TYPES)[number];

/**
 * Closed union of event types stored in schema v11 `working_events.event_type`.
 */
export type WorkingEventType = AgenrWorkUpdateOperation["type"] | WorkingLifecycleEventType;
