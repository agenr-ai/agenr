import type { TranscriptMessage } from "../types.js";

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
  parse(filePath: string): Promise<ParseResult>;
}
