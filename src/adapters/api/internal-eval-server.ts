import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readConfig, type AgenrConfig } from "../../config.js";
import type { CrossEncoderPort } from "../../core/ports.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../cross-encoder/openai-cross-encoder.js";
import { resolveModel } from "../llm.js";
import { createInternalEvalRoutes } from "./internal-eval-routes.js";
import type { InternalApiRoute } from "./internal-api-route.js";

/**
 * Default loopback host for the internal eval dev server.
 */
const DEFAULT_INTERNAL_EVAL_HOST = "127.0.0.1";

/**
 * Default port for the internal eval dev server.
 */
const DEFAULT_INTERNAL_EVAL_PORT = 4010;

export { DEFAULT_INTERNAL_EVAL_HOST, DEFAULT_INTERNAL_EVAL_PORT };

/**
 * Discriminated outcome of cross-encoder resolution at server startup.
 *
 * `configured` - OpenAI credential resolved and port constructed.
 * `not_configured` - No credential available; recall reports
 *   `degradedReason: "not_configured"` for every case.
 * `error` - A credential was present but construction failed; the server
 *   continues without the port so eval execution is never blocked.
 */
export type CrossEncoderResolutionStatus = "configured" | "not_configured" | "error";

/**
 * Cross-encoder resolution result surfaced on the server handle so CLI
 * entry points can print a deterministic startup message.
 */
export interface CrossEncoderResolution {
  /** Stable status code for logging and assertions. */
  status: CrossEncoderResolutionStatus;
  /** Human-readable reason for non-configured or error statuses. */
  reason?: string;
}

/**
 * Startup options for the internal eval dev server.
 */
export interface InternalEvalServerOptions {
  /** Host interface to bind. Defaults to loopback only. */
  host?: string;
  /** TCP port to bind. Defaults to the shared local eval port. */
  port?: number;
  /** Optional route override used by tests. */
  routes?: InternalApiRoute[];
  /**
   * Optional cross-encoder port override. When provided, the server skips
   * its own `OPENAI_API_KEY` resolution and wires the injected port
   * instead. Tests use this to pin behavior without relying on process
   * environment variables.
   */
  crossEncoder?: CrossEncoderPort;
  /**
   * When false, skip the best-effort OpenAI cross-encoder construction at
   * startup. Defaults to true so production `node dist/internal-eval-server.js`
   * invocations wire the rerank stage automatically when the key is set.
   */
  autoResolveCrossEncoder?: boolean;
}

/**
 * Live handle returned after the internal eval dev server starts.
 */
export interface InternalEvalServerHandle {
  /** Bound host interface. */
  host: string;
  /** Bound TCP port. */
  port: number;
  /** Stable route paths served by this host. */
  routePaths: string[];
  /** Base URL developers should point eval harnesses at. */
  baseUrl: string;
  /**
   * Cross-encoder resolution outcome captured at startup. Exposed so the
   * CLI entry point can emit a single-line status message without
   * adapters writing to process-global logs.
   */
  crossEncoder: CrossEncoderResolution;
  /** Stops the HTTP server and releases the port. */
  close(): Promise<void>;
}

/**
 * Starts a tiny local-only HTTP server for the internal eval routes.
 *
 * @param options - Optional bind settings and test route overrides.
 * @returns Live server handle with the bound base URL and close helper.
 */
export async function startInternalEvalServer(options: InternalEvalServerOptions = {}): Promise<InternalEvalServerHandle> {
  const host = options.host ?? DEFAULT_INTERNAL_EVAL_HOST;
  const port = options.port ?? DEFAULT_INTERNAL_EVAL_PORT;
  const crossEncoderResolution = resolveCrossEncoderPort(options);
  const routes = options.routes ?? createInternalEvalRoutes({ crossEncoder: crossEncoderResolution.port });
  const server = createServer((request, response) => {
    void handleRequest(request, response, routes, host, port).catch(() => {
      if (response.headersSent !== true) {
        writeTextResponse(response, 500, "Internal server error.\n");
        return;
      }

      response.destroy();
    });
  });

  await listen(server, port, host);

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Internal eval server did not expose a TCP address.");
  }

  return {
    host,
    port: address.port,
    routePaths: routes.map((route) => route.path),
    baseUrl: `http://${formatHostForUrl(host)}:${address.port}`,
    crossEncoder: crossEncoderResolution.result,
    close: async (): Promise<void> => {
      await closeServer(server);
    },
  };
}

