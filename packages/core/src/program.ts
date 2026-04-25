import type {
  CompiledArtifact,
  ModuleChild,
  PredictModule,
  Program,
  ProgramContext,
  RLMModule,
  RunResult,
  RunOptions,
  RuntimeContext,
  TextCandidate,
} from "./types.js";
import {
  createExecutionState,
  failComponent,
  finalizeExecution,
  finishComponent,
  logToTrace,
  recordToolCall,
  type ExecutionState,
  startComponent,
} from "./execution.js";
import { getRuntimeContext } from "./runtime.js";
import { mergeCandidates } from "./candidate.js";
import { chooseArtifactCandidate, createId, serializeError } from "./utils.js";
import type { Tool } from "./types.js";

type ProgramInternalOptions = RunOptions & {
  __execution?: ExecutionState;
  __parentSpanId?: string;
};

type ProgramState<TInput, TOutput> = {
  id: string;
  inputSchema: Program<TInput, TOutput>["inputSchema"];
  outputSchema: Program<TInput, TOutput>["outputSchema"];
  run(ctx: ProgramContext, input: TInput): Promise<TOutput>;
  candidate?: TextCandidate;
  artifact?: CompiledArtifact;
  modules: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >;
  dynamicChildren: Map<string, ModuleChild>;
};

