import { generateObject } from "ai";
import type { z } from "zod";

import { adapters as adapterFactories } from "./adapters.js";
import { examples, splitExamples } from "./examples.js";
import { compile } from "./compile.js";
import { metric } from "./metric.js";
import { predict } from "./predict.js";
import { program } from "./program.js";
import { agent, mcp, project, rpc, tool } from "./project.js";
import { standardPIIRedactor, redactors } from "./redactors.js";
import { memory, filesystem, stores } from "./stores.js";
import { input, output, signature, text } from "./candidate.js";
import type {
  ModelHandle,
  ModelMessage,
  ModelProvider,
  Optimizer,
  RuntimeContext,
  StructuredGenerationBridge,
  StructuredGenerationResult,
} from "./types.js";

const defaultStore = memory();

const missingModelProvider: ModelProvider = {
  id: "unconfigured-model",
  async complete() {
    throw new Error("No model configured. Call so.configure({ model }) or pass a runtime model.");
  },
  async structured() {
    throw new Error("No model configured. Call so.configure({ model }) or pass a runtime model.");
  },
};

let configuredRuntime: RuntimeContext = {
  model: missingModelProvider,
  structuredGeneration: aiSdkStructuredGenerationBridge(),
  traceStore: defaultStore,
  artifactStore: defaultStore,
  redactor: standardPIIRedactor(),
  trace: {
    sampleRate: 1,
  },
};

type GenerateObjectArgs<T> = {
  model: ModelHandle | ModelProvider;
  messages: ModelMessage[];
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  strict?: boolean;
  tools?: Parameters<StructuredGenerationBridge["generateObject"]>[0]["tools"];
  abortSignal?: AbortSignal;
};

