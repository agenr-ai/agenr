import { describe, expect, it } from "vitest";

import { prepareEpisodeIngest } from "../../../src/app/episode-ingest/index.js";
import type {
  EpisodeIngestFilePort,
  EpisodeIngestPorts,
  SessionMeta,
  SessionMetaInspectorPort,
  SessionRegistryPort,
} from "../../../src/app/episode-ingest/ports.js";
import type { EpisodeUpsertResult } from "../../../src/core/episode/types.js";
import type { EpisodeDatabasePort, TranscriptPort } from "../../../src/core/ports.js";
import type { Episode, ParsedTranscript } from "../../../src/core/types.js";

describe("prepareEpisodeIngest", () => {
  it("builds candidates with registry metadata taking precedence over reconstructed metadata", async () => {
    const filePath = "/tmp/123e4567-e89b-12d3-a456-426614174000.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([filePath]),
        transcript: new MockTranscriptPort({
          [filePath]: buildTranscript({
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            endedAt: "2026-03-30T09:00:00.000Z",
          }),
        }),
        sessionRegistry: new MockSessionRegistry({
          "123e4567-e89b-12d3-a456-426614174000": {
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            sourceRef: "/sessions/123e4567-e89b-12d3-a456-426614174000.jsonl",
            agentId: "main",
            surface: "webchat",
            provider: "webchat",
            chatType: "direct",
            metadataSource: "registry",
          },
        }),
        sessionMetaInspector: new MockSessionMetaInspector({
          [filePath]: {
            surface: "telegram",
            metadataSource: "reconstructed",
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.invalid).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        filePath,
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        sourceRef: "/sessions/123e4567-e89b-12d3-a456-426614174000.jsonl",
        agentId: "main",
        surface: "webchat",
        metadataSource: "registry",
        messageCount: 4,
        renderedTranscript: expect.stringContaining("User:"),
      }),
    );
    expect(result.candidates[0]?.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("skips short and active sessions before candidate generation", async () => {
    const shortFile = "/tmp/short.jsonl";
    const activeFile = "/tmp/active.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([shortFile, activeFile]),
        transcript: new MockTranscriptPort({
          [shortFile]: buildTranscript({
            sessionId: "short-session",
            endedAt: "2026-03-30T09:00:00.000Z",
            messages: buildMessages(3),
          }),
          [activeFile]: buildTranscript({
            sessionId: "active-session",
            endedAt: "2026-03-30T09:57:00.000Z",
          }),
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.candidates).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.skipped.map((entry) => [entry.filePath, entry.reason])).toEqual([
      [shortFile, "skipped_short"],
      [activeFile, "skipped_active"],
    ]);
  });

  it("skips existing episodes unless regenerate is enabled", async () => {
    const filePath = "/tmp/existing.jsonl";
    const existingEpisode = buildEpisode({
      id: "episode-1",
      sourceId: "existing-session",
      transcriptHash: "existing-hash",
    });
    const basePorts = createPorts({
      files: new MockEpisodeFiles([filePath]),
      transcript: new MockTranscriptPort({
        [filePath]: buildTranscript({
          sessionId: "existing-session",
          transcriptHash: "existing-hash",
          endedAt: "2026-03-30T09:00:00.000Z",
        }),
      }),
      episodes: new MockEpisodeDatabase({
        bySourceId: {
          "existing-session": existingEpisode,
        },
      }),
    });

    const skipped = await prepareEpisodeIngest("/tmp", basePorts, {
      now: new Date("2026-03-30T10:00:00.000Z"),
    });
    const regenerated = await prepareEpisodeIngest("/tmp", basePorts, {
      regenerate: true,
      now: new Date("2026-03-30T10:00:00.000Z"),
    });

    expect(skipped.candidates).toEqual([]);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({
        filePath,
        reason: "skipped_exists",
        existingEpisode,
      }),
    ]);
    expect(regenerated.skipped).toEqual([]);
    expect(regenerated.candidates).toEqual([
      expect.objectContaining({
        filePath,
        existingEpisode,
      }),
    ]);
  });

  it("falls back to transcript-hash dedup when no session id is available", async () => {
    const filePath = "/tmp/no-session-id.jsonl";
    const existingEpisode = buildEpisode({
      id: "episode-hash",
      sourceId: undefined,
      transcriptHash: "hash-only",
    });
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([filePath]),
        transcript: new MockTranscriptPort({
          [filePath]: buildTranscript({
            sessionId: undefined,
            transcriptHash: "hash-only",
            endedAt: "2026-03-30T09:00:00.000Z",
          }),
        }),
        episodes: new MockEpisodeDatabase({
          byTranscriptHash: {
            "hash-only": existingEpisode,
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.skipped).toEqual([
      expect.objectContaining({
        filePath,
        reason: "skipped_exists",
        sessionId: undefined,
        existingEpisode,
      }),
    ]);
  });

  it("records invalid transcripts and caps long rendered transcripts", async () => {
    const invalidFile = "/tmp/invalid.jsonl";
    const longFile = "/tmp/long.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([invalidFile, longFile]),
        transcript: new MockTranscriptPort({
          [invalidFile]: buildTranscript({
            sessionId: undefined,
            endedAt: undefined,
            messages: [],
          }),
          [longFile]: buildTranscript({
            sessionId: "long-session",
            endedAt: "2026-03-30T09:00:00.000Z",
            messages: buildMessages(4, "segment ".repeat(2500)),
          }),
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.invalid).toEqual([
      {
        filePath: invalidFile,
        sessionId: undefined,
        transcriptHash: "service-transcript-hash",
        messageCount: 0,
        metadataSource: "none",
      },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.renderedTranscript.length).toBeLessThanOrEqual(14_000);
    expect(result.candidates[0]?.renderedTranscript).toContain("[Earlier middle transcript omitted for brevity]");
  });
});

function createPorts(overrides: Partial<EpisodeIngestPorts> = {}): EpisodeIngestPorts {
  return {
    files: overrides.files ?? new MockEpisodeFiles([]),
    transcript: overrides.transcript ?? new MockTranscriptPort({}),
    episodes: overrides.episodes ?? new MockEpisodeDatabase(),
    sessionRegistry: overrides.sessionRegistry,
    sessionMetaInspector: overrides.sessionMetaInspector,
  };
}

class MockEpisodeFiles implements EpisodeIngestFilePort {
  public constructor(private readonly discoveredFiles: string[]) {}

  public async discoverFiles(): Promise<string[]> {
    return this.discoveredFiles;
  }
}

class MockTranscriptPort implements TranscriptPort {
  public constructor(private readonly transcripts: Record<string, ParsedTranscript>) {}

  public async parseFile(filePath: string): Promise<ParsedTranscript> {
    const transcript = this.transcripts[filePath];
    if (!transcript) {
      throw new Error(`Missing transcript fixture for ${filePath}`);
    }

    return transcript;
  }
}

class MockEpisodeDatabase implements EpisodeDatabasePort {
  public constructor(
    private readonly episodes: {
      bySourceId?: Record<string, Episode>;
      byTranscriptHash?: Record<string, Episode>;
    } = {},
  ) {}

  public async getEpisodeBySourceId(_source: "openclaw", sourceId: string): Promise<Episode | null> {
    return this.episodes.bySourceId?.[sourceId] ?? null;
  }

  public async getEpisodeByTranscriptHash(_source: "openclaw", transcriptHash: string): Promise<Episode | null> {
    return this.episodes.byTranscriptHash?.[transcriptHash] ?? null;
  }

  public async upsertEpisode(): Promise<EpisodeUpsertResult> {
    throw new Error("Stage 1 preflight should not write episodes.");
  }

  public async listEpisodesByTimeWindow(): Promise<Episode[]> {
    return [];
  }
}

class MockSessionRegistry implements SessionRegistryPort {
  public constructor(private readonly entries: Record<string, SessionMeta>) {}

  public async getSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.entries[sessionId];
  }

  public async listSessions(): Promise<SessionMeta[]> {
    return Object.values(this.entries);
  }
}

class MockSessionMetaInspector implements SessionMetaInspectorPort {
  public constructor(private readonly entries: Record<string, { surface: string | null; metadataSource: "reconstructed" | "none" }>) {}

  public async inspectFile(filePath: string): Promise<{ surface: string | null; metadataSource: "reconstructed" | "none" }> {
    return this.entries[filePath] ?? { surface: null, metadataSource: "none" };
  }
}

function buildTranscript(
  overrides: {
    sessionId?: string;
    transcriptHash?: string;
    endedAt?: string;
    messages?: ParsedTranscript["messages"];
  } = {},
): ParsedTranscript {
  const messages = overrides.messages ?? buildMessages(4);

  return {
    messages,
    metadata: {
      sessionId: overrides.sessionId,
      startedAt: messages[0]?.timestamp,
      endedAt: overrides.endedAt ?? messages[messages.length - 1]?.timestamp,
      messageCount: messages.length,
      transcriptHash: overrides.transcriptHash ?? "service-transcript-hash",
    },
    warnings: [],
  };
}

function buildMessages(count: number, text = "This is a durable transcript message."): ParsedTranscript["messages"] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    timestamp: `2026-03-30T09:0${index}:00.000Z`,
  }));
}

function buildEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: overrides.id ?? "episode-default",
    source: "openclaw",
    sourceId: overrides.sourceId,
    sourceRef: overrides.sourceRef ?? "/tmp/source.jsonl",
    transcriptHash: overrides.transcriptHash,
    summaryHash: overrides.summaryHash ?? "summary-hash",
    agentId: overrides.agentId,
    surface: overrides.surface,
    startedAt: overrides.startedAt ?? "2026-03-30T09:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-03-30T09:30:00.000Z",
    summary: overrides.summary ?? "Stored episode summary.",
    tags: overrides.tags ?? ["episodes"],
    activityLevel: overrides.activityLevel ?? "substantial",
    userId: overrides.userId,
    project: overrides.project,
    genModel: overrides.genModel,
    genVersion: overrides.genVersion,
    messageCount: overrides.messageCount ?? 4,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retiredAt: overrides.retiredAt,
    retiredReason: overrides.retiredReason,
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? "2026-03-30T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-30T10:00:00.000Z",
  };
}
