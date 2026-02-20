import fs from "node:fs/promises";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createScopedProjectConfig } from "../helpers/scoped-config.js";

const clients: Client[] = [];
const tempDirs: string[] = [];

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

async function insertEntry(
  client: Client,
  params: { id: string; project: string; subject: string; content: string },
): Promise<void> {
  const createdAt = new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, canonical_key, content, importance, expiry, scope, platform, project, source_file, source_context,
        embedding, content_hash, created_at, updated_at, retired
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
    args: [
      params.id,
      "fact",
      params.subject,
      params.subject.toLowerCase().replace(/\s+/g, "-"),
      params.content,
      8,
      "permanent",
      "private",
      "codex",
      params.project,
      "project-scope.test.jsonl",
      "integration test",
      null,
      `hash-${params.id}`,
      createdAt,
      createdAt,
    ],
  });
}

function getToolText(response: unknown): string {
  const payload = response as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  return payload.result?.content?.[0]?.text ?? "";
}

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("integration: MCP project scoping", () => {
  it("uses configured project scope and dependencies when project is omitted", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, {
      id: "frontend-1",
      project: "frontend",
      subject: "Frontend decision",
      content: "Frontend memory",
    });
    await insertEntry(client, {
      id: "api-1",
      project: "api-service",
      subject: "API decision",
      content: "API memory",
    });
    await insertEntry(client, {
      id: "other-1",
      project: "billing",
      subject: "Billing decision",
      content: "Billing memory",
    });

    const scopedDir = await createScopedProjectConfig(
      {
        project: "frontend",
        dependencies: ["api-service"],
      },
      { tempDirs, prefix: "agenr-scope-it-" },
    );

    const server = createMcpServer(
      {
        env: { ...process.env, AGENR_PROJECT_DIR: scopedDir },
      },
      {
        readConfigFn: () => ({ db: { path: ":memory:" } }),
        resolveEmbeddingApiKeyFn: () => "sk-test",
        getDbFn: () => client,
        initDbFn: async () => undefined,
        closeDbFn: () => undefined,
      },
    );

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          context: "session-start",
          limit: 10,
        },
      },
    });

    const text = getToolText(response);
    expect(text).toContain("Frontend memory");
    expect(text).toContain("API memory");
    expect(text).not.toContain("Billing memory");
    await server.stop();
  });

  it("project='*' bypasses configured project scope", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, {
      id: "frontend-1",
      project: "frontend",
      subject: "Frontend decision",
      content: "Frontend memory",
    });
    await insertEntry(client, {
      id: "billing-1",
      project: "billing",
      subject: "Billing decision",
      content: "Billing memory",
    });

    const scopedDir = await createScopedProjectConfig({ project: "frontend" }, { tempDirs, prefix: "agenr-scope-it-" });
    const server = createMcpServer(
      {
        env: { ...process.env, AGENR_PROJECT_DIR: scopedDir },
      },
      {
        readConfigFn: () => ({ db: { path: ":memory:" } }),
        resolveEmbeddingApiKeyFn: () => "sk-test",
        getDbFn: () => client,
        initDbFn: async () => undefined,
        closeDbFn: () => undefined,
      },
    );

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          context: "session-start",
          limit: 10,
          project: "*",
        },
      },
    });

    const text = getToolText(response);
    expect(text).toContain("Frontend memory");
    expect(text).toContain("Billing memory");
    await server.stop();
  });

  it("returns only own project entries when dependency has no entries", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, {
      id: "frontend-1",
      project: "frontend",
      subject: "Frontend fact",
      content: "Frontend memory",
    });
    await insertEntry(client, {
      id: "billing-1",
      project: "billing",
      subject: "Billing fact",
      content: "Billing memory",
    });

    const scopedDir = await createScopedProjectConfig(
      {
        project: "frontend",
        dependencies: ["ghost-project"],
      },
      { tempDirs, prefix: "agenr-scope-it-" },
    );
    const server = createMcpServer(
      {
        env: { ...process.env, AGENR_PROJECT_DIR: scopedDir },
      },
      {
        readConfigFn: () => ({ db: { path: ":memory:" } }),
        resolveEmbeddingApiKeyFn: () => "sk-test",
        getDbFn: () => client,
        initDbFn: async () => undefined,
        closeDbFn: () => undefined,
      },
    );

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          context: "session-start",
          limit: 10,
        },
      },
    });

    const text = getToolText(response);
    expect(text).toContain("Frontend memory");
    expect(text).not.toContain("Billing memory");
    await server.stop();
  });
});