function toAiMessages(messages: ModelMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function normalizeUsage(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens =
    typeof usage.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : undefined;
  const outputTokens =
    typeof usage.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : undefined;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function isModelProvider(value: unknown): value is ModelProvider {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    (("structured" in value && typeof value.structured === "function") ||
      ("complete" in value && typeof value.complete === "function"))
  );
}

async function completeViaProvider<T>(
  model: ModelProvider,
  args: GenerateObjectArgs<T>,
): Promise<StructuredGenerationResult<T>> {
  if (model.structured) {
    const result = await model.structured({
      messages: args.messages,
      schema: args.schema,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      ...(args.schemaName ? { schemaName: args.schemaName } : {}),
      ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
      ...(args.strict !== undefined ? { strict: args.strict } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
    });

    const structured: StructuredGenerationResult<T> = {
      object: result.object as T,
    };
    if (result.rawResponse !== undefined) {
      structured.rawResponse = result.rawResponse;
    }
    if (result.usage) {
      structured.usage = result.usage;
    }
    if (result.finishReason) {
      structured.finishReason = result.finishReason;
    }
    return structured;
  }

  if (!model.complete) {
    throw new Error(`Model provider "${model.id}" cannot generate objects.`);
  }

  const response = await model.complete({
    messages: args.messages,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });
  const parsed = JSON.parse(response.text);
  const object = args.schema.parse(parsed) as T;
  const structured: StructuredGenerationResult<T> = {
    object,
  };
  if (response.rawResponse !== undefined) {
    structured.rawResponse = response.rawResponse;
  }
  if (response.usage) {
    structured.usage = response.usage;
  }
  if (response.finishReason) {
    structured.finishReason = response.finishReason;
  }
  return structured;
}

export function aiSdkStructuredGenerationBridge(): StructuredGenerationBridge {
  return {
    id: "ai-sdk-generate-object",
    async generateObject<T>(args: GenerateObjectArgs<T>) {
      if (isModelProvider(args.model)) {
        return completeViaProvider<T>(args.model, args);
      }

      const result = await generateObject({
        model: args.model as never,
        messages: toAiMessages(args.messages) as any,
        schema: args.schema,
        ...(args.schemaName ? { schemaName: args.schemaName } : {}),
        ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      } as any);

      const structured: StructuredGenerationResult<T> = {
        object: result.object as T,
      };
      if (result.response !== undefined) {
        structured.rawResponse = result.response;
      }
      const usage = normalizeUsage(result.usage);
      if (usage) {
        structured.usage = usage;
      }
      if (result.finishReason) {
        structured.finishReason = result.finishReason;
      }
      return structured;
    },
  };
}

export function providerStructuredGenerationBridge(): StructuredGenerationBridge {
  return {
    id: "provider-structured-generation",
    async generateObject<T>(args: GenerateObjectArgs<T>) {
      if (!isModelProvider(args.model)) {
        return aiSdkStructuredGenerationBridge().generateObject<T>({
          model: args.model,
          messages: args.messages,
          schema: args.schema,
          ...(args.schemaName ? { schemaName: args.schemaName } : {}),
          ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
          ...(args.strict !== undefined ? { strict: args.strict } : {}),
          ...(args.tools ? { tools: args.tools } : {}),
          ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
        });
      }

      return completeViaProvider<T>(args.model, args);
    },
  };
}

export function configure(runtime: Partial<RuntimeContext>): RuntimeContext {
  configuredRuntime = getRuntimeContext(runtime);

  return configuredRuntime;
}

export function currentRuntime(): RuntimeContext {
  return configuredRuntime;
}

export function getRuntimeContext(overrides?: Partial<RuntimeContext>): RuntimeContext {
  const result: RuntimeContext = {
    model: overrides?.model ?? configuredRuntime.model,
    structuredGeneration: overrides?.structuredGeneration ?? configuredRuntime.structuredGeneration,
    trace: {
      ...configuredRuntime.trace,
      ...overrides?.trace,
    },
  };

  const env = overrides?.env ?? configuredRuntime.env;

  const traceStore = overrides?.traceStore ?? configuredRuntime.traceStore;
  const artifactStore = overrides?.artifactStore ?? configuredRuntime.artifactStore;
  const corpora = overrides?.corpora ?? configuredRuntime.corpora;
  const redactor = overrides?.redactor ?? configuredRuntime.redactor;
  const logger = overrides?.logger ?? configuredRuntime.logger;

  if (traceStore) {
    result.traceStore = traceStore;
  }
  if (artifactStore) {
    result.artifactStore = artifactStore;
  }
  if (corpora) {
    result.corpora = corpora;
  }
  if (redactor) {
    result.redactor = redactor;
  }
  if (logger) {
    result.logger = logger;
  }
  if (env !== undefined) {
    result.env = env;
  }

  const knownKeys = new Set([
    "adapter",
    "artifactStore",
    "corpora",
    "env",
    "logger",
    "model",
    "redactor",
    "structuredGeneration",
    "trace",
    "traceStore",
  ]);

  for (const source of [configuredRuntime as Record<string, unknown>, overrides as Record<string, unknown> | undefined]) {
    if (source == null) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (knownKeys.has(key) || value === undefined) {
        continue;
      }
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

function lazyGepaFactory(config?: unknown): Optimizer<any> {
  return {
    id: "gepa",
    version: "0.1.0",
    async compile(args) {
      const mod = await import("@superobjective/optimizer-gepa");
      return mod.gepa(config as any).compile(args as any) as Promise<any>;
    },
  };
}

export const optimizers = {
  gepa: lazyGepaFactory,
};

export const adapters = adapterFactories;
export { stores, redactors, memory, filesystem, input, output, signature, text };
export {
  predict,
  program,
  tool,
  agent,
  rpc,
  mcp,
  project,
  examples,
  splitExamples,
  metric,
  compile,
};

export const runtime = {
  configure,
  currentRuntime,
  getRuntimeContext,
  aiSdkStructuredGenerationBridge,
  providerStructuredGenerationBridge,
};
