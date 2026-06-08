/**
 * Loopback host names accepted as a same-origin server identity.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Outcome of the same-origin and host guard for one request.
 */
export interface OriginGuardResult {
  /** True when the request may proceed. */
  allowed: boolean;
  /** Reason a request was rejected, for logging and 403 bodies. */
  reason?: string;
}

/**
 * Enforces the v1 loopback-only, same-origin security model.
 *
 * Two protections are applied:
 *
 * 1. DNS-rebinding guard: the `Host` header must name a loopback address, so a
 *    malicious page cannot point a hostname it controls at the local server.
 * 2. Same-origin guard: when a browser supplies an `Origin` header (always the
 *    case for cross-origin and state-changing requests), it must match a
 *    loopback origin on the server's bound port. Non-browser callers that omit
 *    `Origin` (curl, the SPA's same-origin navigations) are allowed.
 *
 * @param headers - Request headers to inspect.
 * @param boundPort - The TCP port the server is bound to.
 * @returns Whether the request is allowed plus a rejection reason.
 */
export function evaluateOriginGuard(headers: { host?: string; origin?: string }, boundPort: number): OriginGuardResult {
  const host = headers.host?.trim();
  if (host && !isLoopbackAuthority(host)) {
    return { allowed: false, reason: `Rejected non-loopback Host header: ${host}.` };
  }

  const origin = headers.origin?.trim();
  if (!origin) {
    return { allowed: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { allowed: false, reason: `Rejected malformed Origin header: ${origin}.` };
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { allowed: false, reason: `Rejected cross-origin request from ${origin}.` };
  }

  const originPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : defaultPortForProtocol(parsed.protocol);
  if (originPort !== boundPort) {
    return { allowed: false, reason: `Rejected request from non-matching origin port ${originPort}.` };
  }

  return { allowed: true };
}

/**
 * Returns true when a configured bind host is restricted to loopback traffic.
 *
 * @param host - Host value supplied to `server.listen`.
 * @returns Whether the host is an accepted loopback bind address.
 */
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Returns true when a `Host` header authority names a loopback address. */
function isLoopbackAuthority(host: string): boolean {
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return isLoopbackBindHost(hostname);
}

/** Resolves the default port for an origin protocol. */
function defaultPortForProtocol(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}
