import { Command } from "commander";

import { APP_VERSION } from "../version.js";
import { banner } from "../ui.js";
import { registerDbCommand } from "./commands/db.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerInitCommand } from "./commands/init/index.js";
import { registerRecallCommand } from "./commands/recall.js";
import { registerSetupCommand } from "./commands/setup.js";

/**
 * Creates the root CLI program and applies global agenr metadata.
 *
 * @returns Configured Commander program instance.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("agenr")
    .description("Agent memory - local-first knowledge infrastructure for AI agents")
    .version(APP_VERSION)
    .addHelpText("beforeAll", `${banner()}\n\n`);

  registerIngestCommand(program);
  registerDbCommand(program);
  registerRecallCommand(program);
  registerSetupCommand(program);
  registerInitCommand(program);

  // Commands will be registered here as modules are built:
  // registerStoreCommand(program);
  // registerRetireCommand(program);
  // registerUpdateCommand(program);
  // registerTraceCommand(program);
  // registerSurgeonCommand(program);
  // registerMcpCommand(program);
  // registerConfigCommand(program);

  return program;
}
