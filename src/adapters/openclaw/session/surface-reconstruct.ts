import { promises as fs } from "node:fs";

import { parseJsonlLines } from "../transcript/jsonl.js";
import { asRecord, getString } from "../transcript/tool-summarization.js";

const SENDER_METADATA_SENTINEL = "Sender (untrusted metadata):";
const CONVERSATION_INFO_SENTINEL = "Conversation info (untrusted metadata):";
const METADATA_BLOCK_PATTERN = /([\s\S]*?)```(?:json)?\s*([\s\S]*?)\s*```/giu;

/**
 * Best-effort OpenClaw session metadata reconstructed from raw transcript data.
 */
export interface ReconstructedOpenClawSessionMeta {
  /**
   * Reconstructed surface, or `null` when no trustworthy signal exists.
   */
  surface: string | null;
  /**
   * Provenance for the reconstructed result.
   */
  metadataSource: "reconstructed" | "none";
}

/**
 * Reconstructs OpenClaw surface metadata from raw transcript content.
 *
 * @param filePath - Transcript file to inspect.
 * @returns Reconstructed surface metadata.
 */
export async function reconstructOpenClawSessionMeta(filePath: string): Promise<ReconstructedOpenClawSessionMeta> {
  const raw = await fs.readFile(filePath, "utf8");
  const warnings: string[] = [];
  let reconstructedSurface: string | null = null;
  let firstUserText: string | null = null;

  parseJsonlLines(raw, warnings, (record) => {
    if (reconstructedSurface) {
      return;
    }

    const message = asRecord(record.message);
    if (!message) {
      return;
    }

    const inboundSurface = readInboundSurface(message) ?? readInboundSurface(record);
    if (inboundSurface) {
      reconstructedSurface = inboundSurface;
      return;
    }

    const role = getString(message.role)?.trim().toLowerCase();
    if (role !== "human" && role !== "user") {
      return;
    }

    const contentBlocks = extractRawTextBlocks(message.content);
    if (firstUserText === null) {
      const visibleText = normalizeVisibleText(contentBlocks);
      firstUserText = visibleText || "";
    }

    const senderSurface = extractMetadataSurface(contentBlocks, SENDER_METADATA_SENTINEL, readSenderSurface);
    if (senderSurface) {
      reconstructedSurface = senderSurface;
      return;
    }

    const conversationSurface = extractMetadataSurface(contentBlocks, CONVERSATION_INFO_SENTINEL, readConversationSurface);
    if (conversationSurface) {
      reconstructedSurface = conversationSurface;
    }
  });

  const inferredFromContent = inferSurfaceFromContent(firstUserText);
  if (reconstructedSurface ?? inferredFromContent) {
    return {
      surface: reconstructedSurface ?? inferredFromContent,
      metadataSource: "reconstructed",
    };
  }

  return {
    surface: null,
    metadataSource: "none",
  };
}

/**
 * Reads a surface value from `inbound_meta`.
 *
 * @param record - Raw transcript record or message payload.
 * @returns Normalized surface, or `null` when absent.
 */
function readInboundSurface(record: Record<string, unknown>): string | null {
  const inboundMeta = asRecord(record.inbound_meta);
  const surface = getString(inboundMeta?.surface)?.trim().toLowerCase();
  return surface || null;
}

/**
 * Extracts raw text blocks from mixed OpenClaw content arrays.
 *
 * @param content - Raw message content.
 * @returns Raw text blocks in order.
 */
function extractRawTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      blocks.push(record.text);
      continue;
    }

    if (typeof record.content === "string") {
      blocks.push(record.content);
    }
  }

  return blocks;
}

/**
 * Extracts one metadata-block-based surface from raw content blocks.
 *
 * @param blocks - Raw content blocks to inspect.
 * @param sentinel - Metadata sentinel that must prefix the block.
 * @param resolver - Surface resolver for the parsed metadata payload.
 * @returns Surface, or `null` when none is found.
 */
function extractMetadataSurface(blocks: string[], sentinel: string, resolver: (payload: Record<string, unknown>) => string | null): string | null {
  for (const block of blocks) {
    const matches = block.matchAll(METADATA_BLOCK_PATTERN);
    for (const match of matches) {
      const prefix = match[1]?.trim();
      const json = match[2]?.trim();
      if (prefix !== sentinel || !json) {
        continue;
      }

      try {
        const parsed = JSON.parse(json);
        const record = asRecord(parsed);
        if (!record) {
          continue;
        }

        const surface = resolver(record);
        if (surface) {
          return surface;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Reads a sender-metadata surface from a parsed metadata payload.
 *
 * @param payload - Parsed sender metadata.
 * @returns Surface, or `null` when none is recognized.
 */
function readSenderSurface(payload: Record<string, unknown>): string | null {
  const label = getString(payload.label)?.trim().toLowerCase() ?? getString(payload.id)?.trim().toLowerCase() ?? "";
  return mapKnownSurface(label);
}

/**
 * Reads a conversation-info-derived surface from a parsed metadata payload.
 *
 * @param payload - Parsed conversation-info metadata.
 * @returns Surface, or `null` when no trustworthy mapping exists.
 */
function readConversationSurface(payload: Record<string, unknown>): string | null {
  const senderId = getString(payload.sender_id)?.trim().toLowerCase() ?? "";
  return mapKnownSurface(senderId);
}

/**
 * Maps known OpenClaw sender labels into stable surface identifiers.
 *
 * @param value - Sender label or identifier.
 * @returns Stable surface, or `null` when the value is unknown.
 */
function mapKnownSurface(value: string): string | null {
  if (!value) {
    return null;
  }

  if (value.includes("telegram")) {
    return "telegram";
  }

  if (value.includes("signal")) {
    return "signal";
  }

  if (value.includes("discord")) {
    return "discord";
  }

  if (value.includes("openclaw-tui")) {
    return "tui";
  }

  if (value.includes("gateway-client") || value.includes("openclaw-control-ui") || value.includes("webchat")) {
    return "webchat";
  }

  return null;
}

/**
 * Infers a surface from the first visible user message when metadata blocks are absent.
 *
 * @param firstUserText - First user-visible transcript text.
 * @returns Stable surface, or `null` when no heuristic applies.
 */
function inferSurfaceFromContent(firstUserText: string | null): string | null {
  const normalized = firstUserText?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }

  if (normalized.includes("[subagent context]")) {
    return "subagent";
  }

  if (normalized.includes("heartbeat.md")) {
    return "heartbeat";
  }

  return null;
}

/**
 * Collapses raw text blocks into the first visible content string.
 *
 * @param blocks - Raw content blocks.
 * @returns Normalized visible text.
 */
function normalizeVisibleText(blocks: string[]): string {
  return blocks
    .join("\n")
    .replace(/```(?:json)?[\s\S]*?```/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
