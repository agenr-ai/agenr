import os from "node:os";
import path from "node:path";
import { formatRecallAsMarkdown, resolveAgenrPath, resolveBudget, runRecall } from "./recall.js";
import type {
  AgenrPluginConfig,
  BootstrapFile,
  BootstrapHookContext,
  HookEvent,
  PluginApi,
} from "./types.js";

// Path used as the ## header in Project Context for the injected memory block.
const AGENR_CONTEXT_PATH = path.join(os.homedir(), ".agenr", "AGENR.md");

// Session key substrings that indicate non-interactive sessions to skip.
const SKIP_SESSION_PATTERNS = [":subagent:", ":cron:"];

function shouldSkipSession(sessionKey: string): boolean {
  return SKIP_SESSION_PATTERNS.some((pattern) => sessionKey.includes(pattern));
}

const plugin = {
  id: "agenr",
  name: "agenr memory context",
  description: "Injects agenr long-term memory into every agent session via agent:bootstrap",

  register(api: PluginApi): void {
    api.registerHook("agent:bootstrap", async (event: HookEvent): Promise<void> => {
      try {
        const ctx = event.context as BootstrapHookContext;
        if (!Array.isArray(ctx.bootstrapFiles)) {
          return;
        }

        // Check session key from both event root and context.
        const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";

        // Skip non-interactive sessions.
        if (shouldSkipSession(sessionKey)) {
          return;
        }

        const config = api.pluginConfig as AgenrPluginConfig | undefined;
        if (config?.enabled === false) {
          return;
        }

        const agenrPath = resolveAgenrPath(config);
        const budget = resolveBudget(config);

        const result = await runRecall(agenrPath, budget);
        if (!result) {
          return;
        }

        const markdown = formatRecallAsMarkdown(result);
        if (!markdown.trim()) {
          return;
        }

        // Push synthetic bootstrap file - cast name to any since "AGENR.md" is not
        // in the WorkspaceBootstrapFileName union but runtime does not validate it.
        const file: BootstrapFile = {
          name: "AGENR.md" as unknown as never,
          path: AGENR_CONTEXT_PATH,
          content: markdown,
          missing: false,
        };

        ctx.bootstrapFiles.push(file);
      } catch {
        // Never block session start - swallow all errors silently.
      }
    });
  },
};

export default plugin;
