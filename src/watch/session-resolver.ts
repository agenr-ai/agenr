export interface SessionResolver {
  /** Glob/pattern for watchable files in the directory */
  filePattern: string;
  /** Return absolute path to the active session file, or null if unknown */
  resolveActiveSession(dir: string): Promise<string | null>;
  /** Given a file path that no longer exists, try to find its renamed equivalent. */
  findRenamedFile?(originalPath: string): Promise<string | null>;
}
