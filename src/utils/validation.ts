const SERVICE_IDENTIFIER_PATTERN = /^[a-z0-9_-]{1,64}$/;

export function isValidServiceIdentifier(value: string): boolean {
  return SERVICE_IDENTIFIER_PATTERN.test(value);
}
