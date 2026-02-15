import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import type { KnowledgeEntry, LlmClient, TranscriptChunk } from "./types.js";
import { runSimpleStream, type StreamSimpleFn } from "./llm/stream.js";

const SYSTEM_PROMPT = `You are a knowledge extraction engine. Your job is to read conversation
transcripts between a human and an AI assistant and extract structured
knowledge from them.

You extract the following types of knowledge:

FACTS - Concrete, verifiable information about people, places, things,
systems, or concepts. Include biographical details, technical specifications,
account information, configurations, and any stated truths.

DECISIONS - Choices that were made during the conversation. Include what was
decided, why, what alternatives were considered, and any conditions or
caveats.

PREFERENCES - Stated or strongly implied preferences. Include what is
preferred, what is not preferred, and in what context.

TODOS - Action items, tasks, things that need to be done. Include who needs
to do it, any deadlines, and current status if mentioned.

RELATIONSHIPS - Connections between people, systems, organizations, or
concepts. Include the nature of the relationship and any relevant details.

EVENTS - Things that happened. Include when they happened, who was involved,
and the significance.

LESSONS - Insights, learnings, principles derived from experience. Include
what was learned and what triggered the learning.

Rules:
- Extract ONLY what is explicitly stated or strongly implied in the transcript
- Do NOT infer, speculate, or add information not present in the conversation
- Each entry should be self-contained and understandable without the transcript
- Write content as clear, declarative statements
- For the subject field, use the most specific identifier (name, project name, etc.)
- Assign confidence: high (explicitly stated), medium (strongly implied), low (weakly implied)
- Assign expiry: permanent (biographical, preferences, lessons), temporary (current projects, recent events), session-only (immediate context unlikely to matter later)
- Use specific, descriptive tags
- source.context: one sentence, max 20 words. Describe WHERE in the conversation this came from (e.g., "user described deployment setup", "assistant listed auth options"). Do NOT quote the transcript.

Output format: JSON array of KnowledgeEntry objects. No markdown wrapping,
no explanation, just the JSON array.`;

const MAX_ATTEMPTS = 3;

const TYPE_ALIASES: Record<string, KnowledgeEntry["type"]> = {
  facts: "fact",
  decisions: "decision",
  preferences: "preference",
  todos: "todo",
  relationships: "relationship",
  events: "event",
  lessons: "lesson",
  fact: "fact",
  decision: "decision",
  preference: "preference",
  todo: "todo",
  relationship: "relationship",
  event: "event",
  lesson: "lesson",
};

const CONFIDENCE_ALIASES: Record<string, KnowledgeEntry["confidence"]> = {
  high: "high",
  medium: "medium",
  med: "medium",
  low: "low",
};

const EXPIRY_ALIASES: Record<string, KnowledgeEntry["expiry"]> = {
  permanent: "permanent",
  temporary: "temporary",
  "session-only": "session-only",
  session_only: "session-only",
  session: "session-only",
};

class ParseResponseError extends Error {}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function buildUserPrompt(chunk: TranscriptChunk): string {
  return [
    "Extract all knowledge from this conversation transcript.",
    "",
    "Transcript:",
    "---",
    chunk.text,
    "---",
    "",
    "Return a JSON array of KnowledgeEntry objects.",
    "Return strict JSON only.",
  ].join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  if (match?.[1]) {
    return match[1].trim();
  }
  return trimmed;
}

function coerceType(value: unknown): KnowledgeEntry["type"] | null {
  if (typeof value !== "string") {
    return null;
  }
  return TYPE_ALIASES[normalize(value)] ?? null;
}

function coerceConfidence(value: unknown): KnowledgeEntry["confidence"] | null {
  if (typeof value !== "string") {
    return null;
  }
  return CONFIDENCE_ALIASES[normalize(value)] ?? null;
}

function coerceExpiry(value: unknown): KnowledgeEntry["expiry"] | null {
  if (typeof value !== "string") {
    return null;
  }
  return EXPIRY_ALIASES[normalize(value).replace(/\s+/g, "-")] ?? null;
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.toLowerCase());

  return Array.from(new Set(tags));
}

function firstString(
  record: Record<string, unknown>,
  ...keys: string[]
): { value: string; key: string | null } {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), key };
    }
  }
  return { value: "", key: null };
}

function validateKnowledgeEntry(
  value: unknown,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry | null {
  if (!value || typeof value !== "object") {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped non-object entry.`);
    return null;
  }

  const record = value as Record<string, unknown>;

  const type = coerceType(record.type);
  if (!type) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid type: "${String(record.type ?? "undefined")}"`);
    return null;
  }

  const contentResult = firstString(
    record,
    "content",
    "description",
    "detail",
    "text",
    "summary",
    "value", "statement", "knowledge",
  );
  const content = contentResult.value;
  if (verbose && contentResult.key && contentResult.key !== "content") {
    onVerbose?.(`[field-fallback] used "${contentResult.key}" for content`);
  }
  if (!content) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with empty content.`);
    return null;
  }

  const subjectResult = firstString(record, "subject", "name", "topic", "title", "entity");
  const subject = subjectResult.value;
  if (verbose && subjectResult.key && subjectResult.key !== "subject") {
    onVerbose?.(`[field-fallback] used "${subjectResult.key}" for subject`);
  }
  if (!subject) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with empty subject.`);
    return null;
  }

  const confidence = coerceConfidence(record.confidence);
  if (!confidence) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid confidence.`);
    return null;
  }

  const expiry = coerceExpiry(record.expiry);
  if (!expiry) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid expiry.`);
    return null;
  }

  const sourceRecord =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;

  const contextResult = firstString(record, "source_context", "context");
  const nestedContext =
    sourceRecord && typeof sourceRecord.context === "string" ? sourceRecord.context.trim() : "";
  const contextFromModel = nestedContext || contextResult.value;
  if (verbose && !nestedContext && contextResult.key) {
    onVerbose?.(`[field-fallback] used "${contextResult.key}" for source.context`);
  }

  const sourceString = typeof record.source === "string" ? record.source.trim() : "";
  if (verbose && !contextFromModel && sourceString) {
    onVerbose?.('[field-fallback] used "source" string for source.context');
  }

  return {
    type,
    content,
    subject,
    confidence,
    expiry,
    tags: coerceTags(record.tags),
    source: {
      file,
      context: contextFromModel || sourceString || chunk.context_hint || `chunk ${chunk.chunk_index + 1}`,
    },
  };
}

