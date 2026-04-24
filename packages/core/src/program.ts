import type {
  CompiledArtifact,
  PredictModule,
  Program,
  ProgramContext,
  RLMModule,
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
import { chooseArtifactCandidate, serializeError } from "./utils.js";
import type { Tool } from "./types.js";

type ProgramInternalOptions = RunOptions & {
  __execution?: ExecutionState;
};

type ProgramState<TInput, TOutput> = {
  id: string;
  inputSchema: Program<TInput, TOutput>["inputSchema"];
  outputSchema: Program<TInput, TOutput>["outputSchema"];
  run(ctx: ProgramContext, input: TInput): Promise<TOutput>;
  candidate?: TextCandidate;
  artifact?: CompiledArtifact;
};

export function program<TInput, TOutput>(value: {
  name: string;
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
      inspectTextCandidate() {
        return mergeCandidates(chooseArtifactCandidate(state.artifact), state.candidate);
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
    id: value.name,
    inputSchema: value.input,
    outputSchema: value.output,
    run: async (ctx, input) => value.run(ctx, input),
  });
}

async function executeProgram<TInput, TOutput>(
  state: ProgramState<TInput, TOutput>,
  input: TInput,
  options?: RunOptions,
): Promise<TOutput> {
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
      async call(module, moduleInput, moduleOptions) {
        if (isTool(module)) {
          const toolStartedAt = new Date().toISOString();
          const toolStartedAtMs = Date.now();

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

    if (!internalOptions?.__execution) {
      await finalizeExecution(execution, { output });
    }

    return output;
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
