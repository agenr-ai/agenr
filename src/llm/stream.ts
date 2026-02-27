import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { registerBuiltInApiProviders, streamSimple } from "@mariozechner/pi-ai";

// Ensure pi-ai API providers are registered so streamSimple can resolve them.
let _apiProvidersRegistered = false;
function ensureApiProviders(): void {
  if (_apiProvidersRegistered) return;
  registerBuiltInApiProviders();
  _apiProvidersRegistered = true;
}

export type SimpleAssistantStream = AsyncIterable<AssistantMessageEvent> & {
  result: () => Promise<AssistantMessage>;
};

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => SimpleAssistantStream;

export interface StreamRunParams {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
  verbose: boolean;
  streamSimpleImpl?: StreamSimpleFn;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
}

function logVerbose(params: StreamRunParams, line: string): void {
  if (!params.verbose) {
    return;
  }
  const logger = params.onVerbose ?? ((message: string) => process.stderr.write(`${message}\n`));
  logger(line);
}

export async function runSimpleStream(params: StreamRunParams): Promise<AssistantMessage> {
  const streamFn = params.streamSimpleImpl ?? streamSimple;
  if (!params.streamSimpleImpl) {
    ensureApiProviders();
  }
  const stream = streamFn(params.model, params.context, params.options);

  for await (const event of stream) {
    if (!params.verbose) {
      continue;
    }

    if (event.type === "thinking_start") {
      logVerbose(params, "[thinking]");
    } else if (event.type === "thinking_delta") {
      params.onStreamDelta?.(event.delta, "thinking");
    } else if (event.type === "thinking_end") {
      logVerbose(params, "[/thinking]");
    } else if (event.type === "text_delta") {
      params.onStreamDelta?.(event.delta, "text");
    } else if (event.type === "toolcall_delta") {
      params.onStreamDelta?.(event.delta, "text");
    } else if (event.type === "error") {
      logVerbose(params, `[error:${event.reason}] ${event.error.errorMessage ?? "unknown error"}`);
    }
  }

  return stream.result();
}
