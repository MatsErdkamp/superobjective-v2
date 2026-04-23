import { generateObject } from "ai";
import { z } from "zod";

import {
  R2BackedArtifactStore,
  R2BackedTraceStore,
  createMemoryArtifactStore,
  createMemoryTraceStore,
  createPrototypeArtifactStore,
  createPrototypeTraceStore,
  createR2BlobStore,
  createR2ArtifactStore,
  createR2TraceStore,
  createSqliteArtifactStore,
  createSqliteTraceStore,
} from "./stores";
import { createCloudflareHost } from "./app";
import {
  bindProjectCorporaRuntime,
  createCorpusProvider,
  createListCorpusFilesTool,
  createProjectCorpusProvider,
  createReadCorpusFileTool,
  createSearchCorpusTool,
  mergeCorpusProviders,
  prepareCorpusContext,
} from "./corpora";
import { createCloudflareRlmRuntime } from "./rlm";
import type {
  BlobStoreLike,
  CloudflareEnvLike,
  JsonSchema,
  ModelHandleLike,
  ModelStructuredGenerationArgs,
  R2BucketLike,
  RuntimeContextLike,
  StructuredGenerationArgs,
  StructuredGenerationBridgeLike,
  StructuredGenerationResult,
  TokenUsageLike,
  WorkersAIBindingLike,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractUsage(value: unknown): TokenUsageLike | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const directInput = typeof value.inputTokens === "number" ? value.inputTokens : undefined;
  const directOutput = typeof value.outputTokens === "number" ? value.outputTokens : undefined;
  const directTotal = typeof value.totalTokens === "number" ? value.totalTokens : undefined;

  if (directInput != null || directOutput != null || directTotal != null) {
    const usage: TokenUsageLike = {};
    if (directInput != null) {
      usage.inputTokens = directInput;
    }
    if (directOutput != null) {
      usage.outputTokens = directOutput;
    }
    if (directTotal != null) {
      usage.totalTokens = directTotal;
    }
    return usage;
  }

  if (isRecord(value.usage)) {
    return extractUsage(value.usage);
  }

  const inputTokens = typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined;
  const outputTokens =
    typeof value.completion_tokens === "number" ? value.completion_tokens : undefined;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : undefined;

  if (inputTokens != null || outputTokens != null || totalTokens != null) {
    const usage: TokenUsageLike = {};
    if (inputTokens != null) {
      usage.inputTokens = inputTokens;
    }
    if (outputTokens != null) {
      usage.outputTokens = outputTokens;
    }
    if (totalTokens != null) {
      usage.totalTokens = totalTokens;
    }
    return usage;
  }

  return undefined;
}

function extractFinishReason(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.finishReason === "string") {
    return value.finishReason;
  }
  if (typeof value.finish_reason === "string") {
    return value.finish_reason;
  }
  if (isRecord(value.response)) {
    return extractFinishReason(value.response);
  }
  return undefined;
}

function extractStructuredPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return parseJsonString(value);
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const key of ["object", "output", "result", "data"]) {
    if (key in value) {
      return extractStructuredPayload(value[key]);
    }
  }

  if ("response" in value) {
    const payload = extractStructuredPayload(value.response);
    if (payload !== value.response || !("usage" in value)) {
      return payload;
    }
  }

  if (Array.isArray(value.choices) && value.choices.length > 0) {
    const first = value.choices[0];
    if (isRecord(first)) {
      if (isRecord(first.message) && "content" in first.message) {
        return extractStructuredPayload(first.message.content);
      }
      if ("text" in first) {
        return extractStructuredPayload(first.text);
      }
    }
  }

  if ("content" in value) {
    const content = value.content;
    if (typeof content === "string") {
      return parseJsonString(content);
    }
    if (Array.isArray(content) && content.length > 0) {
      const jsonPart = content.find(
        (part) => isRecord(part) && part.type === "json" && "json" in part,
      );
      if (jsonPart != null && isRecord(jsonPart)) {
        return extractStructuredPayload(jsonPart.json);
      }

      const textPart = content.find(
        (part) => isRecord(part) && part.type === "text" && "text" in part,
      );
      if (textPart != null && isRecord(textPart)) {
        return extractStructuredPayload(textPart.text);
      }
    }
  }

  return value;
}

