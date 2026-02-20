import type { Client } from "@libsql/client";
import {
  fetchNewSignalEntries,
  formatSignal,
  initializeWatermark,
  setWatermark,
} from "../db/signals.js";

export interface SignalConfig {
  minImportance: number;
  maxPerSignal: number;
}

const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  minImportance: 7,
  maxPerSignal: 5,
};

/**
 * Check for and format new signals for a consumer session.
 * Returns prependContext string or null if nothing new.
 *
 * Delivery semantics: at-least-once. The watermark is advanced after
 * fetching entries. If setWatermark fails (transient DB error), the plugin
 * hook swallows the error and the same entries may be signalled again on
 * the next turn. This is acceptable for notifications - a duplicate signal
 * is harmless.
 */
export async function checkSignals(
  db: Client,
  consumerId: string,
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): Promise<string | null> {
  const watermark = await initializeWatermark(db, consumerId);
  const batch = await fetchNewSignalEntries(db, watermark, config.minImportance, config.maxPerSignal);

  if (batch.entries.length === 0) {
    return null;
  }

  // Advance watermark BEFORE returning (fire-once guarantee).
  await setWatermark(db, consumerId, batch.maxSeq);
  return formatSignal(batch.entries);
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveSignalConfig(pluginConfig?: Record<string, unknown>): SignalConfig {
  return {
    minImportance: readNonNegativeInt(pluginConfig?.signalMinImportance, DEFAULT_SIGNAL_CONFIG.minImportance),
    maxPerSignal: readNonNegativeInt(pluginConfig?.signalMaxPerSignal, DEFAULT_SIGNAL_CONFIG.maxPerSignal),
  };
}
