import type { IncomingMessage, ServerResponse } from "node:http";

import type { DreamingRunCoordinator } from "../../app/web/dreaming-coordinator.js";
import type { InstanceRegistryOptions } from "../../app/web/instance-registry.js";
import { WebApiError } from "./api-error.js";
import type { SseConnection } from "./sse.js";

/** HTTP methods routed by the web API. */
export type WebHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Shared dependencies available to every route handler.
 */
export interface WebRouteServices {
  /** Resolved registry file options for instance lookups. */
  registryOptions: InstanceRegistryOptions;
  /** In-process coordinator for UI-initiated dreaming runs. */
  coordinator: DreamingRunCoordinator;
  /** Process environment used for instance config resolution. */
  env: NodeJS.ProcessEnv;
}

/**
 * Per-request context passed to route handlers.
 */
export interface WebRequestContext extends WebRouteServices {
  /** Parsed request URL. */
  url: URL;
  /** Matched path parameters by name. */
  params: Record<string, string>;
  /** Request HTTP method. */
  method: WebHttpMethod;
  /** Reads and JSON-parses the request body, throwing a 400 on malformed JSON. */
  readJson: () => Promise<unknown>;
}

/**
 * Result returned by JSON route handlers before serialization.
 */
export interface JsonRouteResult<TBody = unknown> {
  /** HTTP status code to send. */
  status: number;
  /** JSON-serializable response payload. */
  body: TBody;
}

/** Handler signature for JSON routes. */
export type JsonRouteHandler<TBody = unknown> = (ctx: WebRequestContext) => Promise<JsonRouteResult<TBody>> | JsonRouteResult<TBody>;

/** Handler signature for server-sent-event routes. */
export type SseRouteHandler = (ctx: WebRequestContext, stream: SseConnection) => void | Promise<void>;

/**
 * Route definition discriminated by transport kind.
 */
export type WebRoute =
  | { kind: "json"; method: WebHttpMethod; pattern: string; handler: JsonRouteHandler }
  | { kind: "sse"; method: WebHttpMethod; pattern: string; handler: SseRouteHandler };

/**
 * Successful match of a request against the route table.
 */
export interface RouteMatch {
  /** The matched route definition. */
  route: WebRoute;
  /** Extracted path parameters. */
  params: Record<string, string>;
}

/**
 * Compiled segment representation of a route pattern.
 */
interface CompiledRoute {
  route: WebRoute;
  segments: string[];
}

/**
 * Method- and pattern-aware router for the local web API.
 *
 * Patterns use `/api/web/...` literals with `:name` parameter segments. The
 * router intentionally avoids wildcard path captures; nested file paths are
 * passed as query parameters so route matching stays unambiguous.
 */
export class WebRouter {
  private readonly compiled: CompiledRoute[];

  /**
   * Compiles the route table into matchable segment lists.
   *
   * @param routes - Route definitions to register.
   */
  public constructor(routes: WebRoute[]) {
    this.compiled = routes.map((route) => ({ route, segments: splitPath(route.pattern) }));
  }

  /**
   * Finds the route matching a method and path.
   *
   * @param method - Request HTTP method.
   * @param pathname - Request path.
   * @returns The matched route and params, or null when no path matches.
   * @throws {WebApiError} 405 when a path matches but the method does not.
   */
  public match(method: string, pathname: string): RouteMatch | null {
    const target = splitPath(pathname);
    let pathMatchedOtherMethod = false;

    for (const entry of this.compiled) {
      const params = matchSegments(entry.segments, target);
      if (!params) {
        continue;
      }

      if (entry.route.method !== method) {
        pathMatchedOtherMethod = true;
        continue;
      }

      return { route: entry.route, params };
    }

    if (pathMatchedOtherMethod) {
      throw new WebApiError(405, "invalid_request", `Method ${method} is not allowed for ${pathname}.`);
    }

    return null;
  }
}

/** Splits a path into non-empty, decoded segments. */
function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

/**
 * Matches a compiled pattern against request segments.
 *
 * @param pattern - Compiled pattern segments.
 * @param target - Request path segments.
 * @returns Extracted params when the pattern matches, otherwise null.
 */
function matchSegments(pattern: string[], target: string[]): Record<string, string> | null {
  if (pattern.length !== target.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const patternSegment = pattern[index];
    const targetSegment = target[index];
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = targetSegment;
      continue;
    }

    if (patternSegment !== targetSegment) {
      return null;
    }
  }

  return params;
}

/** Re-export of the raw request type used by the server entry point. */
export type WebIncomingMessage = IncomingMessage;
/** Re-export of the raw response type used by the server entry point. */
export type WebServerResponse = ServerResponse;