function sanitizeSchemaName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "structured_output"
  );
}

function resolveWorkersAIBinding(
  env: CloudflareEnvLike | undefined,
  bindingName: string,
): WorkersAIBindingLike | null {
  const candidate = env?.[bindingName];
  if (
    candidate != null &&
    typeof candidate === "object" &&
    "run" in candidate &&
    typeof candidate.run === "function"
  ) {
    return candidate as WorkersAIBindingLike;
  }
  return null;
}

type WorkersAIGatewayConfig = {
  id?: string;
  skipCache?: boolean;
  cacheTtl?: number;
};

export class WorkersAIModelHandle implements ModelHandleLike {
  readonly id: string;
  readonly provider = "cloudflare-workers-ai";
  readonly model: string;
  readonly binding: string;
  readonly gateway: WorkersAIGatewayConfig | undefined;

  constructor(
    model: string,
    options?: {
      binding?: string;
      id?: string;
      gateway?: WorkersAIGatewayConfig;
    },
  ) {
    this.model = model;
    this.binding = options?.binding ?? "AI";
    this.id = options?.id ?? `${this.provider}:${model}`;
    this.gateway = options?.gateway;
  }

  withBinding(binding: string): WorkersAIModelHandle {
    return new WorkersAIModelHandle(this.model, {
      binding,
      id: this.id,
      ...(this.gateway != null ? { gateway: this.gateway } : {}),
    });
  }

  private resolveGateway(_env: CloudflareEnvLike | undefined) {
    const id =
      this.gateway?.id != null && this.gateway.id.trim().length > 0 ? this.gateway.id : "default";
    return {
      id,
      ...(this.gateway?.skipCache != null ? { skipCache: this.gateway.skipCache } : {}),
      ...(this.gateway?.cacheTtl != null ? { cacheTtl: this.gateway.cacheTtl } : {}),
    };
  }

  async structured<T>(
    args: ModelStructuredGenerationArgs<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const binding = resolveWorkersAIBinding(args.env, this.binding);
    if (binding == null) {
      throw new Error(`Workers AI binding "${this.binding}" was not found in the Cloudflare env.`);
    }

    const jsonSchema = z.toJSONSchema(args.schema) as JsonSchema;
    const schemaName = sanitizeSchemaName(args.schemaName ?? this.model);
    const requestBody: Record<string, unknown> = {
      messages: args.messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          description: args.schemaDescription,
          schema: jsonSchema,
          strict: args.strict ?? true,
        },
      },
    };

    if (args.tools != null && args.tools.length > 0) {
      requestBody.tools = args.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema:
          tool.inputSchema != null ? (z.toJSONSchema(tool.inputSchema) as JsonSchema) : undefined,
      }));
    }

    const gateway = this.resolveGateway(args.env);
    const rawResponse = await binding.run(this.model, requestBody, { gateway });
    const payload = extractStructuredPayload(rawResponse);
    const object = args.schema.parse(payload);

    const result: StructuredGenerationResult<T> = {
      object,
      rawResponse,
    };

    const usage = extractUsage(rawResponse);
    if (usage != null) {
      result.usage = usage;
    }

    const finishReason = extractFinishReason(rawResponse);
    if (finishReason != null) {
      result.finishReason = finishReason;
    }

    return result;
  }
}

function hasGenerateObject(model: unknown): model is ModelHandleLike & {
  generateObject: <T>(
    args: ModelStructuredGenerationArgs<T>,
  ) => Promise<StructuredGenerationResult<T>>;
} {
  return isRecord(model) && "generateObject" in model && typeof model.generateObject === "function";
}

function hasStructured(model: unknown): model is ModelHandleLike & {
  structured: <T>(args: ModelStructuredGenerationArgs<T>) => Promise<StructuredGenerationResult<T>>;
} {
  return isRecord(model) && "structured" in model && typeof model.structured === "function";
}

