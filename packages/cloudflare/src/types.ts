import type {
  AgentLike as HostingAgentLike,
  ArtifactTargetKindLike as HostingArtifactTargetKindLike,
  ArtifactStoreLike as HostingArtifactStoreLike,
  BlobStoreLike as HostingBlobStoreLike,
  CallableTargetLike as HostingCallableTargetLike,
  CompiledArtifactLike as HostingCompiledArtifactLike,
  ComponentTraceLike as HostingComponentTraceLike,
  CorpusDescriptorLike as HostingCorpusDescriptorLike,
  CorpusFileHandleLike as HostingCorpusFileHandleLike,
  CorpusProviderLike as HostingCorpusProviderLike,
  CorpusRetrievalDescriptorLike as HostingCorpusRetrievalDescriptorLike,
  CorpusRuntimeHandleLike as HostingCorpusRuntimeHandleLike,
  CorpusSearchChunkLike as HostingCorpusSearchChunkLike,
  CorpusSearchHandleLike as HostingCorpusSearchHandleLike,
  CorpusSearchResultLike as HostingCorpusSearchResultLike,
  CorpusStorageDescriptorLike as HostingCorpusStorageDescriptorLike,
  CorpusWorkspaceLike as HostingCorpusWorkspaceLike,
  ExecutionContextLike as HostingExecutionContextLike,
  JsonSchema as HostingJsonSchema,
  LoggerLike as HostingLoggerLike,
  McpSurfaceLike as HostingMcpSurfaceLike,
  ModelCallTraceLike as HostingModelCallTraceLike,
  ModelHandleLike as HostingModelHandleLike,
  ModelMessageLike as HostingModelMessageLike,
  NormalizedProjectLike as HostingNormalizedProjectLike,
  ProjectLike as HostingProjectLike,
  RpcSurfaceLike as HostingRpcSurfaceLike,
  RunTraceLike as HostingRunTraceLike,
  RuntimeContextLike as HostingRuntimeContextLike,
  SerializedErrorLike as HostingSerializedErrorLike,
  SignatureFieldLike as HostingSignatureFieldLike,
  SignatureLike as HostingSignatureLike,
  StructuredGenerationArgs as HostingStructuredGenerationArgs,
  StructuredGenerationBridgeLike as HostingStructuredGenerationBridgeLike,
  StructuredGenerationResult as HostingStructuredGenerationResult,
  TextParamLike as HostingTextParamLike,
  TokenUsageLike as HostingTokenUsageLike,
  ToolCallTraceLike as HostingToolCallTraceLike,
  ToolDefinitionLike as HostingToolDefinitionLike,
  ToolExecutionContextLike as HostingToolExecutionContextLike,
  ToolLike as HostingToolLike,
  TraceStoreLike as HostingTraceStoreLike,
} from "@superobjective/hosting";

export type WorkersAIBindingLike = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: {
      gateway?: {
        id: string;
        skipCache?: boolean;
        cacheTtl?: number;
      };
    } & Record<string, unknown>,
  ): Promise<unknown>;
};

export type R2BucketLike = {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list?(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }):
    | Promise<string[]>
    | Promise<Array<{ key: string }>>
    | Promise<{ objects?: Array<{ key: string }>; cursor?: string; truncated?: boolean }>;
};

