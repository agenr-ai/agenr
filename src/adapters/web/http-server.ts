import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DreamingRunCoordinator } from "../../app/web/dreaming-coordinator.js";
import type { InstanceRegistryOptions } from "../../app/web/instance-registry.js";
import { toErrorResponse, WebApiError } from "./api-error.js";
import { buildWebRoutes } from "./routes/index.js";
import { WebRouter, type WebHttpMethod, type WebRequestContext, type WebRoute } from "./router.js";
import { evaluateOriginGuard, isLoopbackBindHost } from "./same-origin.js";
import { SseConnection } from "./sse.js";
import { StaticAssetServer } from "./static-assets.js";

/** Maximum accepted request body size in bytes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** HTTP methods the router understands. */
const SUPPORTED_METHODS = new Set<WebHttpMethod>(["GET", "POST", "PUT", "DELETE"]);

/**
 * Options accepted when starting the local operator web server.
 */
export interface WebServerOptions {
  /** Bind host. Must be a loopback address. Defaults to `127.0.0.1`. */
  host?: string;
  /** Bind port. `0` selects an ephemeral port. Defaults to `4319`. */
  port?: number;
  /** Built SPA asset directory served for non-API routes. */
  staticDir?: string;
  /** Registry file options for instance resolution. */
  registryOptions?: InstanceRegistryOptions;
  /** Coordinator for UI-initiated dreaming runs. Created when omitted. */
  coordinator?: DreamingRunCoordinator;
  /** Environment map used for instance config resolution. */
  env?: NodeJS.ProcessEnv;
  /** Structured log sink for server lifecycle and rejections. */
  logger?: (message: string) => void;
}

/**
 * Handle to a running web server.
 */
export interface WebServerHandle {
  /** Resolved bind host. */
  host: string;
  /** Resolved bind port. */
  port: number;
  /** Fully-qualified base URL. */
  url: string;
  /** The dreaming coordinator backing live runs. */
  coordinator: DreamingRunCoordinator;
  /** Stops accepting connections and resolves once closed. */
  close: () => Promise<void>;
}

/**
 * Starts the local-only operator web server.
 *
 * Binds to a loopback address, enforces the same-origin guard on every
 * request, dispatches API routes, and serves the SPA shell for everything
 * else. Resolves once the socket is listening.
 *
 * @param options - Bind, asset, and dependency options.
 * @returns A handle exposing the resolved address and a close function.
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackBindHost(host)) {
    throw new Error(`Web console host must be a loopback address, received "${host}".`);
  }

  const requestedPort = options.port ?? 4319;
  const coordinator = options.coordinator ?? new DreamingRunCoordinator();
  const router = new WebRouter(buildWebRoutes());
  const staticServer = options.staticDir ? new StaticAssetServer(options.staticDir) : null;
  const env = options.env ?? options.registryOptions?.env ?? process.env;
  const services = {
    registryOptions: { ...(options.registryOptions ?? {}), env },
    coordinator,
    env,
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res, { router, staticServer, services, logger: options.logger });
  });

  await listen(server, requestedPort, host);
  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}`;

  return {
    host,
    port,
    url,
    coordinator,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Dependencies threaded into each request. */
interface RequestDependencies {
  router: WebRouter;
  staticServer: StaticAssetServer | null;
  services: { registryOptions: InstanceRegistryOptions; coordinator: DreamingRunCoordinator; env: NodeJS.ProcessEnv };
  logger?: (message: string) => void;
}

/** Routes one request through the guard, router, and static fallback. */
async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: RequestDependencies): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const port = (req.socket.address() as AddressInfo).port;

  const guard = evaluateOriginGuard({ host: req.headers.host, origin: req.headers.origin }, port);
  if (!guard.allowed) {
    deps.logger?.(guard.reason ?? "Rejected request by origin guard.");
    sendJson(res, 403, { status: "error", error: { code: "forbidden", message: "Request rejected by the loopback security guard." } });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await dispatchApi(req, res, url, deps);
    return;
  }

  if (deps.staticServer && req.method === "GET") {
    const served = await deps.staticServer.serve(url.pathname, res);
    if (served) {
      return;
    }
  }

  sendJson(res, 404, { status: "error", error: { code: "not_found", message: `No route for ${url.pathname}.` } });
}

/** Matches and invokes an API route, serializing JSON or streaming SSE. */
async function dispatchApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: RequestDependencies): Promise<void> {
  const method = req.method ?? "GET";
  if (!SUPPORTED_METHODS.has(method as WebHttpMethod)) {
    sendError(res, new WebApiError(405, "invalid_request", `Unsupported method: ${method}.`));
    return;
  }

  let match: ReturnType<WebRouter["match"]>;
  try {
    match = deps.router.match(method, url.pathname);
  } catch (error) {
    sendError(res, error);
    return;
  }

  if (!match) {
    sendError(res, WebApiError.notFound(`No route for ${method} ${url.pathname}.`));
    return;
  }

  const ctx = buildContext(req, url, match.params, method as WebHttpMethod, deps);

  if (match.route.kind === "sse") {
    await invokeSse(match.route, ctx, res, deps);
    return;
  }

  try {
    const result = await match.route.handler(ctx);
    sendJson(res, result.status, result.body);
  } catch (error) {
    if (!(error instanceof WebApiError)) {
      deps.logger?.(`Unhandled route error: ${error instanceof Error ? error.message : String(error)}`);
    }
    sendError(res, error);
  }
}

/** Opens an SSE connection and runs the streaming handler. */
async function invokeSse(route: Extract<WebRoute, { kind: "sse" }>, ctx: WebRequestContext, res: ServerResponse, deps: RequestDependencies): Promise<void> {
  const stream = new SseConnection(res);
  try {
    await route.handler(ctx, stream);
  } catch (error) {
    deps.logger?.(`SSE handler error: ${error instanceof Error ? error.message : String(error)}`);
    stream.send("error", { message: "Stream failed." });
    stream.close();
  }
}

/** Builds the per-request context with a lazy JSON body reader. */
function buildContext(req: IncomingMessage, url: URL, params: Record<string, string>, method: WebHttpMethod, deps: RequestDependencies): WebRequestContext {
  let cached: Promise<unknown> | null = null;
  return {
    url,
    params,
    method,
    registryOptions: deps.services.registryOptions,
    coordinator: deps.services.coordinator,
    env: deps.services.env,
    readJson: () => {
      cached ??= readJsonBody(req);
      return cached;
    },
  };
}

/** Reads and JSON-parses the request body, bounding its size. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new WebApiError(413, "invalid_request", "Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (total === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new WebApiError(400, "invalid_request", "Request body must be valid JSON.");
  }
}

/** Begins listening, rejecting on bind error. */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Serializes a JSON response body with a stable content type. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

/** Serializes a thrown value into the standard error envelope. */
function sendError(res: ServerResponse, error: unknown): void {
  const { statusCode, body } = toErrorResponse(error);
  sendJson(res, statusCode, body);
}
