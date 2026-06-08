import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/adapters/db/client.js";
import { startWebServer, type WebServerHandle } from "../../../src/adapters/web/http-server.js";
import { registerInstance, type InstanceRegistryOptions } from "../../../src/app/web/instance-registry.js";
import { removeTestPath } from "../../helpers/temp-paths.js";

/** Minimal raw HTTP response shape captured by the test client. */
interface RawResponse {
  status: number;
  body: unknown;
}

/** Issues a raw HTTP request so forbidden headers like Origin/Host are honored. */
function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

const servers: WebServerHandle[] = [];
const tempRoots: string[] = [];

/** Spins up a server backed by a fresh temp DB and a selected instance. */
async function startTestServer(): Promise<{ server: WebServerHandle; root: string; logs: string[]; registryOptions: InstanceRegistryOptions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenr-web-"));
  tempRoots.push(root);

  const dbPath = path.join(root, "knowledge.db");
  const database = await createDatabase(dbPath);
  await database.close();

  const env: NodeJS.ProcessEnv = { ...process.env, AGENR_CONFIG_DIR: root };
  delete env.AGENR_DB_PATH;
  delete env.AGENR_CONFIG_PATH;

  const registryOptions: InstanceRegistryOptions = { registryPath: path.join(root, "web-instances.json"), env };
  await registerInstance({ name: "Test", dbPath }, registryOptions);

  const logs: string[] = [];
  const server = await startWebServer({ host: "127.0.0.1", port: 0, registryOptions, env, logger: (message) => logs.push(message) });
  servers.push(server);

  return { server, root, logs, registryOptions };
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
  while (tempRoots.length > 0) {
    await removeTestPath(tempRoots.pop()!);
  }
});

describe("startWebServer", () => {
  it("lists the registered instance and reports the selection", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/instances`);
    expect(response.status).toBe(200);

    const body = response.body as { instances: Array<{ record: { id: string }; dbExists: boolean }>; selectedId: string | null };
    expect(body.selectedId).toBe("test");
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0].record.id).toBe("test");
    expect(body.instances[0].dbExists).toBe(true);
  });

  it("serves the cockpit snapshot from a fresh corpus", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/cockpit`);
    expect(response.status).toBe(200);

    const body = response.body as { health: unknown; recentRuns: unknown[]; backlog: { total: number } };
    expect(body.health).toBeDefined();
    expect(Array.isArray(body.recentRuns)).toBe(true);
    expect(body.backlog.total).toBe(0);
  });

  it("registers a new instance over HTTP and selects it", async () => {
    const { server, root } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Second", dbPath: path.join(root, "second.db") }),
    });

    expect(response.status).toBe(201);
    const body = response.body as { instances: unknown[]; selectedId: string | null };
    expect(body.instances).toHaveLength(2);
    expect(body.selectedId).toBe("second");
  });

  it("rejects a cross-origin browser write with 403", async () => {
    const { server, logs } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/dream/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ tier: "light" }),
    });

    expect(response.status).toBe(403);
    const body = response.body as { status: string; error: { code: string } };
    expect(body.error.code).toBe("forbidden");
    expect(logs.some((line) => line.includes("cross-origin"))).toBe(true);
  });

  it("rejects a non-loopback Host header with 403", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/instances`, {
      headers: { host: "attacker.example.com" },
    });

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects non-loopback bind hosts before listening", async () => {
    await expect(startWebServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/loopback/u);
  });

  it("uses the server env for selected-instance resolution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-web-env-"));
    tempRoots.push(root);

    const dbPath = path.join(root, "selected.db");
    const database = await createDatabase(dbPath);
    await database.close();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENR_CONFIG_DIR: root,
      AGENR_DB_PATH: dbPath,
    };
    delete env.AGENR_CONFIG_PATH;

    const registryPath = path.join(root, "web-instances.json");
    await registerInstance({ name: "Env Selected" }, { registryPath, env });
    const server = await startWebServer({ host: "127.0.0.1", port: 0, registryOptions: { registryPath }, env });
    servers.push(server);

    const response = await rawRequest(`${server.url}/api/web/instance`);
    expect(response.status).toBe(200);
    const body = response.body as { selected: { dbPath: string | null; dbExists: boolean } | null };
    expect(body.selected?.dbPath).toBe(dbPath);
    expect(body.selected?.dbExists).toBe(true);
  });

  it("returns a structured 404 for unknown API routes", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/does-not-exist`);
    expect(response.status).toBe(404);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns a structured 404 for non-API paths when no SPA is mounted", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/dashboard`);
    expect(response.status).toBe(404);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("rejects unsupported HTTP methods on the API namespace with 405", async () => {
    const { server } = await startTestServer();

    const response = await rawRequest(`${server.url}/api/web/instances`, { method: "PATCH" });
    expect(response.status).toBe(405);
  });
});
