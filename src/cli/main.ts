import { Command } from "commander";

/**
 * Creates the root CLI program and applies global agenr metadata.
 *
 * @returns Configured Commander program instance.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("agenr")
    .description("Agent memory — local-first knowledge infrastructure for AI agents")
    .version("0.1.0");

  // Commands will be registered here as modules are built:
  // registerIngestCommand(program);
  // registerRecallCommand(program);
  // registerStoreCommand(program);
  // registerRetireCommand(program);
  // registerUpdateCommand(program);
  // registerTraceCommand(program);
  // registerSurgeonCommand(program);
  // registerMcpCommand(program);
  // registerDbCommand(program);
  // registerSetupCommand(program);
  // registerConfigCommand(program);

  return program;
}
