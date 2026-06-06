import { DREAMING_TABLE_NAMES } from "./dreaming.js";
import { SESSION_MEMORY_TABLE_NAMES } from "./session-memory.js";
import { WORKING_MEMORY_TABLE_NAMES } from "./working-memory.js";

/** Canonical tables owned by the core durable, episode, and procedure schema. */
export const CORE_TABLE_NAMES = ["durables", "durables_fts", "ingest_log", "episodes", "procedures", "procedures_fts", "recall_events", "_meta"] as const;

/** Canonical tables that must all exist before initSchema may run against a persisted database. */
export const REQUIRED_INITIALIZED_TABLES = [
  ...CORE_TABLE_NAMES,
  ...DREAMING_TABLE_NAMES,
  ...WORKING_MEMORY_TABLE_NAMES,
  ...SESSION_MEMORY_TABLE_NAMES,
] as const;
