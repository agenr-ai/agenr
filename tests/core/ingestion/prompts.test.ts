import { describe, expect, it } from "vitest";

import { buildChunkPrompt, buildExtractionSystemPrompt } from "../../../src/core/ingestion/prompts.js";
import type { Entry, TranscriptChunk } from "../../../src/core/types.js";

function buildEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    type: "fact",
    subject: "agenr package manager",
    content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
    importance: 8,
    expiry: "permanent",
    tags: ["workflow"],
    quality_score: 0.8,
    recall_count: 0,
    retired: false,
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildExtractionSystemPrompt", () => {
  it("contains the key extraction sections", () => {
    const prompt = buildExtractionSystemPrompt();

    expect(prompt).toContain("## Types");
    expect(prompt).toContain("## Importance");
    expect(prompt).toContain('Return JSON only: {"entries":[...]}');
    expect(prompt).toContain('"high", "standard", or "low"');
  });

  it("includes whole-file calibration when requested", () => {
    const prompt = buildExtractionSystemPrompt({ wholeFile: true });

    expect(prompt).toContain("## Whole-File Calibration");
    expect(prompt).toContain("Session triage");
  });

  it("classifies personal priorities as preferences before decisions", () => {
    const prompt = buildExtractionSystemPrompt();
    const preferenceCheck = "2. Does it state what someone WANTS or PREFERS? → preference";
    const decisionCheck = "3. Does it prescribe what to DO going forward because the project, team, or system has adopted it? → decision";

    expect(prompt).toContain(
      "If the statement is mainly about a named person's desired style, values, priorities, or opinions, classify it as preference even if it implies future behavior.",
    );
    expect(prompt).toContain("Never emit both a preference and a decision for the same underlying policy.");
    expect(prompt.indexOf(preferenceCheck)).toBeGreaterThan(-1);
    expect(prompt.indexOf(decisionCheck)).toBeGreaterThan(prompt.indexOf(preferenceCheck));
  });

  it("treats standard as the default importance tier with target distribution", () => {
    const prompt = buildExtractionSystemPrompt();

    expect(prompt).toContain("standard: The default tier.");
    expect(prompt).toContain("Target distribution: roughly 15-25% high, 55-65% standard, 15-25% low.");
    expect(prompt).toContain("If more than 40% of entries are high, re-rate the weakest highs.");
    expect(prompt).toContain("If you have zero low entries, re-evaluate your weakest standard entries.");
  });
});

describe("buildChunkPrompt", () => {
  const chunk: TranscriptChunk = {
    chunk_index: 0,
    message_range: [0, 1],
    text: "[m00000][user] We always use pnpm.\n[m00001][assistant] Acknowledged.",
  };

  it("includes the transcript text", () => {
    const prompt = buildChunkPrompt(chunk);

    expect(prompt).toContain(chunk.text);
  });

  it("includes previously extracted entries when provided", () => {
    const prompt = buildChunkPrompt(chunk, {
      previouslyExtracted: [
        {
          type: "decision",
          subject: "agenr package manager",
          summary: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
        },
      ],
    });

    expect(prompt).toContain("Previously extracted from this file");
    expect(prompt).toContain('"agenr package manager"');
  });

  it("includes related entries when provided", () => {
    const prompt = buildChunkPrompt(chunk, {
      relatedEntries: [buildEntry()],
    });

    expect(prompt).toContain("Related existing memories");
    expect(prompt).toContain("agenr package manager");
  });
});
