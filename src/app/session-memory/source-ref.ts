const SESSION_FILE_SOURCE_REF_PREFIX = "session_file:";
const COMPACTION_SOURCE_REF_PREFIX = "compaction:";
const SESSION_END_SOURCE_REF_PREFIX = "session_end:";

/**
 * Builds a canonical source ref for a host session transcript file.
 *
 * @param sessionFile - Host transcript file or stable session source pointer.
 * @returns Canonical session-file source ref.
 */
export function buildSessionFileSourceRef(sessionFile: string): string {
  return `${SESSION_FILE_SOURCE_REF_PREFIX}${sessionFile.trim()}`;
}

/**
 * Builds a canonical source ref for one compaction artifact.
 *
 * @param source - Transcript file or compaction-local source id.
 * @returns Canonical compaction source ref.
 */
export function buildCompactionSourceRef(source: string): string {
  return `${COMPACTION_SOURCE_REF_PREFIX}${source.trim()}`;
}

/**
 * Builds a canonical source ref for one session-end artifact.
 *
 * @param source - Transcript file or shutdown-local source id.
 * @returns Canonical session-end source ref.
 */
export function buildSessionEndSourceRef(source: string): string {
  return `${SESSION_END_SOURCE_REF_PREFIX}${source.trim()}`;
}
