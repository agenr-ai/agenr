const MAX_ERROR_BODY_LENGTH = 200;
const SENSITIVE_PATTERNS =
  /("?(?:access_token|refresh_token|client_secret|api_key|secret|password|token)"?\s*[:=]\s*"?)([^"&\s]{4})[^"&\s]*/gi;

export function sanitizeProviderResponse(body: string): string {
  const truncated =
    body.length > MAX_ERROR_BODY_LENGTH ? `${body.slice(0, MAX_ERROR_BODY_LENGTH)}...[truncated]` : body;
  return truncated.replace(SENSITIVE_PATTERNS, "$1$2***REDACTED***");
}
