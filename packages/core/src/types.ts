import type { z } from "zod";

export type JsonSchema = {
  [key: string]: unknown;
};

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export type ModelMessage = {
  role: ModelMessageRole;
  content: string;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
};

export type TextParam = {
  value: string;
  optimize?: boolean;
  id?: string;
  metadata?: Record<string, unknown>;
};

export type Field<T = unknown, TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  kind: "input" | "output";
  schema: TSchema;
  description: TextParam;
  optional?: boolean;
  default?: T;
  examples?: T[];
  metadata?: Record<string, unknown>;
  __type?: T;
};

export type FieldRecord = Record<string, Field<any, any>>;

export type InferField<TField> = TField extends Field<infer TValue, any> ? TValue : never;

export type InferFields<TFields extends FieldRecord> = {
  [TKey in keyof TFields]: InferField<TFields[TKey]>;
};

export type Signature<TInput extends FieldRecord, TOutput extends FieldRecord> = {
  kind: "signature";
  name: string;
  instructions: TextParam;
  input: TInput;
  output: TOutput;
  metadata?: Record<string, unknown>;
};

export interface SignatureBuilder<
  TName extends string,
  TInput extends FieldRecord,
  TOutput extends FieldRecord,
> {
  withInstructions(
    value: string,
    options?: { optimize?: boolean },
  ): SignatureBuilder<TName, TInput, TOutput>;
  withInstructions(value: TextParam): SignatureBuilder<TName, TInput, TOutput>;
  withInstruction(
    value: string,
    options?: { optimize?: boolean },
  ): SignatureBuilder<TName, TInput, TOutput>;
  withInstruction(value: TextParam): SignatureBuilder<TName, TInput, TOutput>;
  withInput<
    TKey extends string,
    T,
    TSchema extends z.ZodType<T>,
    TOptional extends boolean | undefined = undefined,
  >(
    name: TKey,
    schema: TSchema,
    options: {
      description: string | TextParam;
      optimize?: boolean;
      optional?: TOptional;
      default?: TOptional extends true ? T | undefined : T;
      examples?: Array<TOptional extends true ? T | undefined : T>;
      metadata?: Record<string, unknown>;
    },
  ): SignatureBuilder<
    TName,
    Omit<TInput, TKey> & Record<TKey, Field<TOptional extends true ? T | undefined : T, TSchema>>,
    TOutput
  >;
  withOutput<
    TKey extends string,
    T,
    TSchema extends z.ZodType<T>,
    TOptional extends boolean | undefined = undefined,
  >(
    name: TKey,
    schema: TSchema,
    options: {
      description: string | TextParam;
      optimize?: boolean;
      optional?: TOptional;
      default?: TOptional extends true ? T | undefined : T;
      examples?: Array<TOptional extends true ? T | undefined : T>;
      metadata?: Record<string, unknown>;
    },
  ): SignatureBuilder<
    TName,
    TInput,
    Omit<TOutput, TKey> & Record<TKey, Field<TOptional extends true ? T | undefined : T, TSchema>>
  >;
  withMetadata(metadata: Record<string, unknown>): SignatureBuilder<TName, TInput, TOutput>;
  build(): Signature<TInput, TOutput>;
}

export type Example<TInput, TExpected> = {
  id?: string;
  input: TInput;
  expected: TExpected;
  metadata?: Record<string, unknown>;
};

export type Score = {
  score: number;
  feedback?: string;
  logs?: string[];
  stdout?: string;
  stderr?: string;
  trace?: RunTrace;
  attachments?: Array<{
    name: string;
    mediaType: string;
    data: unknown;
  }>;
  metadata?: Record<string, unknown>;
};

export type ComponentTrace = {
  spanId?: string;
  parentSpanId?: string;
  componentId: string;
  componentKind: "predict" | "program" | "adapter" | "tool" | "rpc" | "mcp" | "rlm";
  startedAt: string;
  endedAt?: string;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  candidate?: {
    paths: string[];
    hash: string;
  };
  prompt?: {
    adapterId: string;
    adapterVersion: string;
    messages: ModelMessage[];
    outputJsonSchema?: JsonSchema;
  };
  stdout: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
};

