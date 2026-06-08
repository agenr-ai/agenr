import { describe, expect, it } from "vitest";

import { buildDreamExtractChunkPrompt, buildDreamExtractSystemPrompt } from "../../../src/core/dreaming/prompts.js";
import type { TranscriptChunk } from "../../../src/core/types.js";

describe("buildDreamExtractSystemPrompt", () => {
  it("uses the dreaming episode-summary contract instead of ingest transcript rules", () => {
    const prompt = buildDreamExtractSystemPrompt();

    expect(prompt).toContain("condensed episode summary");
    expect(prompt).toContain("## Claim Keys");
    expect(prompt).toContain("Include `claim_key` on every non-directive entry");
    expect(prompt).toContain("source_context");
    expect(prompt).toContain("## Already Stored In Session");
    expect(prompt).toContain("## Project Scope");
    expect(prompt).toContain("Omit `project` for personal, family");
    expect(prompt).not.toContain("## Claim-Key Preservation");
    expect(prompt).not.toContain("Only include `claim_key` when the transcript explicitly provides one");
  });
});

describe("buildDreamExtractChunkPrompt", () => {
  it("frames the chunk as episode evidence", () => {
    const chunk: TranscriptChunk = {
      chunk_index: 0,
      message_range: [0, 0],
      text: "The user shared their birthday and preferred terse answers.",
    };

    const prompt = buildDreamExtractChunkPrompt(chunk);

    expect(prompt).toContain("Episode summary to mine for durable knowledge:");
    expect(prompt).toContain(chunk.text);
    expect(prompt).toContain("Return JSON only");
  });

  it("lists already-stored session durables so mining can avoid duplicates", () => {
    const chunk: TranscriptChunk = {
      chunk_index: 0,
      message_range: [0, 0],
      text: "The user shared their birthday again in summary form.",
    };

    const prompt = buildDreamExtractChunkPrompt(chunk, {
      existingSessionDurables: [
        {
          id: "quality-default",
          type: "fact",
          subject: "user birthday",
          content: "Jim's birthday is March 15.",
          claimKey: "user/birthday",
          normContentHash: "hash-1",
        },
      ],
    });

    expect(prompt).toContain("Already stored live during this session");
    expect(prompt).toContain("user/birthday");
    expect(prompt).toContain("Emit only durable knowledge");
  });

  it("lists existing active claim-key context so mining can reuse keys", () => {
    const chunk: TranscriptChunk = {
      chunk_index: 0,
      message_range: [0, 0],
      text: "The summary mentions Agenr quality score defaults in new wording.",
    };

    const prompt = buildDreamExtractChunkPrompt(chunk, {
      existingClaimKeyContext: [
        {
          type: "fact",
          subject: "quality score default",
          content: "Agenr uses 0.5 as the default durable quality score when no stronger signal exists.",
          claimKey: "agenr/quality_score_default",
          project: "agenr",
        },
      ],
    });

    expect(prompt).toContain("Existing active claim-key context");
    expect(prompt).toContain("agenr/quality_score_default");
    expect(prompt).toContain("reuse exact keys");
    expect(prompt).toContain("project: agenr");
  });

  it("includes session workspace as a hint without defaulting every entry", () => {
    const chunk: TranscriptChunk = {
      chunk_index: 0,
      message_range: [0, 0],
      text: "The user shared family details and a repo-specific release policy.",
    };

    const prompt = buildDreamExtractChunkPrompt(chunk, { sessionWorkspace: "skeln" });

    expect(prompt).toContain("Session workspace context: skeln");
    expect(prompt).toContain("Do not default every durable to this project.");
  });
});
