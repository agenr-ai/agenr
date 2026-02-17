import type { TranscriptMessage } from "../types.js";

export interface AdapterParseOptions {
  /**
   * When true, bypass adapter filtering and truncation and preserve tool results
   * and other noisy blocks as much as possible.
   */
  raw?: boolean;
  /**
   * When true, adapters may add verbose diagnostics to parse warnings.
   */
  verbose?: boolean;
}

export interface ParseMetadata {
  sessionId?: string;
  platform?: string;
  startedAt?: string;
  model?: string;
  cwd?: string;
}

export interface ParseResult {
  messages: TranscriptMessage[];
  warnings: string[];
  metadata?: ParseMetadata;
}

export interface SourceAdapter {
  name: string;
  canHandle(filePath: string, firstLine?: string): boolean;
  parse(filePath: string, options?: AdapterParseOptions): Promise<ParseResult>;
}
