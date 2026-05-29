import type { SessionStartPatch, SessionStartPatchItem } from "../../../app/session-start/index.js";

import { formatInjectionEntryBodyLines, formatInjectionEntryHeader } from "./entry-lines.js";
import { wrapAgenrMemoryContext } from "./memory-context.js";

/**
 * Formats session-start recall results into prompt text for host injection.
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
    const recallLines: string[] = [
      "## Agenr Session Recall",
      "Use this as prior context. Confirm anything important if the current conversation conflicts with it.",
      "",
    ];

    for (const section of durableSections) {
      recallLines.push(`### ${section.title}`);

      for (const item of section.entries) {
        recallLines.push(formatInjectionEntryHeader(item));
        recallLines.push(...formatInjectionEntryBodyLines(item));
      }

      recallLines.push("");
    }

    lines.push(wrapAgenrMemoryContext(recallLines.join("\n").trim()));
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
