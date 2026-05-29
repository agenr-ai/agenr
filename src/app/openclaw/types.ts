import type { AgenrDebugSink } from "../../adapters/openclaw/debug/sink.js";
import type { AgenrOpenClawHost, AgenrOpenClawPluginConfig } from "../../adapters/openclaw/contract.js";
import type { AgenrConfig } from "../../config.js";
import type { PluginMemoryRuntimeServices, ResolvedPluginPaths } from "../plugin-runtime/types.js";

/**
 * Shared OpenClaw runtime services composed outside the adapter package.
 */
export interface AgenrOpenClawServices extends PluginMemoryRuntimeServices {
  openClaw: AgenrOpenClawHost;
  config: ResolvedPluginPaths;
  pluginConfig: AgenrOpenClawPluginConfig;
  agenrConfig: AgenrConfig;
  dbPath: string;
  /** Opt-in JSONL debug sink shared by adapter paths that emit structured events. */
  debugSink: AgenrDebugSink;
}
