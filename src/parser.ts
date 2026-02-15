import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { ParsedTranscript, TranscriptChunk, TranscriptMessage } from "./types.js";

const TARGET_CHUNK_CHARS = 12_000;
const OVERLAP_CHARS = 1_200;

function hasGlobChars(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function findMatchingBrace(segment: string, start: number): number {
  let depth = 0;
  for (let i = start; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function globSegmentPatternToRegex(segment: string): string {
  let regex = "";

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === "*") {
      regex += ".*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "[") {
      const end = segment.indexOf("]", i + 1);
      if (end > i + 1) {
        regex += segment.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (char === "{") {
      const end = findMatchingBrace(segment, i);
      if (end > i + 1) {
        const body = segment.slice(i + 1, end);
        const options = splitBraceAlternatives(body).map((option) => globSegmentPatternToRegex(option));
        if (options.length > 0) {
          regex += `(?:${options.join("|")})`;
          i = end;
          continue;
        }
      }
    }
    regex += escapeRegex(char ?? "");
  }

  return regex;
}

function globSegmentToRegExp(segment: string): RegExp {
  return new RegExp(`^${globSegmentPatternToRegex(segment)}$`);
}

async function expandGlobRecursive(baseDir: string, segments: string[]): Promise<string[]> {
  if (segments.length === 0) {
    return [baseDir || "."];
  }

  const [segment, ...rest] = segments;
  if (segment === "**") {
    const matches = await expandGlobRecursive(baseDir, rest);
    const nested = await walkDirectories(baseDir || ".");
    for (const dir of nested) {
      matches.push(...(await expandGlobRecursive(dir, rest)));
    }
    return matches;
  }

  if (!hasGlobChars(segment)) {
    const next = baseDir ? path.join(baseDir, segment) : segment;
    return expandGlobRecursive(next, rest);
  }

  const dir = baseDir || ".";
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const regex = globSegmentToRegExp(segment);
  const out: string[] = [];
  for (const entry of entries) {
    if (!segment.startsWith(".") && entry.startsWith(".")) {
      continue;
    }
    if (!regex.test(entry)) {
      continue;
    }
    const next = path.join(dir, entry);
    out.push(...(await expandGlobRecursive(next, rest)));
  }
  return out;
}

async function walkDirectories(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const next = path.join(current, entry.name);
      out.push(next);
      stack.push(next);
    }
  }
  return out;
}

export async function expandInputFiles(inputs: string[]): Promise<string[]> {
  const resolved = new Set<string>();

  for (const input of inputs) {
    if (!hasGlobChars(input)) {
      resolved.add(path.resolve(input));
      continue;
    }

    const isAbsolute = path.isAbsolute(input);
    const normalized = input.replace(/\\/g, "/");
    const rawSegments = normalized.split("/").filter((segment) => segment.length > 0);
    const base = isAbsolute ? path.parse(input).root : "";
    const matches = await expandGlobRecursive(base, rawSegments);
    for (const match of matches) {
      resolved.add(path.resolve(match));
    }
  }

  return Array.from(resolved).sort((a, b) => a.localeCompare(b));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderTranscriptLine(message: TranscriptMessage): string {
  const index = String(message.index).padStart(5, "0");
  return `[m${index}][${message.role}] ${message.text}`;
}

function buildContextHint(messages: TranscriptMessage[], start: number, end: number): string {
  const first = messages[start];
  const last = messages[end];
  if (!first || !last) {
    return "";
  }
  const firstText = first.text.slice(0, 100);
  const lastText = last.text.slice(0, 100);
  if (start === end) {
    return `[m${String(first.index).padStart(5, "0")}] ${firstText}`;
  }
  return `[m${String(first.index).padStart(5, "0")}] ${firstText} ... [m${String(last.index).padStart(5, "0")}] ${lastText}`;
}

export function chunkMessages(
  messages: TranscriptMessage[],
  targetChars = TARGET_CHUNK_CHARS,
  overlapChars = OVERLAP_CHARS,
): TranscriptChunk[] {
  if (messages.length === 0) {
    return [];
  }

  const rendered = messages.map((message) => `${renderTranscriptLine(message)}\n`);
  const lengths = rendered.map((line) => line.length);

  const chunks: TranscriptChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < messages.length) {
    let endExclusive = start;
    let total = 0;

    while (endExclusive < messages.length) {
      const nextLen = lengths[endExclusive] ?? 0;
      if (endExclusive > start && total + nextLen > targetChars) {
        break;
      }
      total += nextLen;
      endExclusive += 1;
      if (total >= targetChars) {
        break;
      }
    }

    if (endExclusive <= start) {
      endExclusive = start + 1;
    }

    const text = rendered.slice(start, endExclusive).join("");
    const messageStart = messages[start]?.index ?? 0;
    const messageEnd = messages[endExclusive - 1]?.index ?? messageStart;

    chunks.push({
      chunk_index: chunkIndex,
      message_start: messageStart,
      message_end: messageEnd,
      text,
      context_hint: buildContextHint(messages, start, endExclusive - 1),
    });

    if (endExclusive >= messages.length) {
      break;
    }

    const chunkMessageCount = endExclusive - start;
    if (chunkMessageCount <= 1) {
      start = endExclusive;
      chunkIndex += 1;
      continue;
    }

    let overlapStart = endExclusive;
    let overlapTotal = 0;
    for (let i = endExclusive - 1; i > start; i -= 1) {
      overlapTotal += lengths[i] ?? 0;
      overlapStart = i;
      if (overlapTotal >= overlapChars) {
        break;
      }
    }

    start = Math.max(start + 1, overlapStart);
    chunkIndex += 1;
  }

  const totalChunks = chunks.length;
  return chunks.map((chunk, index) => ({
    ...chunk,
    index,
    totalChunks,
  }));
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const out: string[] = [];
  let nonTextCount = 0;

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        out.push(normalized);
      }
      continue;
    }
    nonTextCount += 1;
  }

  if (out.length === 0 && nonTextCount > 0) {
    out.push(`[non-text content omitted: ${nonTextCount} block${nonTextCount === 1 ? "" : "s"}]`);
  }

  return out;
}

