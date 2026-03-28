import type { Command } from "commander";

import { runInitWizard } from "./wizard.js";

/**
 * Registers the `agenr init` command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Run the first-run onboarding wizard, including optional OpenClaw setup")
    .action(async () => {
      await runInitWizard();
    });
}
