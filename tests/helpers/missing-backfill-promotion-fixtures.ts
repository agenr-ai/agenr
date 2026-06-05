import type { Client } from "@libsql/client";
import { insertDurable } from "./dreaming-reconcile.js";

/**
 * Seeds the changelog source-of-truth promotion family used by compaction tests.
 */
export async function seedChangelogSourceOfTruthFamily(client: Client): Promise<void> {
  await insertDurable(client, {
    id: "changelog-seed-workflow",
    type: "decision",
    subject: "Changelog publish workflow",
    claim_key: "changelog/publish_workflow",
    tags: ["release", "docs"],
    source_context: "CHANGELOG.md governs release note operations",
    content: "Release notes are published from CHANGELOG.md.",
  });
  await insertDurable(client, {
    id: "changelog-seed-policy",
    type: "decision",
    subject: "Changelog archive policy",
    claim_key: "changelog/archive_policy",
    tags: ["release", "docs"],
    source_context: "CHANGELOG.md governs release note operations",
    content: "Archive old release notes only after they are copied into CHANGELOG.md.",
  });
  await insertDurable(client, {
    id: "changelog-supported",
    subject: "Release note authority",
    type: "decision",
    tags: ["release", "docs"],
    source_context: "CHANGELOG.md governs release note operations",
    content: "CHANGELOG.md is the authoritative source of truth for release notes.",
  });
}

/**
 * Seeds the OpenClaw ordering family with two supporting durables and one target candidate.
 */
export async function seedOpenclawOrderingFamily(
  client: Client,
  target: {
    id: string;
    subject?: string;
    content?: string;
  },
): Promise<void> {
  await insertDurable(client, {
    id: "openclaw-seed-order",
    subject: "LLM handoff order seed",
    type: "decision",
    claim_key: "openclaw/llm_handoff_order",
    tags: ["openclaw", "workflow"],
    source_context: "OpenClaw runtime docs define hook ordering",
    content: "OpenClaw keeps heartbeat detection ahead of LLM handoff.",
  });
  await insertDurable(client, {
    id: "openclaw-seed-contract",
    subject: "Memory surface contract",
    type: "decision",
    claim_key: "openclaw/memory_surface_contract",
    tags: ["openclaw", "workflow"],
    source_context: "OpenClaw runtime docs define hook ordering",
    content: "OpenClaw exposes a stable memory surface contract to the host.",
  });
  await insertDurable(client, {
    id: target.id,
    subject: target.subject ?? "Heartbeat handoff ordering",
    type: "decision",
    tags: ["openclaw", "workflow"],
    source_context: "OpenClaw runtime docs define hook ordering",
    content: target.content ?? "Heartbeat detection should happen before LLM handoff in OpenClaw.",
  });
}

/**
 * Seeds the Jim handoff family with two supporting durables and one target candidate.
 */
export async function seedJimHandoffFamily(
  client: Client,
  target: {
    id: string;
    subject?: string;
    content?: string;
  },
): Promise<void> {
  await insertDurable(client, {
    id: "jim-seed-workspace",
    subject: "Jim workspace",
    type: "preference",
    claim_key: "jim/primary_workspace",
    tags: ["workflow", "handoff"],
    source_context: "Jim workflow guide",
    content: "Jim's primary workspace is the agenr repo.",
  });
  await insertDurable(client, {
    id: "jim-seed-review",
    subject: "Jim review preference",
    type: "preference",
    claim_key: "jim/code_review_preference",
    tags: ["workflow", "handoff"],
    source_context: "Jim workflow guide",
    content: "Jim prefers short review loops before handoffs.",
  });
  await insertDurable(client, {
    id: target.id,
    subject: target.subject ?? "Jim handoff preference",
    type: "preference",
    tags: ["workflow", "handoff"],
    source_context: "Jim workflow guide",
    content: target.content ?? "Jim prefers a code task handoff note before work changes owners.",
  });
}

/**
 * Seeds the Jim handoff family with one grounded sibling for relaxed stable-slot tests.
 */
export async function seedJimSingleSiblingHandoffFamily(client: Client): Promise<void> {
  await insertDurable(client, {
    id: "jim-seed-primary-workspace",
    subject: "Jim workspace",
    type: "preference",
    claim_key: "jim/primary_workspace",
    tags: ["workflow", "handoff"],
    source_context: "Jim workflow guide",
    content: "Jim's primary workspace is the agenr repo.",
  });
  await insertDurable(client, {
    id: "jim-single-sibling-slot",
    subject: "Jim code task handoff preference",
    type: "preference",
    tags: ["workflow", "handoff"],
    source_context: "Jim workflow guide",
    content: "Jim prefers a code task handoff note before work changes owners.",
  });
}
