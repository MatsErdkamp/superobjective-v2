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

export type MessagePart = string;

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
export type FieldMap = FieldRecord;

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
  componentId: string;
  componentKind: "predict" | "program" | "adapter" | "tool" | "rpc" | "mcp";
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
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
};

export type RunTrace = {
  runId: string;
  targetId: string;
  targetKind: "predict" | "program" | "agent" | "rpc" | "mcp";
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
  metadata?: Record<string, unknown>;
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

export type CompiledArtifact = {
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
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<CompiledArtifact[]>;
  loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<CompiledArtifact | null>;
  setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void>;
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
  traceStore?: TraceStore;
  artifactStore?: ArtifactStore;
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
  inspectTextCandidate(): TextCandidate;
  inspectPrompt(input: TInput, options?: InspectOptions): Promise<PromptInspection>;
  withCandidate(candidate: TextCandidate): PredictModule<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): PredictModule<TInput, TOutput>;
};

export type ProgramContext = {
  call<TInput, TOutput>(
    module: PredictModule<TInput, TOutput> | Program<TInput, TOutput> | Tool<TInput, TOutput>,
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
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Program<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): Program<TInput, TOutput>;
};

export type ToolContext = {
  log(message: string): void;
  runtime: RuntimeContext;
  trace?: RunTrace;
};

export type Tool<TInput, TOutput> = {
  kind: "tool";
  name: string;
  description: TextParam;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Tool<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): Tool<TInput, TOutput>;
};

export type Agent<
  TChat extends PredictModule<any, any> | Program<any, any> =
    | PredictModule<any, any>
    | Program<any, any>,
  TTool extends PredictModule<any, any> | Tool<any, any> = PredictModule<any, any> | Tool<any, any>,
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
  handlers: Record<string, PredictModule<any, any> | Program<any, any>>;
  metadata?: Record<string, unknown>;
};

export type McpSurface = {
  kind: "mcp";
  name: string;
  tools: Array<PredictModule<any, any> | Tool<any, any>>;
  metadata?: Record<string, unknown>;
};

export type Project = {
  kind: "project";
  programs: Array<PredictModule<any, any> | Program<any, any>>;
  agents: Agent[];
  rpc: RpcSurface[];
  mcp: McpSurface[];
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

export type CompileOptions<TTarget> = Parameters<Optimizer<TTarget>["compile"]>[0];

export type AnyRunnable = PredictModule<any, any> | Program<any, any>;

export type AnyTarget = AnyRunnable | Tool<any, any> | Agent<any, any>;

export type InferInput<TTarget> =
  TTarget extends Signature<infer TInput, any>
    ? InferFields<TInput>
    : TTarget extends PredictModule<infer TInput, any>
      ? TInput
      : TTarget extends Program<infer TInput, any>
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
        : TTarget extends Tool<any, infer TOutput>
          ? TOutput
          : never;
