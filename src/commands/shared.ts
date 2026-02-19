import { DEFAULT_DB_PATH } from "../db/client.js";

export function resolveDbPathFromOptions(
  dbOption: string | undefined,
  configPath: string | undefined,
): string {
  return dbOption?.trim() || configPath || DEFAULT_DB_PATH;
}
