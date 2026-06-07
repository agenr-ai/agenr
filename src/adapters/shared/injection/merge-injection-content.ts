/**
 * Merges optional injection blocks into one prompt payload.
 *
 * @param parts - Ordered injection fragments.
 * @returns Combined text when at least one fragment is non-empty.
 */
export function mergeInjectionContent(...parts: Array<string | undefined>): string | undefined {
  const merged = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  return merged.length > 0 ? merged : undefined;
}