export function program<TInput, TOutput>(value: {
  name: string;
  modules?: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >;
  input: Program<TInput, TOutput>["inputSchema"];
  output: Program<TInput, TOutput>["outputSchema"];
  run(ctx: ProgramContext, input: TInput): Promise<TOutput>;
}): Program<TInput, TOutput> {
  const build = (state: ProgramState<TInput, TOutput>): Program<TInput, TOutput> => {
    const run: Program<TInput, TOutput>["run"] = async (ctx, input) => state.run(ctx, input);
    const callable = async (input: TInput, options?: RunOptions): Promise<TOutput> =>
      executeProgram(state, input, options);

    return Object.assign(callable, {
      kind: "program" as const,
      id: state.id,
      inputSchema: state.inputSchema,
      outputSchema: state.outputSchema,
      run,
      runWithTrace(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>> {
        return executeProgramWithTrace(state, input, options);
      },
      inspectTextCandidate() {
        return mergeCandidates(
          ...Object.values(state.modules).map((module) => module.inspectTextCandidate()),
          chooseArtifactCandidate(state.artifact),
          state.candidate,
        );
      },
      withCandidate(candidate: TextCandidate) {
        return build({
          ...state,
          modules: mapProgramModules(state.modules, (module) => module.withCandidate(candidate)),
          candidate: mergeCandidates(state.candidate, candidate),
        });
      },
      withArtifact(artifact: CompiledArtifact) {
        return build({
          ...state,
          modules: mapProgramModules(state.modules, (module) => module.withArtifact(artifact)),
          artifact,
        });
      },
      children() {
        const registeredChildren = Object.values(state.modules).map((module) => moduleChild(module));
        const childrenByKey = new Map<string, ModuleChild>();
        for (const child of [...registeredChildren, ...state.dynamicChildren.values()]) {
          childrenByKey.set(`${child.kind}:${child.id}`, child);
        }
        return [...childrenByKey.values()];
      },
    });
  };

  return build({
    id: value.name,
    inputSchema: value.input,
    outputSchema: value.output,
    run: async (ctx, input) => value.run(ctx, input),
    modules: value.modules ?? {},
    dynamicChildren: new Map(),
  });
}

async function executeProgram<TInput, TOutput>(
  state: ProgramState<TInput, TOutput>,
  input: TInput,
  options?: RunOptions,
): Promise<TOutput> {
  const result = await executeProgramWithTrace<TInput, TOutput>(state, input, options);
  return result.output;
}

async function executeProgramWithTrace<TInput, TOutput>(
  state: ProgramState<TInput, TOutput>,
  input: TInput,
  options?: RunOptions,
): Promise<RunResult<TOutput>> {
  const internalOptions = options as ProgramInternalOptions | undefined;
  const runtime = resolveRuntime(options);
  const execution =
    internalOptions?.__execution ??
    createExecutionState({
      runtime,
      targetId: state.id,
      targetKind: "program",
      input,
      ...(options?.metadata ? { metadata: options.metadata } : {}),
    });

  const component = startComponent(execution, {
    componentId: state.id,
    componentKind: "program",
    input,
    ...(internalOptions?.__parentSpanId ? { parentSpanId: internalOptions.__parentSpanId } : {}),
  });

  try {
    const validatedInput = state.inputSchema.parse(input);
    const inheritedCandidate = mergeCandidates(
      chooseArtifactCandidate(state.artifact),
      state.candidate,
      chooseArtifactCandidate(options?.artifact),
      options?.candidate,
    );

    const ctx: ProgramContext = {
      modules: state.modules,
      async call(module, moduleInput, moduleOptions) {
        registerProgramChild(state, module);
        if (isTool(module)) {
          const toolStartedAt = new Date().toISOString();
          const toolStartedAtMs = Date.now();
          const toolSpanId = createId("span");

          try {
            const toolOutput = await module.execute(moduleInput, {
              runtime,
              trace: execution.trace,
              log(message) {
                logToTrace(execution, component, message);
              },
            });

            const validatedToolOutput =
              module.outputSchema != null ? module.outputSchema.parse(toolOutput) : toolOutput;

            recordToolCall(execution, {
              spanId: toolSpanId,
              ...(component.spanId ? { parentSpanId: component.spanId } : {}),
              toolName: module.name,
              input: moduleInput,
              output: validatedToolOutput,
              startedAt: toolStartedAt,
              endedAt: new Date().toISOString(),
              latencyMs: Date.now() - toolStartedAtMs,
              metadata: {
                source: "program-context",
                callerComponentId: state.id,
              },
            });

            return validatedToolOutput;
          } catch (error) {
            recordToolCall(execution, {
              spanId: toolSpanId,
              ...(component.spanId ? { parentSpanId: component.spanId } : {}),
              toolName: module.name,
              input: moduleInput,
              error: serializeError(error),
              startedAt: toolStartedAt,
              endedAt: new Date().toISOString(),
              latencyMs: Date.now() - toolStartedAtMs,
              metadata: {
                source: "program-context",
                callerComponentId: state.id,
              },
            });
            throw error;
          }
        }

        const mergedOptions: ProgramInternalOptions = {
          ...options,
          ...moduleOptions,
          runtime,
          __execution: execution,
          ...(component.spanId ? { __parentSpanId: component.spanId } : {}),
          ...(moduleOptions?.candidate
            ? { candidate: moduleOptions.candidate }
            : Object.keys(inheritedCandidate).length > 0
              ? { candidate: inheritedCandidate }
              : {}),
          ...((moduleOptions?.artifact ?? options?.artifact ?? state.artifact)
            ? {
                artifact: moduleOptions?.artifact ?? options?.artifact ?? state.artifact,
              }
            : {}),
        };
        return module(moduleInput, mergedOptions);
      },
      log(message) {
        logToTrace(execution, component, message);
      },
      trace: execution.trace,
      runtime,
    };

    const result = await state.run(ctx, validatedInput);
    const output = state.outputSchema.parse(result);
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

function isTool<TInput, TOutput>(
  value:
    | PredictModule<TInput, TOutput>
    | Program<TInput, TOutput>
    | Tool<TInput, TOutput>
    | RLMModule<TInput, TOutput>,
): value is Tool<TInput, TOutput> {
  return "execute" in value && typeof value.execute === "function";
}

function resolveRuntime(options?: RunOptions): RuntimeContext {
  return getRuntimeContext(options?.runtime);
}

function registerProgramChild<TInput, TOutput>(
  state: ProgramState<TInput, TOutput>,
  module:
    | PredictModule<any, any>
    | Program<any, any>
    | Tool<any, any>
    | RLMModule<any, any>,
): void {
  const child = moduleChild(module);
  state.dynamicChildren.set(`${child.kind}:${child.id}`, child);
}

function moduleChild(
  module:
    | PredictModule<any, any>
    | Program<any, any>
    | Tool<any, any>
    | RLMModule<any, any>,
): ModuleChild {
  if (module.kind === "predict" || module.kind === "rlm") {
    return {
      kind: module.kind,
      id: module.id,
      name: module.signature.name,
    };
  }

  return {
    kind: module.kind,
    id: module.id,
    name: module.kind === "program" ? module.id : module.name,
  };
}

function mapProgramModules(
  modules: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >,
  mapModule: (
    module: PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>,
  ) => PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>,
): Record<
  string,
  PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
> {
  return Object.fromEntries(
    Object.entries(modules).map(([name, module]) => [name, mapModule(module)]),
  );
}
