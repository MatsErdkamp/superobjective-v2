export type TextCandidate = Record<string, string>;

export type GepaArtifactTargetKind = "predict" | "program" | "agent" | "rlm";

export type ReflectionPathKind =
  | "instructions"
  | "input_description"
  | "output_description"
  | "tool_description"
  | "agent_system";

export type AllowedCandidatePath = {
  path: string;
  currentValue: string;
  kind: ReflectionPathKind;
};

export type ReflectionExample = {
  input: unknown;
  expected: unknown;
  prediction: unknown;
  score: number;
  feedback?: string;
  logs?: string[];
  trace?: RunTraceLike;
  target?: {
    componentId: string;
    trace?: ComponentTraceLike;
  };
};

export type ReflectionModel = {
  generatePatch(args: {
    objective: string;
    background?: string;
    currentCandidate: TextCandidate;
    allowedPaths: AllowedCandidatePath[];
    examples: ReflectionExample[];
  }): Promise<{
    candidatePatch: Partial<TextCandidate>;
    rationale: string;
  }>;
};

export type GepaConfig = {
  maxMetricCalls?: number;
  reflectionBatchSize?: number;
  skipPerfectScores?: boolean;
  candidateSelection?: "pareto" | "best-score";
  reflectionModel?: ReflectionModel;
  mutation?: {
    maxPathsPerMutation?: number;
    allowNewPaths?: boolean;
  };
  scoring?: {
    aggregate?: "mean" | "median" | "weighted";
  };
  trace?: {
    includePrompts?: boolean;
    includeModelResponses?: boolean;
    includePassingExamples?: boolean;
  };
  maxTextLengthPerPath?: number;
  minTextLengthPerPath?: number;
};

export type ResolvedGepaConfig = {
  maxMetricCalls: number;
  reflectionBatchSize: number;
  skipPerfectScores: boolean;
  candidateSelection: "pareto" | "best-score";
  reflectionModel?: ReflectionModel;
  mutation: {
    maxPathsPerMutation: number;
    allowNewPaths: boolean;
  };
  scoring: {
    aggregate: "mean" | "median" | "weighted";
  };
  trace: {
    includePrompts: boolean;
    includeModelResponses: boolean;
    includePassingExamples: boolean;
  };
  maxTextLengthPerPath: number;
  minTextLengthPerPath: number;
};

export type ExampleLike<TInput = unknown, TExpected = unknown> = {
  id?: string;
  input: TInput;
  expected: TExpected;
  metadata?: Record<string, unknown>;
};

export type SerializedErrorLike = {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
};

export type ModelMessageLike = {
  role: string;
  content: unknown;
};

export type JsonSchemaLike = Record<string, unknown>;

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
    outputJsonSchema?: JsonSchemaLike;
  };
  stdout: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
};

export type ModelCallTraceLike = {
  provider: string;
  model: string;
  messages: ModelMessageLike[];
  outputJsonSchema?: JsonSchemaLike;
  rawResponse?: unknown;
  latencyMs?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
};

export type ToolCallTraceLike = {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: SerializedErrorLike;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
};

export type RunTraceLike = {
  runId: string;
  targetId: string;
  targetKind: GepaArtifactTargetKind | "rpc" | "mcp";
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
  metadata?: Record<string, unknown>;
};

export type ScoreLike = {
  score: number;
  feedback?: string;
  logs?: string[];
  stdout?: string;
  stderr?: string;
  trace?: RunTraceLike;
  attachments?: Array<{
    name: string;
    mediaType: string;
    data: unknown;
  }>;
  metadata?: Record<string, unknown>;
};

export type MetricTargetLike = {
  componentId: string;
  trace?: ComponentTraceLike;
};

export type MetricContextLike<TInput = unknown, TPrediction = unknown, TExpected = unknown> = {
  example: ExampleLike<TInput, TExpected>;
  prediction: TPrediction;
  expected: TExpected;
  trace: RunTraceLike;
  target?: MetricTargetLike;
  log(message: string): void;
};

export type MetricLike<TInput = unknown, TPrediction = unknown, TExpected = unknown> = {
  name: string;
  evaluate(ctx: MetricContextLike<TInput, TPrediction, TExpected>): Promise<ScoreLike> | ScoreLike;
};

export type GepaTargetLike<TInput = unknown, TOutput = unknown> = ((
  input: TInput,
  options?: unknown,
) => Promise<TOutput>) & {
  kind: GepaArtifactTargetKind;
  id: string;
  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): GepaTargetLike<TInput, TOutput>;
  adapter?: {
    id: string;
    version: string;
  };
};

export type GepaRunResult<TPrediction = unknown> = {
  prediction: TPrediction;
  trace?: RunTraceLike;
};

export type GepaExecutionHook<
  TInput = unknown,
  TPrediction = unknown,
  TExpected = unknown,
> = (args: {
  target: GepaTargetLike<TInput, TPrediction>;
  example: ExampleLike<TInput, TExpected>;
  candidate: TextCandidate;
  dataset: "train" | "val";
  signal?: AbortSignal;
}) => Promise<GepaRunResult<TPrediction>>;

export type GepaCompileArgs<TInput = unknown, TPrediction = unknown, TExpected = unknown> = {
  target: GepaTargetLike<TInput, TPrediction>;
  trainset: readonly ExampleLike<TInput, TExpected>[];
  valset?: readonly ExampleLike<TInput, TExpected>[];
  metric: MetricLike<TInput, TPrediction, TExpected>;
  objective: string;
  background?: string;
  reflectionModel?: ReflectionModel;
  execute?: GepaExecutionHook<TInput, TPrediction, TExpected>;
  signal?: AbortSignal;
};

export type CandidatePatchValidationIssue = {
  code:
    | "empty_patch"
    | "invalid_patch"
    | "too_many_paths"
    | "unknown_path"
    | "non_string_value"
    | "too_short"
    | "too_long"
    | "no_effect";
  message: string;
  path?: string;
};

export type CandidatePatchValidationResult = {
  ok: boolean;
  candidatePatch: Partial<TextCandidate>;
  changedPaths: string[];
  issues: CandidatePatchValidationIssue[];
};

export type EvaluatedExample<TInput = unknown, TPrediction = unknown, TExpected = unknown> = {
  exampleId: string;
  example: ExampleLike<TInput, TExpected>;
  prediction: TPrediction;
  score: number;
  feedback?: string;
  logs: string[];
  trace?: RunTraceLike;
  target?: MetricTargetLike;
  metric: ScoreLike;
};

export type CandidateEvaluation<TInput = unknown, TPrediction = unknown, TExpected = unknown> = {
  candidateId: string;
  candidate: TextCandidate;
  aggregateScore: number;
  perExampleScores: Record<string, number>;
  evaluatedExamples: EvaluatedExample<TInput, TPrediction, TExpected>[];
  feedbackSummary?: string;
};

export type FrontierSnapshot = {
  candidateId: string;
  parentId?: string;
  aggregateScore: number;
  textCandidate: TextCandidate;
  rationale?: string;
  feedbackSummary?: string;
};

export type CompiledArtifactLike = {
  id: string;
  target: {
    kind: GepaArtifactTargetKind;
    id: string;
  };
  optimizer: {
    id: "gepa";
    version: string;
    configHash: string;
  };
  textCandidate: TextCandidate;
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
  frontier?: FrontierSnapshot[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type GepaOptimizerLike = {
  id: "gepa";
  version: string;
  config: ResolvedGepaConfig;
  compile<TInput, TPrediction, TExpected>(
    args: GepaCompileArgs<TInput, TPrediction, TExpected>,
  ): Promise<CompiledArtifactLike>;
};
