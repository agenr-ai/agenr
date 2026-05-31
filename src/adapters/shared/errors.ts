/**
 * Formats unknown failures into stable loggable strings.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error text.
 */
export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
