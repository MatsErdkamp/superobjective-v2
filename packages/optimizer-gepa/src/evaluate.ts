import { hashTextCandidate } from "./candidate.js";
import type {
  CandidateEvaluation,
  ComponentTraceLike,
  EvaluatedExample,
  ExampleLike,
  GepaExecutionHook,
  GepaTargetLike,
  MetricLike,
  MetricTargetLike,
  ResolvedGepaConfig,
  RunTraceLike,
  TextCandidate,
} from "./types.js";
import { assertNotAborted, mean, median, nowIso, summarizeUnique } from "./utils.js";

export async function evaluateCandidate<TInput, TPrediction, TExpected>(args: {
  target: GepaTargetLike<TInput, TPrediction>;
  candidate: TextCandidate;
  examples: readonly ExampleLike<TInput, TExpected>[];
  metric: MetricLike<TInput, TPrediction, TExpected>;
  dataset: "train" | "val";
  config: ResolvedGepaConfig;
  execute?: GepaExecutionHook<TInput, TPrediction, TExpected>;
  signal?: AbortSignal;
}): Promise<CandidateEvaluation<TInput, TPrediction, TExpected>> {
  const evaluatedExamples: EvaluatedExample<TInput, TPrediction, TExpected>[] = [];
  const perExampleScores: Record<string, number> = {};

  for (const [index, example] of args.examples.entries()) {
    assertNotAborted(args.signal);

    const execution = await executeExample({
      target: args.target,
      example,
      candidate: args.candidate,
      dataset: args.dataset,
      ...(args.execute ? { execute: args.execute } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    const fallbackTrace =
      execution.trace ??
      createSyntheticTrace({
        target: args.target,
        input: example.input,
        output: execution.prediction,
      });

    const collectedLogs: string[] = [];
    const metricTarget = resolveMetricTarget(fallbackTrace, args.target);
    const metricResult = await args.metric.evaluate({
      example,
      prediction: execution.prediction,
      expected: example.expected,
      trace: fallbackTrace,
      ...(metricTarget ? { target: metricTarget } : {}),
      log(message: string) {
        collectedLogs.push(message);
      },
    });

    if (!Number.isFinite(metricResult.score)) {
      throw new TypeError("Metrics used by GEPA must return a finite numeric score.");
    }

    const activeTrace = metricResult.trace ?? fallbackTrace;
    const exampleId = example.id ?? `${args.dataset}-${index + 1}`;
    const logs = [...collectedLogs, ...(metricResult.logs ?? [])];
    const activeTarget = resolveMetricTarget(activeTrace, args.target);

    evaluatedExamples.push({
      exampleId,
      example,
      prediction: execution.prediction,
      score: metricResult.score,
      ...(metricResult.feedback ? { feedback: metricResult.feedback } : {}),
      logs,
      ...(activeTrace ? { trace: activeTrace } : {}),
      ...(activeTarget ? { target: activeTarget } : {}),
      metric: metricResult,
    });

    perExampleScores[exampleId] = metricResult.score;
  }

  const feedbackSummary = buildFeedbackSummary(evaluatedExamples);

  return {
    candidateId: hashTextCandidate(args.candidate),
    candidate: args.candidate,
    aggregateScore: aggregateScores(
      evaluatedExamples.map((example) => example.score),
      args.config,
    ),
    perExampleScores,
    evaluatedExamples,
    ...(feedbackSummary ? { feedbackSummary } : {}),
  };
}

export function selectReflectionExamples<TInput, TPrediction, TExpected>(
  evaluation: CandidateEvaluation<TInput, TPrediction, TExpected>,
  config: ResolvedGepaConfig,
): CandidateEvaluation<TInput, TPrediction, TExpected>["evaluatedExamples"] {
  const filtered = evaluation.evaluatedExamples
    .filter((example) => {
      if (!config.trace.includePassingExamples && example.score >= 1) {
        return false;
      }

      if (config.skipPerfectScores && example.score >= 1) {
        return false;
      }

      return true;
    })
    .sort((left, right) => left.score - right.score);

  return filtered.slice(0, config.reflectionBatchSize).map((example) => ({
    ...example,
    ...(example.trace ? { trace: pruneTraceForReflection(example.trace, config) } : {}),
  }));
}

function aggregateScores(
  scores: readonly number[],
  config: Pick<ResolvedGepaConfig, "scoring">,
): number {
  if (config.scoring.aggregate === "median") {
    return median(scores);
  }

  // Weighted aggregation is intentionally a seam for future per-example weights.
  return mean(scores);
}

async function executeExample<TInput, TPrediction, TExpected>(args: {
  target: GepaTargetLike<TInput, TPrediction>;
  example: ExampleLike<TInput, TExpected>;
  candidate: TextCandidate;
  dataset: "train" | "val";
  execute?: GepaExecutionHook<TInput, TPrediction, TExpected>;
  signal?: AbortSignal;
}): Promise<{
  prediction: TPrediction;
  trace?: RunTraceLike;
}> {
  if (args.execute) {
    return args.execute(args);
  }

  const candidateBoundTarget = args.target.withCandidate(args.candidate);
  const traceCapture = createTraceCapture();
  const rawResult = await candidateBoundTarget(args.example.input, {
    runtime: {
      traceStore: traceCapture.store,
      trace: {
        sampleRate: 1,
      },
    },
    metadata: {
      optimizer: "gepa",
      dataset: args.dataset,
      candidateId: hashTextCandidate(args.candidate),
      ...(args.example.id ? { exampleId: args.example.id } : {}),
    },
    ...(args.signal ? { abortSignal: args.signal } : {}),
  });

  if (looksLikeRunResult(rawResult)) {
    const trace = rawResult.trace ?? traceCapture.latest();
    return {
      prediction: rawResult.output as TPrediction,
      ...(trace ? { trace } : {}),
    };
  }

  const trace = traceCapture.latest();
  return {
    prediction: rawResult as TPrediction,
    ...(trace ? { trace } : {}),
  };
}

function createTraceCapture(): {
  store: {
    saveTrace(trace: RunTraceLike): Promise<void>;
    loadTrace(runId: string): Promise<RunTraceLike | null>;
    listTraces(args?: {
      targetKind?: RunTraceLike["targetKind"];
      targetId?: string;
    }): Promise<RunTraceLike[]>;
  };
  latest(): RunTraceLike | undefined;
} {
  const traces: RunTraceLike[] = [];

  return {
    store: {
      async saveTrace(trace) {
        traces.push(trace);
      },
      async loadTrace(runId) {
        return traces.find((trace) => trace.runId === runId) ?? null;
      },
      async listTraces(args) {
        return traces.filter((trace) => {
          if (args?.targetKind && trace.targetKind !== args.targetKind) {
            return false;
          }

          if (args?.targetId && trace.targetId !== args.targetId) {
            return false;
          }

          return true;
        });
      },
    },
    latest() {
      return traces[traces.length - 1];
    },
  };
}

function looksLikeRunResult(value: unknown): value is {
  output: unknown;
  trace?: RunTraceLike;
} {
  return Boolean(value && typeof value === "object" && "output" in value && "trace" in value);
}

function createSyntheticTrace(args: {
  target: Pick<GepaTargetLike, "id" | "kind">;
  input: unknown;
  output: unknown;
}): RunTraceLike {
  const timestamp = nowIso();

  return {
    runId: `synthetic:${args.target.id}:${timestamp}`,
    targetId: args.target.id,
    targetKind: args.target.kind,
    startedAt: timestamp,
    endedAt: timestamp,
    input: args.input,
    output: args.output,
    stdout: "",
    components: [],
    modelCalls: [],
    toolCalls: [],
  };
}

function resolveMetricTarget(
  trace: RunTraceLike | undefined,
  target: Pick<GepaTargetLike, "id">,
): MetricTargetLike | undefined {
  if (!trace || trace.components.length === 0) {
    return undefined;
  }

  const matchingComponent =
    trace.components.find((component) => component.componentId === target.id) ??
    trace.components[0];

  if (!matchingComponent) {
    return undefined;
  }

  return {
    componentId: matchingComponent.componentId,
    trace: matchingComponent,
  };
}

function pruneTraceForReflection(trace: RunTraceLike, config: ResolvedGepaConfig): RunTraceLike {
  return {
    ...trace,
    components: trace.components.map((component) =>
      pruneComponentTraceForReflection(component, config),
    ),
    modelCalls: trace.modelCalls.map((modelCall) => {
      if (config.trace.includeModelResponses) {
        return modelCall;
      }

      const { rawResponse: _rawResponse, ...withoutRawResponse } = modelCall;
      return withoutRawResponse;
    }),
  };
}

function pruneComponentTraceForReflection(
  component: ComponentTraceLike,
  config: ResolvedGepaConfig,
): ComponentTraceLike {
  return {
    ...component,
    ...(component.prompt
      ? {
          prompt: config.trace.includePrompts
            ? component.prompt
            : {
                adapterId: component.prompt.adapterId,
                adapterVersion: component.prompt.adapterVersion,
                messages: [],
                ...(component.prompt.outputJsonSchema
                  ? { outputJsonSchema: component.prompt.outputJsonSchema }
                  : {}),
              },
        }
      : {}),
  };
}

function buildFeedbackSummary<TInput, TPrediction, TExpected>(
  evaluatedExamples: readonly EvaluatedExample<TInput, TPrediction, TExpected>[],
): string | undefined {
  return summarizeUnique(
    evaluatedExamples.flatMap((example) => {
      const values: string[] = [];

      if (example.feedback) {
        values.push(example.feedback);
      }

      values.push(...example.logs);
      return values;
    }),
  );
}
