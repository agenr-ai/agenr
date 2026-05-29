/** Parses a required or optional string parameter from model-supplied args. */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`${options.label ?? key} is required.`);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${options.label ?? key} must be a string.`);
  }

  const normalized = options.trim === false ? value : value.trim();
  if (options.required && normalized.length === 0) {
    throw new Error(`${options.label ?? key} is required.`);
  }

  return normalized.length > 0 || options.trim === false ? normalized : undefined;
}

/** Parses an optional number parameter from model-supplied args. */
export function readNumberParam(params: Record<string, unknown>, key: string, options: { integer?: boolean; strict?: boolean } = {}): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }

  if (options.strict && value < 0) {
    throw new Error(`${key} must be non-negative.`);
  }

  return value;
}

/** Parses an optional string-array parameter from model-supplied args. */
export function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }

  return value;
}
