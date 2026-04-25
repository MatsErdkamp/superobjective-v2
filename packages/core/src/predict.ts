import type {
  Adapter,
  AdapterOutput,
  CompiledArtifact,
  ModelProvider,
  PredictModule,
  PromptInspection,
  RunResult,
  RunOptions,
  RuntimeContext,
  Signature,
  TextCandidate,
} from "./types.js";
import { hashCandidate, mergeCandidates } from "./candidate.js";
import {
  finalizeExecution,
  createExecutionState,
  failComponent,
  finishComponent,
  recordModelCall,
  type ExecutionState,
  startComponent,
} from "./execution.js";
import { adapters } from "./adapters.js";
import {
  mergeWithSeedCandidate,
  outputSchemaSummary,
  signatureToInputZodSchema,
} from "./schema.js";
import { getRuntimeContext } from "./runtime.js";
import { chooseArtifactCandidate, createId, describeModelHandle } from "./utils.js";

type PredictInternalOptions = RunOptions & {
  __execution?: ExecutionState;
  __parentSpanId?: string;
};

type PredictState = {
  signature: Signature<any, any>;
  adapter: Adapter;
  id: string;
  model?: RuntimeContext["model"];
  candidate?: TextCandidate;
  artifact?: CompiledArtifact;
};

export function predict<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
>(
  signatureValue: Signature<any, any>,
  options?: {
    adapter?: Adapter;
    model?: RuntimeContext["model"];
  },
): PredictModule<TInput, TOutput> {
  const build = (state: PredictState): PredictModule<TInput, TOutput> => {
    const callable = async (input: TInput, runOptions?: RunOptions): Promise<TOutput> =>
      executePredict(state, input, runOptions);

    return Object.assign(callable, {
      kind: "predict" as const,
      id: state.id,
      signature: state.signature,
      adapter: state.adapter,
      runWithTrace(input: TInput, runOptions?: RunOptions): Promise<RunResult<TOutput>> {
        return executePredictWithTrace(state, input, runOptions);
      },
      inspectTextCandidate() {
        return mergeWithSeedCandidate(
          state.signature,
          chooseArtifactCandidate(state.artifact),
          state.candidate,
        );
      },
      async inspectPrompt(input: TInput, inspectOptions?: RunOptions): Promise<PromptInspection> {
        const runtime = resolveRuntime(state, inspectOptions);
        const candidate = await resolveActiveCandidate(state, runtime, inspectOptions);
        const rendered = await state.adapter.format({
          signature: state.signature,
          candidate,
          input,
          ...(inspectOptions?.examples ? { examples: inspectOptions.examples } : {}),
          ...(inspectOptions?.history ? { history: inspectOptions.history } : {}),
        });

        return {
          ...rendered,
          adapterId: state.adapter.id,
          adapterVersion: state.adapter.version,
          candidate,
          outputSchemaSummary: outputSchemaSummary(rendered.output.jsonSchema),
        };
      },
      withCandidate(candidate: TextCandidate) {
        return build({
          ...state,
          candidate: mergeCandidates(state.candidate, candidate),
        });
      },
      withArtifact(artifact: CompiledArtifact) {
        return build({
          ...state,
          artifact,
        });
      },
    });
  };

  return build({
    signature: signatureValue,
    adapter: options?.adapter ?? adapters.xml(),
    id: signatureValue.name,
    ...(options?.model ? { model: options.model } : {}),
  });
}

async function executePredict<TInput, TOutput>(
  state: PredictState,
  input: TInput,
  options?: RunOptions,
): Promise<TOutput> {
  const result = await executePredictWithTrace<TInput, TOutput>(state, input, options);
  return result.output;
}