function parseKnowledgeEntries(
  rawText: string,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] {
  const stripped = stripCodeFence(rawText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new ParseResponseError(
      `Chunk ${chunk.chunk_index + 1}: model response was not valid JSON (${error instanceof Error ? error.message : "parse failure"}).`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ParseResponseError(`Chunk ${chunk.chunk_index + 1}: model response was not a JSON array.`);
  }

  if (verbose && parsed.length > 0) {
    onVerbose?.(`[raw-sample] ${JSON.stringify(parsed[0])}`);
  }

  const entries: KnowledgeEntry[] = [];
  for (const item of parsed) {
    const validated = validateKnowledgeEntry(item, file, chunk, warnings, verbose, onVerbose);
    if (validated) {
      entries.push(validated);
    }
  }

  return entries;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ParseResponseError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("rate")
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractChunkOnce(params: {
  file: string;
  chunk: TranscriptChunk;
  model: Model<Api>;
  apiKey: string;
  verbose: boolean;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  streamSimpleImpl?: StreamSimpleFn;
}): Promise<{ entries: KnowledgeEntry[]; warnings: string[] }> {
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(params.chunk),
        timestamp: Date.now(),
      },
    ],
  };

  const assistantMessage = await runSimpleStream({
    model: params.model,
    context,
    options: {
      apiKey: params.apiKey,
      reasoning: params.verbose ? "low" : undefined,
    },
    verbose: params.verbose,
    onVerbose: params.onVerbose,
    onStreamDelta: params.onStreamDelta,
    streamSimpleImpl: params.streamSimpleImpl,
  });

  const text = extractAssistantText(assistantMessage);
  if (!text) {
    throw new ParseResponseError(
      `Chunk ${params.chunk.chunk_index + 1}: model response had no text blocks to parse.`,
    );
  }

  const warnings: string[] = [];
  const entries = parseKnowledgeEntries(
    text,
    params.file,
    params.chunk,
    warnings,
    params.verbose,
    params.onVerbose,
  );
  return { entries, warnings };
}

export interface ExtractChunksResult {
  entries: KnowledgeEntry[];
  successfulChunks: number;
  failedChunks: number;
  warnings: string[];
}

export async function extractKnowledgeFromChunks(params: {
  file: string;
  chunks: TranscriptChunk[];
  client: LlmClient;
  verbose: boolean;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  streamSimpleImpl?: StreamSimpleFn;
  sleepImpl?: (ms: number) => Promise<void>;
  retryDelayMs?: (attempt: number) => number;
}): Promise<ExtractChunksResult> {
  const warnings: string[] = [];
  const entries: KnowledgeEntry[] = [];

  let successfulChunks = 0;
  let failedChunks = 0;

  for (const chunk of params.chunks) {
    let chunkDone = false;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (params.verbose) {
        params.onVerbose?.(
          `[chunk ${chunk.chunk_index + 1}/${params.chunks.length}] attempt ${attempt}/${MAX_ATTEMPTS}`,
        );
      }

      try {
        const result = await extractChunkOnce({
          file: params.file,
          chunk,
          model: params.client.resolvedModel.model,
          apiKey: params.client.credentials.apiKey,
          verbose: params.verbose,
          onVerbose: params.onVerbose,
          onStreamDelta: params.onStreamDelta,
          streamSimpleImpl: params.streamSimpleImpl,
        });

        entries.push(...result.entries);
        warnings.push(...result.warnings);
        successfulChunks += 1;
        chunkDone = true;
        break;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_ATTEMPTS && isRetryableError(error)) {
          const backoffMs = params.retryDelayMs?.(attempt) ?? 1000 * 2 ** (attempt - 1);
          warnings.push(
            `Chunk ${chunk.chunk_index + 1}: attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}), retrying in ${backoffMs}ms.`,
          );
          const sleep = params.sleepImpl ?? sleepMs;
          await sleep(backoffMs);
          continue;
        }

        break;
      }
    }

    if (!chunkDone) {
      failedChunks += 1;
      warnings.push(
        `Chunk ${chunk.chunk_index + 1}: extraction failed (${lastError instanceof Error ? lastError.message : String(lastError)}).`,
      );
    }

    if (params.onStreamDelta) {
      params.onStreamDelta("\n", "text");
    }
  }

  return {
    entries,
    successfulChunks,
    failedChunks,
    warnings,
  };
}
