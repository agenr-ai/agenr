import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { averageEmbedding, cosineSim } from "./util.js";

export interface VerifyResult {
  status: "accept" | "flag";
  reason?: string;
}

export interface FlaggedMerge {
  mergedContent: string;
  mergedSubject: string;
  mergedType: string;
  sourceIds: string[];
  sourceContents: string[];
  flagReason: string;
  flaggedAt: string;
}

export const REVIEW_QUEUE_PATH = path.join(os.homedir(), ".agenr", "review-queue.json");

async function ensureQueueDir(): Promise<void> {
  await fs.mkdir(path.dirname(REVIEW_QUEUE_PATH), { recursive: true });
}

export async function verifyMerge(
  _mergedContent: string,
  mergedEmbedding: number[],
  sourceEmbeddings: number[][],
): Promise<VerifyResult> {
  for (const sourceEmbedding of sourceEmbeddings) {
    const sim = cosineSim(mergedEmbedding, sourceEmbedding);
    if (sim < 0.65) {
      return {
        status: "flag",
        reason: "source drift below 0.65",
      };
    }
  }

  const centroid = averageEmbedding(sourceEmbeddings);
  if (cosineSim(mergedEmbedding, centroid) < 0.75) {
    return {
      status: "flag",
      reason: "centroid drift below 0.75",
    };
  }

  return { status: "accept" };
}

export async function readReviewQueue(): Promise<FlaggedMerge[]> {
  try {
    const raw = await fs.readFile(REVIEW_QUEUE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as FlaggedMerge[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

export async function addToReviewQueue(entry: FlaggedMerge): Promise<void> {
  await ensureQueueDir();
  const existing = await readReviewQueue();
  const updated = [...existing, entry];
  const tempPath = `${REVIEW_QUEUE_PATH}.tmp-${process.pid}-${Date.now()}`;

  await fs.writeFile(tempPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, REVIEW_QUEUE_PATH);
}

export async function showFlaggedMerges(): Promise<void> {
  const queue = await readReviewQueue();
  if (queue.length === 0) {
    process.stdout.write("No flagged merges pending review.\n");
    return;
  }

  process.stdout.write(`Flagged merges (${queue.length}):\n`);
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    process.stdout.write(`\n[${i + 1}] ${item.mergedType}:${item.mergedSubject}\n`);
    process.stdout.write(`Reason: ${item.flagReason}\n`);
    process.stdout.write(`Flagged at: ${item.flaggedAt}\n`);
    process.stdout.write(`Sources: ${item.sourceIds.join(", ")}\n`);
    process.stdout.write(`Merged content: ${item.mergedContent}\n`);
  }
}