export type ModelCallTrace = {
  spanId?: string;
  parentSpanId?: string;
  provider: string;
  model: string;
  messages: ModelMessage[];
  outputJsonSchema?: JsonSchema;
  rawResponse?: unknown;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  finishReason?: string;
};

export type ToolCallTrace = {
  id?: string;
  spanId?: string;
  parentSpanId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  source?: "model-tool-call" | "direct-binding" | "codemode" | "rlm" | "program";
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  executionPlan?: ExecutionPlanTrace;
  metadata?: Record<string, unknown>;
};

export type RunTrace = {
  runId: string;
  targetId: string;
  targetKind: "predict" | "program" | "tool" | "agent" | "rpc" | "mcp" | "rlm";
  startedAt: string;
  endedAt?: string;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  stdout: string;
  stderr?: string;
  components: ComponentTrace[];
  modelCalls: ModelCallTrace[];
  toolCalls: ToolCallTrace[];
  programmable?: ProgrammableTrace;
  metadata?: Record<string, unknown>;
};

export type RunResult<TOutput> = {
  output: TOutput;
  trace: RunTrace;
};

export type TraceableModule<TInput, TOutput> = {
  runWithTrace(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>>;
};

export type MetricContext<TInput, TPrediction, TExpected> = {
  example: Example<TInput, TExpected>;
  prediction: TPrediction;
  expected: TExpected;
  trace: RunTrace;
  target?: {
    componentId: string;
    trace: ComponentTrace;
  };
  log(message: string): void;
};

export type Metric<TInput, TPrediction, TExpected> = {
  name: string;
  evaluate(ctx: MetricContext<TInput, TPrediction, TExpected>): Promise<Score> | Score;
};

export type TextCandidate = Record<string, string>;

export type ArtifactTargetKind = "predict" | "program" | "agent" | "rlm";

export type CompiledArtifact = {
  id: string;
  target: {
    kind: ArtifactTargetKind;
    id: string;
  };
  optimizer: {
    id: string;
    version: string;
    configHash: string;
  };
  textCandidate: TextCandidate;
  adapter?: {
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
    textCandidate: TextCandidate;
    rationale?: string;
    feedbackSummary?: string;
  }>;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description?: string;
  inputSchema?: z.ZodType<TInput>;
  execute?: (input: TInput) => Promise<TOutput> | TOutput;
};

export type ModuleKind = "predict" | "program" | "tool" | "rlm" | "agent";

export type ModuleChild = {
  kind: ModuleKind;
  id: string;
  name: string;
};

export type ToolExecutionMode = "direct" | "tool-calling" | "codemode" | "auto";

export type ExecutionPlanTrace = {
  selected: Exclude<ToolExecutionMode, "auto">;
  explicit: boolean;
  reasons: string[];
  dependencyGraph: {
    fields: Array<{
      field: string;
      source: string;
    }>;
  };
};

export type ProgrammableStepTrace = {
  index: number;
  reasoning?: string;
  code: string;
  stdout?: string;
  stderr?: string;
  logs: string[];
  toolCalls: ToolCallTrace[];
  queryCallsUsed?: number;
  submitted?: unknown;
  submitValidationError?: SerializedError;
  error?: SerializedError;
  startedAt: string;
  endedAt?: string;
};

export type ProgrammableTrace = {
  mode: "codemode" | "rlm";
  context?: {
    prepared: boolean;
    manifest?: unknown;
  };
  steps: ProgrammableStepTrace[];
};

export type ArgSource<T = unknown> = {
  kind: "arg";
  path: string;
  __type?: T;
};

export type LiteralSource<T = unknown> = {
  kind: "literal";
  value: T;
};

export type ChatSource<T = unknown> = {
  kind:
    | "chat.currentUserMessage"
    | "chat.history"
    | "chat.historyAsText"
    | "chat.historyAsContext"
    | "chat.messagesSinceLastToolCall"
    | "chat.latestAssistantMessage";
  options?: Record<string, unknown>;
  __type?: T;
};

export type ToolResultSource<T = unknown> = {
  kind: "tool.latestResult" | "tool.resultById";
  toolName: string;
  resultId?: string;
  path?: string;
  required?: boolean;
  __type?: T;
};

export type StateSource<T = unknown> = {
  kind: "state";
  key: string;
  path?: string;
  __type?: T;
};

export type PreparedSource = {
  kind: "prepared";
  mode: "direct" | "codemode";
  instructions?: TextParam;
  metadata?: Record<string, unknown>;
};

export type InputSource<T = unknown> =
  | ArgSource<T>
  | LiteralSource<T>
  | ChatSource<T>
  | ToolResultSource<T>
  | StateSource<T>
  | PreparedSource;

export type ToolBindingDefinition<TInput> = {
  name?: string;
  description?: TextParam;
  input?: {
    [K in keyof TInput]?: InputSource<TInput[K]>;
  };
  execution?: ToolExecutionMode;
  visibility?: {
    agent?: boolean;
    mcp?: boolean;
    rpc?: boolean;
  };
  metadata?: Record<string, unknown>;
};

export type ToolBindingState = {
  currentUserMessage?: string;
  latestAssistantMessage?: string;
  chatHistory?: ModelMessage[];
  loadLatestToolResult?(
    toolName: string,
    options?: {
      resultId?: string;
      path?: string;
      required?: boolean;
    },
  ): Promise<unknown>;
  loadState?(key: string, path?: string): Promise<unknown>;
};

export type ModuleNode<TInput = unknown, TOutput = unknown> = {
  kind: ModuleKind;
  id: string;
  name: string;
  inputSchema?: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute(input: TInput, options?: RunOptions | ToolContext): Promise<TOutput>;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): ModuleNode<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): ModuleNode<TInput, TOutput>;
  children?(): ModuleChild[];
};

