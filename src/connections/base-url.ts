export function getBaseUrl(): string {
  const explicit = process.env.AGENR_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const port = process.env.PORT ?? "3001";
  return `http://localhost:${port}`;
}
