const DEV_ALWAYS_ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

export function matchesDomain(hostname: string, allowedDomains: string[]): boolean {
  const normalizedHostname = normalizeDomain(hostname);

  if (!normalizedHostname) {
    return false;
  }

  if (process.env.NODE_ENV !== "production" && DEV_ALWAYS_ALLOWED_HOSTNAMES.has(normalizedHostname)) {
    return true;
  }

  if (allowedDomains.length === 0) {
    return false;
  }

  for (const allowedDomain of allowedDomains) {
    const normalizedAllowedDomain = normalizeDomain(allowedDomain);

    if (!normalizedAllowedDomain) {
      continue;
    }

    if (normalizedAllowedDomain.startsWith("*.")) {
      const baseDomain = normalizedAllowedDomain.slice(2);
      if (!baseDomain) {
        continue;
      }

      if (normalizedHostname.endsWith(`.${baseDomain}`)) {
        return true;
      }

      continue;
    }

    if (normalizedHostname === normalizedAllowedDomain) {
      return true;
    }
  }

  return false;
}

export class DomainNotAllowedError extends Error {
  constructor(hostname: string, platform: string) {
    super(`Domain '${hostname}' is not in the allowlist for adapter '${platform}'`);
    this.name = "DomainNotAllowedError";
  }
}