function extractLanguageModel(model: unknown): unknown {
  if (isRecord(model) && "languageModel" in model) {
    return model.languageModel;
  }
  return model;
}

export class AiSdkStructuredBridge implements StructuredGenerationBridgeLike {
  readonly id: string;
  private readonly env: CloudflareEnvLike | undefined;

  constructor(options?: { id?: string; env?: CloudflareEnvLike }) {
    this.id = options?.id ?? "cloudflare-ai-sdk-bridge";
    this.env = options?.env;
  }

  withEnv(env: CloudflareEnvLike): StructuredGenerationBridgeLike {
    return new AiSdkStructuredBridge({
      id: this.id,
      env,
    });
  }

  async generateObject<T>(
    args: StructuredGenerationArgs<T>,
  ): Promise<StructuredGenerationResult<T>> {
    if (hasGenerateObject(args.model)) {
      const customArgs =
        this.env == null
          ? args
          : {
              ...args,
              env: this.env,
            };
      return args.model.generateObject(customArgs);
    }

    if (hasStructured(args.model)) {
      const customArgs =
        this.env == null
          ? args
          : {
              ...args,
              env: this.env,
            };
      return args.model.structured(customArgs);
    }

    const languageModel = extractLanguageModel(args.model);
    if (languageModel == null) {
      throw new Error(
        "Structured generation requires a model handle, provider model id, or custom model with structured() support.",
      );
    }

    const requestArgs: Record<string, unknown> = {
      model: languageModel as never,
      messages: args.messages as never,
      schema: args.schema,
      output: "object",
    };

    if (args.schemaName != null) {
      requestArgs.schemaName = args.schemaName;
    }
    if (args.schemaDescription != null) {
      requestArgs.schemaDescription = args.schemaDescription;
    }
    if (args.abortSignal != null) {
      requestArgs.abortSignal = args.abortSignal;
    }

    const result = await generateObject(requestArgs as never);

    const structuredResult: StructuredGenerationResult<T> = {
      object: args.schema.parse(result.object),
      rawResponse: result.response,
      finishReason: result.finishReason,
    };

    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    };
    if (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null) {
      structuredResult.usage = {};
      if (usage.inputTokens != null) {
        structuredResult.usage.inputTokens = usage.inputTokens;
      }
      if (usage.outputTokens != null) {
        structuredResult.usage.outputTokens = usage.outputTokens;
      }
      if (usage.totalTokens != null) {
        structuredResult.usage.totalTokens = usage.totalTokens;
      }
    }

    return structuredResult;
  }
}

export class BoundR2BlobStore implements BlobStoreLike {
  readonly binding: string;
  private readonly fallbackStore: BlobStoreLike;
  private readonly env: CloudflareEnvLike | undefined;

  constructor(options?: {
    binding?: string;
    env?: CloudflareEnvLike;
    fallbackStore?: BlobStoreLike;
  }) {
    this.binding = options?.binding ?? "SO_ARTIFACTS";
    this.env = options?.env;
    this.fallbackStore = options?.fallbackStore ?? createR2BlobStore(this.binding);
  }

  withEnv(env: CloudflareEnvLike): BoundR2BlobStore {
    return new BoundR2BlobStore({
      binding: this.binding,
      env,
      fallbackStore: this.fallbackStore,
    });
  }

  private resolveBucket(): R2BucketLike | null {
    const candidate = this.env?.[this.binding];
    if (
      candidate != null &&
      typeof candidate === "object" &&
      "put" in candidate &&
      typeof candidate.put === "function" &&
      "get" in candidate &&
      typeof candidate.get === "function"
    ) {
      return candidate as R2BucketLike;
    }
    return null;
  }

