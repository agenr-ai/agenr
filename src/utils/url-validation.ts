const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function validateAdapterUrl(url: string): void {
  if (process.env.AGENR_ALLOW_HTTP === "1") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid adapter base URL: ${url}`);
  }

  if (parsed.protocol === "https:" || LOCALHOST_HOSTS.has(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Adapter base URL must use HTTPS (got ${parsed.protocol}). Set AGENR_ALLOW_HTTP=1 for local dev.`,
  );
}
