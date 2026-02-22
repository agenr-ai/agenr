import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { detectAdapter } from "./adapters/registry.js";
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

export function renderTranscriptLine(message: TranscriptMessage): string {
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
    const firstMessage = messages[start];
    const lastMessage = messages[endExclusive - 1];
    const messageStart = firstMessage?.index ?? 0;
    const messageEnd = lastMessage?.index ?? messageStart;

    chunks.push({
      chunk_index: chunkIndex,
      message_start: messageStart,
      message_end: messageEnd,
      text,
      context_hint: buildContextHint(messages, start, endExclusive - 1),
      timestamp_start: firstMessage?.timestamp,
      timestamp_end: lastMessage?.timestamp,
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

function chunkText(
  raw: string,
  targetChars = TARGET_CHUNK_CHARS,
  overlapChars = OVERLAP_CHARS,
  fallbackTimestamp?: string,
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
    timestamp_start: fallbackTimestamp,
    timestamp_end: fallbackTimestamp,
  }));
}

export async function parseTranscriptFile(
  filePath: string,
  options?: import("./adapters/types.js").AdapterParseOptions,
): Promise<ParsedTranscript> {
  const adapter = await detectAdapter(filePath);
  const result = await adapter.parse(filePath, options);

  const messages = result.messages.filter((message) => message.text.trim().length > 0);
  const chunks =
    messages.length > 0
      ? chunkMessages(messages)
      : chunkText(await fs.readFile(filePath, "utf8"), TARGET_CHUNK_CHARS, OVERLAP_CHARS, result.metadata?.startedAt);

  return {
    file: filePath,
    messages,
    chunks,
    warnings: result.warnings,
    metadata: result.metadata,
  };
}