  async put(key: string, value: unknown): Promise<string> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.put(key, value);
    }

    const serialized = JSON.stringify(value);
    await bucket.put(key, serialized);
    return key;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.get<T>(key);
    }

    const value = await bucket.get(key);
    if (value == null) {
      return null;
    }

    if (typeof value === "string") {
      return parseJsonString(value) as T;
    }

    if (isRecord(value) && "text" in value && typeof value.text === "function") {
      const text = await value.text();
      return parseJsonString(text) as T;
    }

    return value as T;
  }

  async delete(key: string): Promise<void> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      await this.fallbackStore.delete(key);
      return;
    }

    await bucket.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.list?.(prefix) ?? [];
    }

    const response = bucket.list == null ? [] : await bucket.list({ prefix });
    if (Array.isArray(response)) {
      return response.map((item) => (typeof item === "string" ? item : item.key));
    }

    return (response.objects ?? []).map((item) => item.key);
  }
}

export function createAiSdkBridge(options?: {
  id?: string;
  env?: CloudflareEnvLike;
}): StructuredGenerationBridgeLike {
  return new AiSdkStructuredBridge(options);
}

export function workersAI(
  model: string,
  options?: {
    binding?: string;
    id?: string;
    gateway?: WorkersAIGatewayConfig;
  },
): WorkersAIModelHandle {
  return new WorkersAIModelHandle(model, options);
}

export function bindRuntimeEnv(
  runtime: RuntimeContextLike | undefined,
  env: CloudflareEnvLike | undefined,
): RuntimeContextLike {
  const bound: RuntimeContextLike = {
    ...runtime,
  };

  if (env != null) {
    bound.env = env;
  }

  if (runtime?.structuredGeneration?.withEnv != null && env != null) {
    bound.structuredGeneration = runtime.structuredGeneration.withEnv(env);
  } else if (runtime?.structuredGeneration != null) {
    bound.structuredGeneration = runtime.structuredGeneration;
  }

  if (runtime?.blobStore instanceof BoundR2BlobStore && env != null) {
    bound.blobStore = runtime.blobStore.withEnv(env);
  }

  if (runtime?.traceStore instanceof R2BackedTraceStore && env != null) {
    bound.traceStore = runtime.traceStore.withEnv(env);
  }

  if (runtime?.artifactStore instanceof R2BackedArtifactStore && env != null) {
    bound.artifactStore = runtime.artifactStore.withEnv(env);
  }

  if (runtime?.corpora?.withEnv != null && env != null) {
    bound.corpora = runtime.corpora.withEnv(env);
  } else if (runtime?.corpora != null) {
    bound.corpora = runtime.corpora;
  }

  return bound;
}

export const cloudflare = Object.assign(
  function cloudflare(
    env: CloudflareEnvLike,
    options?: {
      bucketBinding?: string;
      stateBinding?: string;
      aiSearchBinding?: string;
    },
  ) {
    return createCloudflareHost(env, options);
  },
  {
    workersAI,
    aiSdkBridge: createAiSdkBridge,
    memoryTraceStore: createMemoryTraceStore,
    memoryArtifactStore: createMemoryArtifactStore,
    r2TraceStore: createR2TraceStore,
    r2ArtifactStore: createR2ArtifactStore,
    prototypeTraceStore: createPrototypeTraceStore,
    prototypeArtifactStore: createPrototypeArtifactStore,
    sqliteTraceStore: createSqliteTraceStore,
    sqliteArtifactStore: createSqliteArtifactStore,
    r2BlobStore(options?: {
      binding?: string;
      env?: CloudflareEnvLike;
      fallbackStore?: BlobStoreLike;
    }): BlobStoreLike {
      return new BoundR2BlobStore(options);
    },
    corpora: {
      provider: createCorpusProvider,
      fromProject: createProjectCorpusProvider,
      mergeProviders: mergeCorpusProviders,
      bindRuntime: bindProjectCorporaRuntime,
      prepareContext: prepareCorpusContext,
      listFilesTool: createListCorpusFilesTool,
      readFileTool: createReadCorpusFileTool,
      searchTool: createSearchCorpusTool,
    },
    rlm: {
      runtime: createCloudflareRlmRuntime,
    },
  },
);