export type AdapterOutput = {
  messages: ModelMessage[];
  output: {
    zodSchema: z.ZodTypeAny;
    jsonSchema: JsonSchema;
    name?: string;
    description?: string;
    strict?: boolean;
  };
  fallback?: {
    mode: "xml-tags" | "json-text";
    parse(rawText: string): Promise<unknown>;
  };
};

export type Adapter = {
  id: string;
  version: string;
  format(args: {
    signature: Signature<any, any>;
    candidate: TextCandidate;
    input: unknown;
    examples?: Example<any, any>[];
    history?: ModelMessage[];
    mode?: "structured" | "text-fallback";
  }): Promise<AdapterOutput>;
  parseStructured?(args: { signature: Signature<any, any>; value: unknown }): Promise<unknown>;
  parseTextFallback?(args: { signature: Signature<any, any>; rawText: string }): Promise<unknown>;
  formatFailureAsFeedback?(error: unknown): string;
};

export type ModelResponse = {
  text: string;
  rawResponse?: unknown;
  usage?: TokenUsage;
  finishReason?: string;
};

export type ModelHandle =
  | string
  | {
      id?: string;
      provider?: string;
      model?: string;
      [key: string]: unknown;
    };

export type ModelProvider = {
  id: string;
  complete?(args: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<ModelResponse>;
  structured?(args: {
    messages: ModelMessage[];
    schema: z.ZodTypeAny;
    abortSignal?: AbortSignal;
    schemaName?: string;
    schemaDescription?: string;
    strict?: boolean;
    tools?: ToolDefinition[];
  }): Promise<{
    object: unknown;
    rawResponse?: unknown;
    usage?: TokenUsage;
    finishReason?: string;
  }>;
};

export type StructuredGenerationBridge = {
  id: string;
  generateObject<T>(args: {
    model: ModelHandle | ModelProvider;
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
    strict?: boolean;
    tools?: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): Promise<StructuredGenerationResult<T>>;
};

export type StructuredGenerationResult<T> = {
  object: T;
  rawResponse?: unknown;
  usage?: TokenUsage;
  finishReason?: string;
};

export type ArtifactStore = {
  saveArtifact(artifact: CompiledArtifact): Promise<void>;
  loadArtifact(id: string): Promise<CompiledArtifact | null>;
  listArtifacts?(args?: {
    targetKind?: ArtifactTargetKind;
    targetId?: string;
    limit?: number;
  }): Promise<CompiledArtifact[]>;
  loadActiveArtifact(args: {
    targetKind: ArtifactTargetKind;
    targetId: string;
  }): Promise<CompiledArtifact | null>;
  setActiveArtifact(args: {
    targetKind: ArtifactTargetKind;
    targetId: string;
    artifactId: string;
  }): Promise<void>;
};

export type CorpusStorageDescriptor = {
  kind: "r2";
  bucketBinding: string;
  prefix: string;
};

export type CorpusRetrievalDescriptor = {
  kind: "ai-search";
  binding: string;
  namespace: string;
  instanceId: string;
  sourceMode: "external-r2" | "built-in-storage" | "hybrid";
};

export type CorpusDescriptor = {
  id: string;
  storage: CorpusStorageDescriptor;
  retrieval?: CorpusRetrievalDescriptor;
  metadata?: Record<string, unknown>;
};

export type CorpusSearchChunk = {
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

export type CorpusSearchResult = {
  query?: string;
  chunks: CorpusSearchChunk[];
  raw?: unknown;
};

export type CorpusFileHandle = {
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

export type CorpusSearchHandle = {
  search(args: {
    query?: string;
    messages?: ModelMessage[];
    filters?: Record<string, unknown>;
    maxResults?: number;
    instanceIds?: string[];
  }): Promise<CorpusSearchResult>;
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

export type CorpusWorkspace = {
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array): Promise<void>;
};

export type CorpusRuntimeHandle = {
  corpus: CorpusDescriptor;
  files: CorpusFileHandle;
  search?: CorpusSearchHandle;
  materializeToWorkspace?(args: {
    workspace: CorpusWorkspace;
    paths?: string[];
    destinationPrefix?: string;
    overwrite?: boolean;
  }): Promise<{
    corpusId: string;
    destinationPrefix: string;
    files: string[];
  }>;
};

export type CorpusProvider = {
  resolve(corpusId: string): Promise<CorpusRuntimeHandle>;
  list?(): Promise<CorpusDescriptor[]>;
};

export type RLMResource = {
  id?: string;
  name: string;
  path: string;
  kind:
    | "text"
    | "json"
    | "ndjson"
    | "binary"
    | "external-text"
    | "r2-text"
    | "url"
    | "inline";
  valueType?: string;
  size?: number;
  preview?: string;
  metadata?: Record<string, unknown>;
};

export type RLMPreparedContext = {
  contextRoot: string;
  manifestPath: string;
  resources: RLMResource[];
  manifestSummary: string;
  variablesInfo?: string;
  availableTools?: string;
  manifest?: unknown;
};

export type RLMQueryOptions = {
  label?: string;
  metadata?: Record<string, unknown>;
};

export type RLMQueryProvider = {
  query(prompt: string, options?: RLMQueryOptions): Promise<string>;
  batch(prompts: string[], options?: RLMQueryOptions): Promise<string[]>;
};

export type RLMExecuteStepRequest = {
  code: string;
  context: RLMPreparedContext;
  queryProvider?: RLMQueryProvider;
  tools?: Tool<any, any>[];
  maxOutputChars: number;
  maxQueryCalls: number;
  queryCallsUsed: number;
};

export type RLMExecuteStepResult = {
  stdout?: string;
  stderr?: string;
  logs?: string[];
  submitted?: unknown;
  queryCallsUsed: number;
  toolCalls?: ToolCallTrace[];
  error?: SerializedError | string;
};

export type RLMHistoryEntry = {
  reasoning?: string;
  code: string;
  output: string;
};

export type RLMSessionDescription = {
  trackedNames?: string[];
  runtimeState?: string;
};

export type RLMSessionCheckpoint = {
  preparedContext: RLMPreparedContext;
  history: RLMHistoryEntry[];
  nextIteration: number;
  llmCallsUsed: number;
  queryCallsUsed: number;
  stepGuidance: string;
  sampled: boolean;
  trace: RunTrace;
};

export type RLMSession = {
  sessionKind?: string;
  prepareContext(input: Record<string, unknown>): Promise<RLMPreparedContext>;
  describe?(): Promise<RLMSessionDescription>;
  executeStep(request: RLMExecuteStepRequest): Promise<RLMExecuteStepResult>;
  checkpoint?(value: RLMSessionCheckpoint): Promise<void>;
  resume?(): Promise<RLMSessionCheckpoint | null>;
  close(): Promise<void>;
};

export type RLMRuntime = {
  createSession(args: {
    runId: string;
    moduleId: string;
    env?: unknown;
    runtime?: RuntimeContext;
    tools?: Tool<any, any>[];
  }): Promise<RLMSession>;
};

export type RLMOptions = {
  runtime: RLMRuntime;
  queryProvider?: RLMQueryProvider;
  maxIterations?: number;
  maxLlmCalls?: number;
  maxQueryCalls?: number;
  maxOutputChars?: number;
  adapter?: Adapter;
  model?: RuntimeContext["model"];
  act?: {
    adapter?: Adapter;
    instructions?: TextParam;
  };
  extract?: {
    adapter?: Adapter;
    instructions?: TextParam;
    enabled?: boolean;
  };
  tools?: Tool<any, any>[];
  execution?: {
    durable?: boolean;
    fiberName?: string;
  };
  trace?: {
    includeCode?: boolean;
    includeStdout?: boolean;
    includeContextManifest?: boolean;
  };
};

export type TraceStore = {
  saveTrace(trace: RunTrace): Promise<void>;
  loadTrace(runId: string): Promise<RunTrace | null>;
  listTraces?(args?: {
    targetKind?: RunTrace["targetKind"];
    targetId?: string;
  }): Promise<RunTrace[]>;
};

export type TraceRedactor = {
  redactTrace(trace: RunTrace): RunTrace;
};

export type Logger = {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
};

export type RuntimeContext = {
  model: ModelHandle | ModelProvider;
  structuredGeneration: StructuredGenerationBridge;
  env?: unknown;
  traceStore?: TraceStore;
  artifactStore?: ArtifactStore;
  corpora?: CorpusProvider;
  redactor?: TraceRedactor;
  logger?: Logger;
  trace?: {
    sampleRate?: number;
    redact?: TraceRedactor;
  };
};

export type RunOptions = {
  candidate?: TextCandidate;
  artifact?: CompiledArtifact;
  runtime?: Partial<RuntimeContext>;
  history?: ModelMessage[];
  examples?: Example<any, any>[];
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type InspectOptions = Omit<RunOptions, "abortSignal">;

export type PromptInspection = AdapterOutput & {
  adapterId: string;
  adapterVersion: string;
  candidate: TextCandidate;
  outputSchemaSummary: string;
};

export type PredictModule<TInput, TOutput> = {
  kind: "predict";
  id: string;
  signature: Signature<any, any>;
  adapter: Adapter;
  (input: TInput, options?: RunOptions): Promise<TOutput>;
  runWithTrace(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>>;
  inspectTextCandidate(): TextCandidate;
  inspectPrompt(input: TInput, options?: InspectOptions): Promise<PromptInspection>;
  withCandidate(candidate: TextCandidate): PredictModule<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): PredictModule<TInput, TOutput>;
};

export type RLMModule<TInput, TOutput> = {
  kind: "rlm";
  id: string;
  name: string;
  signature: Signature<any, any>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  options: RLMOptions;
  (input: TInput, options?: RunOptions): Promise<TOutput>;
  runWithTrace(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>>;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): RLMModule<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): RLMModule<TInput, TOutput>;
  children(): ModuleChild[];
};

export type ProgramContext = {
  modules: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >;
  call<TInput, TOutput>(
    module:
      | PredictModule<TInput, TOutput>
      | Program<TInput, TOutput>
      | Tool<TInput, TOutput>
      | RLMModule<TInput, TOutput>,
    input: TInput,
    options?: RunOptions,
  ): Promise<TOutput>;
  log(message: string): void;
  trace: RunTrace;
  runtime: RuntimeContext;
};

export type Program<TInput, TOutput> = {
  kind: "program";
  id: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  run(ctx: ProgramContext, input: TInput): Promise<TOutput>;
  (input: TInput, options?: RunOptions): Promise<TOutput>;
  runWithTrace(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>>;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Program<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): Program<TInput, TOutput>;
  children(): ModuleChild[];
};

export type ToolContext = {
  log(message: string): void;
  runtime: RuntimeContext;
  trace?: RunTrace;
  sessionId?: string;
  bindingState?: ToolBindingState;
};

export type Tool<TInput, TOutput> = {
  kind: "tool";
  id: string;
  name: string;
  description: TextParam;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  inspectExecutionPlan(): ExecutionPlanTrace;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Tool<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): Tool<TInput, TOutput>;
};

export type Agent<
  TChat extends PredictModule<any, any> | Program<any, any> | RLMModule<any, any> =
    | PredictModule<any, any>
    | Program<any, any>
    | RLMModule<any, any>,
  TTool extends PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any> =
    | PredictModule<any, any>
    | Program<any, any>
    | Tool<any, any>
    | RLMModule<any, any>,
> = {
  kind: "agent";
  name: string;
  system: TextParam;
  chat: TChat;
  tools: TTool[];
  metadata?: Record<string, unknown>;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Agent<TChat, TTool>;
  withArtifact(artifact: CompiledArtifact): Agent<TChat, TTool>;
};

export type RpcSurface = {
  kind: "rpc";
  name: string;
  handlers: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >;
  metadata?: Record<string, unknown>;
};

export type McpSurface = {
  kind: "mcp";
  name: string;
  tools: Array<PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>>;
  metadata?: Record<string, unknown>;
};

export type Project = {
  kind: "project";
  programs: Array<PredictModule<any, any> | Program<any, any> | RLMModule<any, any>>;
  agents: Agent[];
  rpc: RpcSurface[];
  mcp: McpSurface[];
  corpora: CorpusDescriptor[];
  metadata?: Record<string, unknown>;
};

export type Optimizer<TTarget> = {
  id: string;
  version?: string;
  compile(args: {
    target: TTarget;
    trainset: Example<any, any>[];
    valset?: Example<any, any>[];
    metric: Metric<any, any, any>;
    objective: string;
    background?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CompiledArtifact>;
};

export type AnyRunnable = PredictModule<any, any> | Program<any, any> | RLMModule<any, any>;

export type AnyTarget = AnyRunnable | Tool<any, any> | Agent<any, any>;

export type InferInput<TTarget> =
  TTarget extends Signature<infer TInput, any>
    ? InferFields<TInput>
    : TTarget extends PredictModule<infer TInput, any>
      ? TInput
        : TTarget extends Program<infer TInput, any>
          ? TInput
          : TTarget extends RLMModule<infer TInput, any>
            ? TInput
          : TTarget extends Tool<infer TInput, any>
            ? TInput
          : never;

export type InferOutput<TTarget> =
  TTarget extends Signature<any, infer TOutput>
    ? InferFields<TOutput>
    : TTarget extends PredictModule<any, infer TOutput>
      ? TOutput
        : TTarget extends Program<any, infer TOutput>
          ? TOutput
          : TTarget extends RLMModule<any, infer TOutput>
            ? TOutput
          : TTarget extends Tool<any, infer TOutput>
            ? TOutput
          : never;
