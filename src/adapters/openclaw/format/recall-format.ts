import type { SessionStartPatch, SessionStartPatchItem } from "../../../app/session-start/index.js";

const MAX_CONTENT_CHARS = 220;

/**
 * Formats session-start recall results into prompt text for OpenClaw injection.
 *
 * @param patch - Structured session-start patch returned by the app layer.
 * @returns Prompt-ready text, or an empty string when nothing should be injected.
 */
export function formatAgenrSessionStartRecall(patch: SessionStartPatch): string {
  if (patch.contextSections.length === 0 && patch.durableMemory.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const section of patch.contextSections) {
    lines.push(`## ${section.title}`);
    lines.push(section.content);
    lines.push("");
  }

  const durableSections = buildSections(patch);
  if (durableSections.length > 0) {
    lines.push("## Agenr Session Recall");
    lines.push("Use this as prior context. Confirm anything important if the current conversation conflicts with it.");
    lines.push("");
  }

  for (const section of durableSections) {
    lines.push(`### ${section.title}`);

    for (const item of section.entries) {
      lines.push(formatEntryHeader(item));
      lines.push(...formatEntryBodyLines(item));
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Builds the ordered memory sections that should appear in the system prompt.
 *
 * @param patch - Structured patch payload grouped by source kind.
 * @returns Non-empty prompt sections ready for rendering.
 */
export function buildSections(patch: SessionStartPatch): Array<{ title: string; entries: SessionStartPatchItem[] }> {
  const sections: Array<{ title: string; entries: SessionStartPatchItem[] }> = [];

  const coreEntries = patch.durableMemory.filter((item) => item.sourceKind === "core");
  if (coreEntries.length > 0) {
    sections.push({ title: "Core Memory", entries: coreEntries });
  }

  const artifactRecallEntries = patch.durableMemory.filter((item) => item.sourceKind === "artifact_recall");
  if (artifactRecallEntries.length > 0) {
    sections.push({ title: "Relevant Durable Memory", entries: artifactRecallEntries });
  }

  return sections;
}

/** Formats one memory entry header line for prompt injection. */
function formatEntryHeader(item: SessionStartPatchItem): string {
  const metadata = [
    `rank ${item.rank}`,
    item.entry.id,
    item.entry.type,
    item.entry.expiry,
    `importance ${item.entry.importance}`,
    item.score !== undefined ? `score ${item.score.toFixed(2)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return `- [${metadata.join(" | ")}] ${item.entry.subject}`;
}

/** Formats one memory entry body block for prompt injection. */
function formatEntryBodyLines(item: SessionStartPatchItem): string[] {
  const lines = [`  ${truncate(item.entry.content.trim(), MAX_CONTENT_CHARS)}`];
  lines.push(`  why: ${item.whySurfaced.summary}`);

  const metadata = [
    item.entry.tags.length > 0 ? `tags: ${item.entry.tags.join(", ")}` : undefined,
    item.freshnessLabel ? `freshness: ${item.freshnessLabel}` : undefined,
    item.provenanceSummary ? `provenance: ${truncate(item.provenanceSummary, MAX_CONTENT_CHARS)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (metadata.length > 0) {
    lines.push(`  ${metadata.join(" | ")}`);
  }

  return lines;
}

/** Truncates long memory content to keep prompt injection bounded. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