export type AISearchItemLike = {
  id: string;
  filename?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

export type AISearchInstanceLike = {
  info(): Promise<unknown>;
  search(args: Record<string, unknown>): Promise<unknown>;
  items: {
    upload?(
      name: string,
      content: string | Uint8Array | ArrayBuffer,
      options?: {
        contentType?: string;
        metadata?: Record<string, string>;
      },
    ): Promise<AISearchItemLike>;
    uploadAndPoll(
      name: string,
      content: string | Uint8Array | ArrayBuffer,
      options?: {
        contentType?: string;
        metadata?: Record<string, string>;
      },
    ): Promise<AISearchItemLike>;
    delete(itemId: string): Promise<void>;
  };
};

export type AISearchNamespaceLike = {
  get(name: string): AISearchInstanceLike;
  create(options: {
    id: string;
    description?: string;
    custom_metadata?: Array<{
      field_name: string;
      data_type: string;
    }>;
    type?: string;
    source?: string;
    source_params?: Record<string, unknown>;
  }): Promise<AISearchInstanceLike>;
  delete(name: string): Promise<void>;
};

export type CloudflareEnvLike = Record<string, unknown> & {
  AI?: WorkersAIBindingLike;
  SO_ARTIFACTS?: R2BucketLike;
  SO_DATA?: R2BucketLike;
  AI_SEARCH?: AISearchNamespaceLike;
  LOADER?: unknown;
  SO_KERNEL?: unknown;
  SO_AGENT?: unknown;
  SO_MCP?: unknown;
  SO_THINK?: unknown;
  SO_APP_STATE?: unknown;
};

export type JsonSchema = HostingJsonSchema;
export type TextParamLike = HostingTextParamLike;
export type ModelMessageLike = HostingModelMessageLike;
export type TokenUsageLike = HostingTokenUsageLike;
export type SerializedErrorLike = HostingSerializedErrorLike;
export type ModelCallTraceLike = HostingModelCallTraceLike;
export type ToolCallTraceLike = HostingToolCallTraceLike;
export type ComponentTraceLike = HostingComponentTraceLike;
export type RunTraceLike = HostingRunTraceLike;
export type CompiledArtifactLike = HostingCompiledArtifactLike;
export type ArtifactTargetKindLike = HostingArtifactTargetKindLike;
export type CorpusStorageDescriptorLike = HostingCorpusStorageDescriptorLike;
export type CorpusRetrievalDescriptorLike = HostingCorpusRetrievalDescriptorLike;
export type CorpusDescriptorLike = HostingCorpusDescriptorLike;
export type CorpusSearchChunkLike = HostingCorpusSearchChunkLike;
export type CorpusSearchResultLike = HostingCorpusSearchResultLike;
export type CorpusFileHandleLike = HostingCorpusFileHandleLike;
export type CorpusSearchHandleLike = HostingCorpusSearchHandleLike;
export type CorpusWorkspaceLike = HostingCorpusWorkspaceLike;
export type CorpusRuntimeHandleLike = HostingCorpusRuntimeHandleLike;
export type TraceStoreLike = HostingTraceStoreLike;
export type ArtifactStoreLike = HostingArtifactStoreLike;
export type BlobStoreLike = HostingBlobStoreLike;
export type ToolDefinitionLike = HostingToolDefinitionLike;
export type StructuredGenerationArgs<T> = HostingStructuredGenerationArgs<T, CloudflareEnvLike>;
export type ModelStructuredGenerationArgs<T> = Omit<StructuredGenerationArgs<T>, "model"> & {
  env?: CloudflareEnvLike;
};
export type StructuredGenerationResult<T> = HostingStructuredGenerationResult<T>;
export type StructuredGenerationBridgeLike =
  HostingStructuredGenerationBridgeLike<CloudflareEnvLike>;
export type ModelHandleLike = HostingModelHandleLike<CloudflareEnvLike>;
export type LoggerLike = HostingLoggerLike;
export type RuntimeContextLike = HostingRuntimeContextLike<CloudflareEnvLike>;
export type SignatureFieldLike = HostingSignatureFieldLike;
export type SignatureLike = HostingSignatureLike;
export type CallableTargetLike<TInput = unknown, TOutput = unknown> = HostingCallableTargetLike<
  TInput,
  TOutput,
  CloudflareEnvLike
>;
export type ToolExecutionContextLike = HostingToolExecutionContextLike<CloudflareEnvLike>;
export type ToolLike<TInput = unknown, TOutput = unknown> = HostingToolLike<
  TInput,
  TOutput,
  CloudflareEnvLike
>;
export type AgentLike = HostingAgentLike<CloudflareEnvLike>;
export type RpcSurfaceLike = HostingRpcSurfaceLike<CloudflareEnvLike>;
export type McpSurfaceLike = HostingMcpSurfaceLike<CloudflareEnvLike>;
export type ProjectLike = HostingProjectLike<CloudflareEnvLike>;
export type NormalizedProjectLike = HostingNormalizedProjectLike<CloudflareEnvLike>;
export type ExecutionContextLike = HostingExecutionContextLike;
export type CorpusProviderLike<TEnv = CloudflareEnvLike> = HostingCorpusProviderLike<TEnv>;

export type DevelopmentMode = "local" | "local-remote-bindings" | "remote-preview" | "deploy";

export type BindingMode = "local" | "remote";

export type DevelopmentHintsLike = {
  mode?: DevelopmentMode;
  bindings?: Record<string, BindingMode>;
  durableObjects?: BindingMode;
  workflows?: BindingMode;
};

export type CreateCloudflareWorkerOptions = {
  project: ProjectLike;
  runtime?: RuntimeContextLike;
  cloudflare?: {
    development?: DevelopmentHintsLike;
  };
};

export type DurableObjectStateLike = {
  id?: {
    toString(): string;
  };
  storage?: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
};

export type CloudflareWorkerLike = {
  fetch(request: Request, env?: CloudflareEnvLike, ctx?: ExecutionContextLike): Promise<Response>;
};
