import type { ZodType } from "zod";

type ModelMessageLike = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  name?: string;
  toolCallId?: string;
};

type StructuredGenerationRequest<T> = {
  messages: ModelMessageLike[];
  schema: ZodType<T>;
  schemaName?: string | undefined;
  schemaDescription?: string | undefined;
  strict?: boolean;
  abortSignal?: AbortSignal | undefined;
};

type StructuredGenerationArgs<T> = StructuredGenerationRequest<T> & {
  model: {
    id: string;
    provider: string;
    model: string;
  };
};

type StructuredGenerationResult<T> = {
  object: T;
  rawResponse?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
};

type Resolver = <T>(args: StructuredGenerationArgs<T>, index: number) => unknown;

type MockModelOptions = {
  id?: string;
  provider?: string;
  model?: string;
  responses?: unknown[];
  resolver?: Resolver;
};

function resolveOptions(input?: MockModelOptions | unknown[] | Resolver): MockModelOptions {
  if (Array.isArray(input)) {
    return {
      responses: input.slice(),
    };
  }

  if (typeof input === "function") {
    return {
      resolver: input,
    };
  }

  return input ?? {};
}

export function mockModel(input?: MockModelOptions | unknown[] | Resolver) {
  const options = resolveOptions(input);
  const queue = [...(options.responses ?? [])];
  const calls: Array<StructuredGenerationArgs<unknown>> = [];

  async function nextResponse<T>(
    args: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const callArgs = {
      ...args,
      model: {
        id: options.id ?? "mock-model",
        provider: options.provider ?? "mock",
        model: options.model ?? "mock-model",
      },
    } satisfies StructuredGenerationArgs<T>;
    calls.push(callArgs as StructuredGenerationArgs<unknown>);
    const index = calls.length - 1;
    const candidate =
      options.resolver != null ? await options.resolver(callArgs, index) : queue.shift();

    if (candidate === undefined) {
      throw new Error(`mockModel ran out of queued responses at call ${index + 1}.`);
    }

    const object = args.schema.parse(candidate);
    return {
      object,
      rawResponse: {
        mocked: true,
        index,
        candidate,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      finishReason: "stop",
    };
  }

  return {
    id: options.id ?? "mock-model",
    provider: options.provider ?? "mock",
    model: options.model ?? "mock-model",
    calls,
    structured: nextResponse,
    generateObject: nextResponse,
  };
}