function parseJsonlMessageRecord(record: Record<string, unknown>): { role: TranscriptMessage["role"]; content: unknown } | null {
  if (
    (record.role === "user" || record.role === "assistant" || record.role === "human" || record.role === "ai") &&
    "content" in record
  ) {
    const role = record.role === "assistant" || record.role === "ai" ? "assistant" : "user";
    return {
      role,
      content: record.content,
    };
  }

  if (record.type !== "message") {
    return null;
  }

  const messageRecord = record.message;
  if (!messageRecord || typeof messageRecord !== "object") {
    return null;
  }

  const message = messageRecord as Record<string, unknown>;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "human" && message.role !== "ai") {
    return null;
  }

  return {
    role: message.role === "assistant" || message.role === "ai" ? "assistant" : "user",
    content: message.content,
  };
}

function parseJsonl(raw: string, warnings: string[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const lines = raw.split(/\r?\n/);
  let index = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`Skipped malformed JSONL line ${i + 1}`);
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const mapped = parseJsonlMessageRecord(record);
    if (!mapped) {
      continue;
    }

    const textBlocks = extractTextBlocks(mapped.content);
    const text = normalizeWhitespace(textBlocks.join("\n"));
    if (!text) {
      continue;
    }

    messages.push({
      index,
      role: mapped.role,
      text,
    });
    index += 1;
  }

  return messages;
}

function chunkText(
  raw: string,
  targetChars = TARGET_CHUNK_CHARS,
  overlapChars = OVERLAP_CHARS,
): TranscriptChunk[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + targetChars);
    const slice = text.slice(start, end).trim();

    if (slice.length > 0) {
      chunks.push({
        text: slice,
        start,
        end,
      });
    }

    if (end >= text.length) {
      break;
    }

    const nextStart = Math.max(start + 1, end - overlapChars);
    start = nextStart;
  }

  const totalChunks = chunks.length;
  return chunks.map((chunk, index) => ({
    chunk_index: index,
    message_start: index,
    message_end: index,
    text: chunk.text,
    context_hint: `text chunk ${index + 1}/${totalChunks} (${chunk.start}-${chunk.end})`,
    index,
    totalChunks,
  }));
}

function parseFirstJsonLine(raw: string): Record<string, unknown> | null {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function looksLikeJsonl(raw: string): boolean {
  const firstRecord = parseFirstJsonLine(raw);
  if (!firstRecord) {
    return false;
  }
  return parseJsonlMessageRecord(firstRecord) !== null;
}

function detectInputKind(filePath: string, raw: string): "jsonl" | "text" {
  if (looksLikeJsonl(raw)) {
    return "jsonl";
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jsonl") {
    return "jsonl";
  }
  if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
    return "text";
  }

  return "text";
}

export async function parseTranscriptFile(filePath: string): Promise<ParsedTranscript> {
  const raw = await fs.readFile(filePath, "utf8");
  const warnings: string[] = [];
  const kind = detectInputKind(filePath, raw);

  const messages = kind === "jsonl" ? parseJsonl(raw, warnings).filter((message) => message.text.trim().length > 0) : [];
  const chunks = kind === "jsonl" ? chunkMessages(messages) : chunkText(raw);

  return {
    file: filePath,
    messages,
    chunks,
    warnings,
  };
}