async function executePredictWithTrace<TInput, TOutput>(
  state: PredictState,
  input: TInput,
  options?: RunOptions,
): Promise<RunResult<TOutput>> {
  const internalOptions = options as PredictInternalOptions | undefined;
  const runtime = resolveRuntime(state, options);
  const execution =
    internalOptions?.__execution ??
    createExecutionState({
      runtime,
      targetId: state.id,
      targetKind: "predict",
      input,
      ...(options?.metadata ? { metadata: options.metadata } : {}),
    });

  const component = startComponent(execution, {
    componentId: state.id,
    componentKind: "predict",
    input,
    ...(internalOptions?.__parentSpanId ? { parentSpanId: internalOptions.__parentSpanId } : {}),
  });

  try {
    const candidate = await resolveActiveCandidate(state, runtime, options);
    component.candidate = {
      paths: Object.keys(candidate).sort(),
      hash: hashCandidate(candidate),
    };

    const inputSchema = signatureToInputZodSchema({
      signature: state.signature,
      candidate,
    });
    const validatedInput = inputSchema.parse(input);
    const rendered = await state.adapter.format({
      signature: state.signature,
      candidate,
      input: validatedInput,
      ...(options?.examples ? { examples: options.examples } : {}),
      ...(options?.history ? { history: options.history } : {}),
    });

    component.prompt = {
      adapterId: state.adapter.id,
      adapterVersion: state.adapter.version,
      messages: rendered.messages,
      outputJsonSchema: rendered.output.jsonSchema,
    };

    const model = runtime.model;
    const startedAt = Date.now();

    let structuredObject: unknown;

    try {
      const result = await runtime.structuredGeneration.generateObject({
        model,
        messages: rendered.messages,
        schema: rendered.output.zodSchema as any,
        ...(rendered.output.name ? { schemaName: rendered.output.name } : {}),
        ...(rendered.output.description ? { schemaDescription: rendered.output.description } : {}),
        ...(rendered.output.strict !== undefined ? { strict: rendered.output.strict } : {}),
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      structuredObject = result.object;
      recordModelCall(execution, {
        spanId: createId("span"),
        ...(component.spanId ? { parentSpanId: component.spanId } : {}),
        ...describeModelHandle(model),
        messages: rendered.messages,
        outputJsonSchema: rendered.output.jsonSchema,
        ...(result.rawResponse !== undefined ? { rawResponse: result.rawResponse } : {}),
        latencyMs: Date.now() - startedAt,
        ...(result.usage ? { tokenUsage: result.usage } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      });
    } catch (structuredError) {
      const fallback = await maybeRunFallback(runtime, rendered, options);
      if (!fallback.used) {
        throw structuredError;
      }
      structuredObject = fallback.value;
    }

    const parsedStructured = state.adapter.parseStructured
      ? await state.adapter.parseStructured({
          signature: state.signature,
          value: structuredObject,
        })
      : structuredObject;

    const output = rendered.output.zodSchema.parse(parsedStructured) as TOutput;
    finishComponent(component, output);

    const trace = internalOptions?.__execution
      ? execution.trace
      : await finalizeExecution(execution, { output });

    return { output, trace };
  } catch (error) {
    failComponent(component, error);
    if (!internalOptions?.__execution) {
      await finalizeExecution(execution, { error });
    }
    throw error;
  }
}

function resolveRuntime(state: PredictState, options?: RunOptions): RuntimeContext {
  return getRuntimeContext({
    ...options?.runtime,
    ...(state.model ? { model: state.model } : {}),
  });
}

async function resolveActiveCandidate(
  state: PredictState,
  runtime: RuntimeContext,
  options?: RunOptions,
): Promise<TextCandidate> {
  const activeArtifact = runtime.artifactStore
    ? await runtime.artifactStore.loadActiveArtifact({
        targetKind: "predict",
        targetId: state.id,
      })
    : null;

  return mergeWithSeedCandidate(
    state.signature,
    chooseArtifactCandidate(activeArtifact ?? undefined),
    chooseArtifactCandidate(state.artifact),
    chooseArtifactCandidate(options?.artifact),
    state.candidate,
    options?.candidate,
  );
}

function hasCompleteModelProvider(
  model: RuntimeContext["model"],
): model is ModelProvider & { complete: NonNullable<ModelProvider["complete"]> } {
  return (
    typeof model === "object" &&
    model !== null &&
    "complete" in model &&
    typeof model.complete === "function"
  );
}

async function maybeRunFallback(
  runtime: RuntimeContext,
  rendered: AdapterOutput,
  options: RunOptions | undefined,
): Promise<{
  used: boolean;
  value?: unknown;
}> {
  if (!rendered.fallback) {
    return { used: false };
  }

  const model = runtime.model;
  if (hasCompleteModelProvider(model)) {
    const response = await model.complete({
      messages: rendered.messages,
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    return {
      used: true,
      value: await rendered.fallback.parse(response.text),
    };
  }

  return { used: false };
}
