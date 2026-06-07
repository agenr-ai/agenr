import { CORE_TABLE_NAMES } from "./core-memory.js";
import { DREAMING_TABLE_NAMES } from "./dreaming.js";
import { SESSION_MEMORY_TABLE_NAMES } from "./session-memory.js";
import { WORKING_MEMORY_TABLE_NAMES } from "./working-memory.js";

export { CORE_TABLE_NAMES };

export /** Canonical tables that must all exist before initSchema may run against a persisted database. */ const REQUIRED_INITIALIZED_TABLES = [
  ...CORE_TABLE_NAMES,
  ...DREAMING_TABLE_NAMES,
  ...WORKING_MEMORY_TABLE_NAMES,
  ...SESSION_MEMORY_TABLE_NAMES,
] as const;
