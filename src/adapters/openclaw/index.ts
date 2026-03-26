/**
 * OpenClaw plugin adapter - entry point.
 *
 * This adapter translates OpenClaw's plugin API into calls to agenr core.
 * It will be loaded by OpenClaw via the plugin.load.paths config.
 */

// Plugin registration will be implemented when the core modules are ready.
// For now, this is a placeholder to ensure the build entry point exists.

/** Stable plugin identifier used by OpenClaw for registration. */
export const id = "agenr";

/** Human-readable plugin name exposed by the adapter. */
export const name = "agenr";

/** Current version of the OpenClaw adapter package. */
export const version = "0.1.0";

export { OpenClawTranscriptParser, openClawTranscriptParser } from "./transcript/parser.js";