/**
 * Resolves the cross-encoder port used by the recall route at startup.
 *
 * Honors an explicit `options.crossEncoder` override first, then falls
 * back to a best-effort `OPENAI_API_KEY` resolution that mirrors the CLI
 * and OpenClaw runtime paths. Fails closed: any resolution failure
 * downgrades to `undefined` so missing credentials never break eval
 * execution.
 */
function resolveCrossEncoderPort(options: InternalEvalServerOptions): {
  port: CrossEncoderPort | undefined;
  result: CrossEncoderResolution;
} {
  if (options.crossEncoder) {
    return {
      port: options.crossEncoder,
      result: { status: "configured" },
    };
  }

  if (options.autoResolveCrossEncoder === false) {
    return {
      port: undefined,
      result: {
        status: "not_configured",
        reason: "Auto-resolution disabled by caller.",
      },
    };
  }

  let config: AgenrConfig;
  try {
    config = readConfig();
  } catch (error) {
    return {
      port: undefined,
      result: {
        status: "error",
        reason: toReason(error, "Failed to read agenr config for cross-encoder resolution."),
      },
    };
  }

  let apiKey: string;
  try {
    apiKey = resolveCrossEncoderApiKey(config);
  } catch (error) {
    return {
      port: undefined,
      result: {
        status: "not_configured",
        reason: toReason(error, "OPENAI_API_KEY not configured."),
      },
    };
  }

  try {
    const { modelId } = resolveModel(config, "cross_encoder");
    return {
      port: createOpenAICrossEncoder({ apiKey, model: modelId }),
      result: { status: "configured" },
    };
  } catch (error) {
    return {
      port: undefined,
      result: {
        status: "error",
        reason: toReason(error, "Failed to construct OpenAI cross-encoder adapter."),
      },
    };
  }
}

/** Normalizes thrown errors into a stable reason string for server-start logs. */
function toReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
}

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  routes: InternalApiRoute[],
  fallbackHost: string,
  fallbackPort: number,
): Promise<void> => {
  const requestUrl = new URL(request.url ?? "/", `http://${formatHostForUrl(fallbackHost)}:${request.socket.localPort ?? fallbackPort}`);
  const route = routes.find((candidate) => candidate.path === requestUrl.pathname);

  if (!route) {
    writeTextResponse(response, 404, "Not found.\n");
    return;
  }

  if (request.method !== route.method) {
    response.statusCode = 405;
    response.setHeader("allow", route.method);
    response.end();
    return;
  }

  const body = await readBody(request);
  const routeRequest = new Request(requestUrl, {
    method: route.method,
    headers: toHeaders(request),
    body: body.length > 0 ? body : undefined,
  });
  const routeResponse = await route.handler(routeRequest);
  await writeRouteResponse(response, routeResponse);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
};

const toHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  return headers;
};

const writeRouteResponse = async (response: ServerResponse, routeResponse: Response): Promise<void> => {
  response.statusCode = routeResponse.status;

  for (const [name, value] of routeResponse.headers) {
    response.setHeader(name, value);
  }

  const body = Buffer.from(await routeResponse.arrayBuffer());
  response.end(body);
};

const writeTextResponse = (response: ServerResponse, status: number, body: string): void => {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
};

const listen = async (server: Server, port: number, host: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
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
};

const closeServer = async (server: Server): Promise<void> => {
  if (server.listening !== true) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const formatHostForUrl = (host: string): string => {
  if (host.includes(":") && host.startsWith("[") !== true) {
    return `[${host}]`;
  }

  return host;
};
