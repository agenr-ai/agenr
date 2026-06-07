import { Option, type Command } from "commander";

import { loadDurableTraceRuntime } from "../../app/memory/inspect.js";
import { renderDurableTraceJson, renderDurableTraceText } from "../../app/memory/render-trace.js";

/** Commander options accepted by the `agenr trace` command. */
interface TraceCommandOptions {
  id?: string;
  subject?: string;
  last?: boolean;
  json?: boolean;
}

/**
 * Registers the `agenr trace` CLI command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace")
    .description("Inspect one durable's provenance, lineage, dreaming audit trail, and recall history")
    .addOption(new Option("--id <id>", "Durable id to inspect"))
    .addOption(new Option("--subject <text>", "Subject text to resolve when the id is unknown"))
    .option("--last", "Inspect the most recently created durable")
    .option("--json", "Emit structured JSON output")
    .action(async (options: TraceCommandOptions) => {
      try {
        const trace = await loadDurableTraceRuntime({
          id: options.id,
          subject: options.subject,
          last: options.last === true,
          env: process.env,
        });
        process.stdout.write(options.json === true ? renderDurableTraceJson(trace) : renderDurableTraceText(trace));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load trace: ${formatUnknownError(error)}\n`);
      }
    });
}

/**
 * Converts unknown thrown values into displayable error text.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
