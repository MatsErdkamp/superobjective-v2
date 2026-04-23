import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export type TextParamLike =
  | string
  | {
      value: string;
      optimize?: boolean;
      id?: string;
      metadata?: Record<string, unknown>;
    };

export type ModelMessageLike = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  name?: string;
  toolCallId?: string;
};

export type TokenUsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type SerializedErrorLike = {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export type ModelCallTraceLike = {
  provider: string;
  model: string;
  messages: ModelMessageLike[];
  outputJsonSchema?: JsonSchema | undefined;
  rawResponse?: unknown;
  latencyMs?: number;
  tokenUsage?: TokenUsageLike | undefined;
  finishReason?: string;
};

export type ToolCallTraceLike = {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: SerializedErrorLike;
  source?: "model-tool-call" | "direct-binding" | "codemode" | "rlm" | "program";
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
};

export type ComponentTraceLike = {
  componentId: string;
  componentKind: "predict" | "program" | "adapter" | "tool" | "rpc" | "mcp" | "rlm";
  startedAt: string;
  endedAt?: string;
  input: unknown;
  output?: unknown;
  error?: SerializedErrorLike;
  candidate?: {
    paths: string[];
    hash: string;
  };
  prompt?: {
    adapterId: string;
    adapterVersion: string;
    messages: ModelMessageLike[];
    outputJsonSchema?: JsonSchema | undefined;
  };
  stdout: string;
  stderr?: string;
  metadata?: Record<string, unknown> | undefined;
};

export type RunTraceLike = {
  runId: string;
  targetId: string;
  targetKind: "predict" | "program" | "tool" | "agent" | "rpc" | "mcp" | "rlm";
  startedAt: string;
  endedAt?: string;
  input: unknown;
  output?: unknown;
  error?: SerializedErrorLike;
  stdout: string;
  stderr?: string;
  components: ComponentTraceLike[];
  modelCalls: ModelCallTraceLike[];
  toolCalls: ToolCallTraceLike[];
  metadata?: Record<string, unknown> | undefined;
};

export type CompiledArtifactLike = {
  id: string;
  target: {
    kind: "predict" | "program" | "agent";
    id: string;
  };
  optimizer: {
    id: string;
    version: string;
    configHash: string;
  };
  textCandidate: Record<string, string>;
  adapter: {
    id: string;
    version: string;
  };
  eval: {
    metricName: string;
    trainScore?: number;
    valScore?: number;
    trainSize: number;
    valSize?: number;
  };
  frontier?: Array<{
    candidateId: string;
    parentId?: string;
    aggregateScore: number;
    textCandidate: Record<string, string>;
    rationale?: string;
    feedbackSummary?: string;
  }>;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type TraceStoreLike = {
  saveTrace(trace: RunTraceLike): Promise<void>;
  loadTrace(runId: string): Promise<RunTraceLike | null>;
  listTraces?(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]>;
};

export type ArtifactStoreLike = {
  saveArtifact(artifact: CompiledArtifactLike): Promise<void>;
  loadArtifact(id: string): Promise<CompiledArtifactLike | null>;
  listArtifacts?(args?: {
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<CompiledArtifactLike[]>;
  loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<CompiledArtifactLike | null>;
  setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void>;
};

export type BlobStoreLike = {
  put(key: string, value: unknown): Promise<string>;
  get<T = unknown>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  list?(prefix?: string): Promise<string[]>;
};

export type CorpusStorageDescriptorLike = {
  kind: "r2";
  bucketBinding: string;
  prefix: string;
};

export type CorpusRetrievalDescriptorLike = {
  kind: "ai-search";
  binding: string;
  namespace: string;
  instanceId: string;
  sourceMode: "external-r2" | "built-in-storage" | "hybrid";
};

export type CorpusDescriptorLike = {
  id: string;
  storage: CorpusStorageDescriptorLike;
  retrieval?: CorpusRetrievalDescriptorLike;
  metadata?: Record<string, unknown>;
};

export type CorpusSearchChunkLike = {
  id: string;
  type?: string;
  score?: number;
  text: string;
  item?: {
    key?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };
  scoringDetails?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CorpusSearchResultLike = {
  query?: string;
  chunks: CorpusSearchChunkLike[];
  raw?: unknown;
};

export type CorpusFileHandleLike = {
  list(prefix?: string): Promise<string[]>;
  getText(path: string): Promise<string>;
  getBytes(path: string): Promise<Uint8Array>;
  head?(
    path: string,
  ): Promise<
    | {
        size?: number;
        etag?: string;
        metadata?: Record<string, unknown>;
      }
    | null
  >;
};

export type CorpusSearchHandleLike = {
  search(args: {
    query?: string;
    messages?: ModelMessageLike[];
    filters?: Record<string, unknown>;
    maxResults?: number;
    instanceIds?: string[];
  }): Promise<CorpusSearchResultLike>;
  info?(): Promise<unknown>;
  stats?(): Promise<unknown>;
  upload?(
    name: string,
    content: string | Uint8Array | ArrayBuffer | ReadableStream,
    options?: {
      metadata?: Record<string, string>;
      waitUntilIndexed?: boolean;
    },
  ): Promise<unknown>;
};

export type CorpusWorkspaceLike = {
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array): Promise<void>;
};

export type CorpusRuntimeHandleLike = {
  corpus: CorpusDescriptorLike;
  files: CorpusFileHandleLike;
  search?: CorpusSearchHandleLike;
  materializeToWorkspace?(args: {
    workspace: CorpusWorkspaceLike;
    paths?: string[];
    destinationPrefix?: string;
    overwrite?: boolean;
  }): Promise<{
    corpusId: string;
    destinationPrefix: string;
    files: string[];
  }>;
};

export type CorpusProviderLike<TEnv = unknown> = {
  withEnv?(env: TEnv): CorpusProviderLike<TEnv>;
  resolve(corpusId: string): Promise<CorpusRuntimeHandleLike>;
  list?(): Promise<CorpusDescriptorLike[]>;
};

export type ToolDefinitionLike = {
  name: string;
  description?: string | undefined;
  inputSchema?: z.ZodTypeAny | undefined;
  execute?: (input: unknown) => Promise<unknown>;
};

export type ModelLike<TEnv = unknown> = ModelHandleLike<TEnv> | string;

export type StructuredGenerationRequest<T> = {
  messages: ModelMessageLike[];
  schema: z.ZodType<T>;
  schemaName?: string | undefined;
  schemaDescription?: string | undefined;
  strict?: boolean;
  tools?: ToolDefinitionLike[];
  abortSignal?: AbortSignal | undefined;
};

export type StructuredGenerationArgs<T, TEnv = unknown> = StructuredGenerationRequest<T> & {
  model: ModelLike<TEnv>;
};

export type ModelStructuredGenerationArgs<T, TEnv = unknown> = StructuredGenerationRequest<T> & {
  env?: TEnv | undefined;
};

export type StructuredGenerationResult<T> = {
  object: T;
  rawResponse?: unknown;
  usage?: TokenUsageLike;
  finishReason?: string;
};

export type StructuredGenerationBridgeLike<TEnv = unknown> = {
  id: string;
  withEnv?(env: TEnv): StructuredGenerationBridgeLike<TEnv>;
  generateObject<T>(
    args: StructuredGenerationArgs<T, TEnv>,
  ): Promise<StructuredGenerationResult<T>>;
};

export type ModelHandleLike<TEnv = unknown> = {
  id?: string;
  provider?: string;
  model?: string;
  languageModel?: unknown;
  structured?<T>(
    args: ModelStructuredGenerationArgs<T, TEnv>,
  ): Promise<StructuredGenerationResult<T>>;
  generateObject?<T>(
    args: ModelStructuredGenerationArgs<T, TEnv>,
  ): Promise<StructuredGenerationResult<T>>;
};

export type LoggerLike = {
  log?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
};

export type RuntimeContextLike<TEnv = unknown> = {
  model?: ModelLike<TEnv>;
  structuredGeneration?: StructuredGenerationBridgeLike<TEnv>;
  traceStore?: TraceStoreLike;
  artifactStore?: ArtifactStoreLike;
  blobStore?: BlobStoreLike;
  corpora?: CorpusProviderLike<TEnv>;
  logger?: LoggerLike;
  env?: TEnv | undefined;
};

export type SignatureFieldLike = {
  schema?: z.ZodTypeAny;
  description?: TextParamLike;
  optional?: boolean;
  default?: unknown;
  examples?: unknown[];
  metadata?: Record<string, unknown>;
};

export type SignatureLike = {
  kind?: string;
  name?: string;
  instructions?: TextParamLike;
  input?: Record<string, SignatureFieldLike>;
  output?: Record<string, SignatureFieldLike>;
  metadata?: Record<string, unknown>;
};

export type ExecutionContextLike = {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

export type InvocationContextLike<TEnv = unknown> = {
  runtime: RuntimeContextLike<TEnv>;
  env?: TEnv | undefined;
  request?: Request | undefined;
  executionContext?: ExecutionContextLike | undefined;
};

export type CallableTargetLike<TInput = unknown, TOutput = unknown, TEnv = unknown> = ((
  input: TInput,
  options?: InvocationContextLike<TEnv>,
) => Promise<TOutput>) & {
  kind?: string;
  id?: string;
  signature?: SignatureLike;
  inputSchema?: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  inspectPrompt?(input: TInput, options?: InvocationContextLike<TEnv>): Promise<unknown>;
  inspectTextCandidate?(): Record<string, string>;
};

export type ToolExecutionContextLike<TEnv = unknown> = {
  runtime: RuntimeContextLike<TEnv>;
  env?: TEnv | undefined;
  request?: Request | undefined;
  sessionId?: string | undefined;
  trace?: RunTraceLike | undefined;
  log(message: string): void;
};

export type ToolLike<TInput = unknown, TOutput = unknown, TEnv = unknown> = {
  kind?: string;
  name: string;
  description?: TextParamLike;
  inputSchema?: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolExecutionContextLike<TEnv>): Promise<TOutput> | TOutput;
};

export type AgentLike<TEnv = unknown> = {
  name: string;
  chat: CallableTargetLike<unknown, unknown, TEnv>;
  tools?: Array<ToolLike<unknown, unknown, TEnv> | CallableTargetLike<unknown, unknown, TEnv>>;
  system?: TextParamLike;
};

export type RpcSurfaceLike<TEnv = unknown> = {
  name: string;
  handlers: Record<
    string,
    CallableTargetLike<unknown, unknown, TEnv> | ToolLike<unknown, unknown, TEnv>
  >;
};

export type McpSurfaceLike<TEnv = unknown> = {
  name: string;
  tools: Array<ToolLike<unknown, unknown, TEnv> | CallableTargetLike<unknown, unknown, TEnv>>;
};

export type ProjectLike<TEnv = unknown> = {
  programs?: Array<CallableTargetLike<unknown, unknown, TEnv>>;
  agents?: Array<AgentLike<TEnv>>;
  rpc?: Array<RpcSurfaceLike<TEnv>>;
  mcp?: Array<McpSurfaceLike<TEnv>>;
  corpora?: Array<CorpusDescriptorLike>;
};

export type NormalizedProjectLike<TEnv = unknown> = {
  programs: Map<string, CallableTargetLike<unknown, unknown, TEnv>>;
  agents: Map<string, AgentLike<TEnv>>;
  rpc: Map<string, RpcSurfaceLike<TEnv>>;
  mcp: Map<string, McpSurfaceLike<TEnv>>;
  corpora: Map<string, CorpusDescriptorLike>;
};

export type HostedRoutePrefix = "agents" | "rpc" | "mcp";

export type HostedRouteContextLike<TEnv = unknown> = {
  runtime: RuntimeContextLike<TEnv>;
  env?: TEnv | undefined;
  request: Request;
  executionContext?: ExecutionContextLike | undefined;
  warnings: string[];
};

export type HostedRouteDispatchOptions<TEnv = unknown> = {
  request: Request;
  env?: TEnv | undefined;
  executionContext?: ExecutionContextLike | undefined;
  runtime: RuntimeContextLike<TEnv>;
  project: NormalizedProjectLike<TEnv>;
  warnings: string[];
  hostPrefix?: HostedRoutePrefix;
};
