import { z } from "zod";

import {
  createExecutionState,
  failComponent,
  finalizeExecution,
  finishComponent,
  logToTrace,
  recordToolCall,
  startComponent,
  type ExecutionState,
} from "./execution.js";
import { predict } from "./predict.js";
import { getRuntimeContext } from "./runtime.js";
import { input, signature, signatureToInputZodSchema, signatureToOutputZodSchema, text } from "./schema.js";
import { chooseArtifactCandidate, mergeCandidates, serializeError, stableStringify } from "./utils.js";
import type {
  CompiledArtifact,
  ModelMessage,
  PredictModule,
  ProgrammableStepTrace,
  RLMExecuteStepResult,
  RLMHistoryEntry,
  RLMModule,
  RLMOptions,
  RLMPreparedContext,
  RLMSessionCheckpoint,
  RunOptions,
  RuntimeContext,
  SerializedError,
  Signature,
  TextCandidate,
  TextParam,
  ToolCallTrace,
} from "./types.js";

const DEFAULT_ACT_INSTRUCTIONS = text({
  value: [
    "You are operating a JavaScript RLM over external context.",
    "The full context is part of the runtime environment, not fully embedded in this prompt.",
    "Write code, observe the output, then write more code based on what you learned.",
    "This is iterative. Do not try to solve everything in one step.",
    "Explore first: inspect the available inputs and resources before processing them deeply.",
    "Iterate with small code snippets, print concrete observations, and preserve useful variables across steps.",
    "Use llm_query or llm_query_batched for semantic analysis after you have located a bounded subproblem.",
    "Minimize retyping. Reuse variables, parsed values, and exact strings from prior steps instead of copying them manually.",
    "Verify concrete evidence before calling SUBMIT.",
    "Call SUBMIT only with the final typed output object.",
    "Return only JavaScript or TypeScript code for the next step.",
  ].join("\n"),
  optimize: true,
});

const DEFAULT_EXTRACT_INSTRUCTIONS = text({
  value: "Produce the final structured output from the prepared context summary and prior RLM trajectory.",
  optimize: true,
});

type RlmInternalOptions = RunOptions & {
  __execution?: ExecutionState;
};

type RlmState<TInput, TOutput> = {
  id: string;
  name: string;
  signature: Signature<any, any>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  options: RLMOptions;
  model?: RuntimeContext["model"];
      act: PredictModule<
        {
          contextRoot: string;
          contextManifest: string;
          variablesInfo: string;
          availableTools: string;
          replHistory: string;
          iteration: string;
          llmBudget: string;
      queryBudget: string;
      stepGuidance: string;
    },
    {
      reasoning: string;
      code: string;
    }
  >;
      extract: PredictModule<
        {
          contextRoot: string;
          contextManifest: string;
          variablesInfo: string;
          availableTools: string;
          replHistory: string;
        },
        TOutput
  >;
  candidate?: TextCandidate;
  artifact?: CompiledArtifact;
};

export function rlm<TInput extends Record<string, unknown>, TOutput extends Record<string, unknown>>(
  signatureValue: Signature<any, any>,
  options: RLMOptions,
): RLMModule<TInput, TOutput> {
  const build = (state: RlmState<TInput, TOutput>): RLMModule<TInput, TOutput> => {
    const callable = async (input: TInput, runOptions?: RunOptions): Promise<TOutput> =>
      executeRlm(state, input, runOptions);

    const rlmModule = Object.assign(callable, {
      kind: "rlm" as const,
      id: state.id,
      signature: state.signature,
      inputSchema: state.inputSchema,
      outputSchema: state.outputSchema,
      options: state.options,
      inspectTextCandidate() {
        return mergeCandidates(
          extractRlmSeedCandidate(state),
          state.act.inspectTextCandidate(),
          state.extract.inspectTextCandidate(),
        );
      },
      withCandidate(candidate: TextCandidate) {
        return build({
          ...state,
          act: state.act.withCandidate(candidate),
          extract: state.extract.withCandidate(candidate),
          candidate: mergeCandidates(state.candidate, candidate),
        });
      },
      withArtifact(artifact: CompiledArtifact) {
        return build({
          ...state,
          act: state.act.withArtifact(artifact),
          extract: state.extract.withArtifact(artifact),
          artifact,
        });
      },
      children() {
        return [
          {
            kind: "predict" as const,
            id: state.act.id,
            name: state.act.signature.name,
          },
          {
            kind: "predict" as const,
            id: state.extract.id,
            name: state.extract.signature.name,
          },
        ];
      },
    });

    Object.defineProperty(rlmModule, "name", {
      value: state.name,
      configurable: true,
    });

    return rlmModule as RLMModule<TInput, TOutput>;
  };

  const actSignature = buildActSignature(signatureValue, options.act?.instructions);
  const extractSignature = buildExtractSignature(signatureValue, options.extract?.instructions);

  return build({
    id: signatureValue.name,
    name: signatureValue.name,
    signature: signatureValue,
    inputSchema: signatureToInputZodSchema({
      signature: signatureValue,
    }) as z.ZodType<TInput>,
    outputSchema: signatureToOutputZodSchema({
      signature: signatureValue,
    }) as z.ZodType<TOutput>,
    options,
    ...(options.model ? { model: options.model } : {}),
    act: predict(actSignature, {
      ...(options.model ? { model: options.model } : {}),
      ...((options.act?.adapter ?? options.adapter)
        ? { adapter: options.act?.adapter ?? options.adapter }
        : {}),
    }),
    extract: predict(extractSignature, {
      ...(options.model ? { model: options.model } : {}),
      ...((options.extract?.adapter ?? options.adapter)
        ? { adapter: options.extract?.adapter ?? options.adapter }
        : {}),
    }) as PredictModule<any, TOutput>,
  });
}

async function executeRlm<TInput, TOutput>(
  state: RlmState<TInput, TOutput>,
  input: TInput,
  options?: RunOptions,
): Promise<TOutput> {
  const internalOptions = options as RlmInternalOptions | undefined;
  const runtime = resolveRuntime(state, options);
  const resumeRunId =
    runtime != null &&
    typeof runtime === "object" &&
    "__superobjectiveRlmResume" in runtime &&
    typeof (runtime as { __superobjectiveRlmResume?: { runId?: unknown } }).__superobjectiveRlmResume?.runId ===
      "string"
      ? (runtime as { __superobjectiveRlmResume: { runId: string } }).__superobjectiveRlmResume.runId
      : undefined;
  const execution =
    internalOptions?.__execution ??
    createExecutionState({
      runtime,
      targetId: state.id,
      targetKind: "rlm",
      input,
      ...(resumeRunId != null ? { runId: resumeRunId } : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
    });
  let component: ReturnType<typeof startComponent> | undefined;

  const session = await state.options.runtime.createSession({
    runId: execution.trace.runId,
    moduleId: state.id,
    ...(runtime.env !== undefined ? { env: runtime.env } : {}),
    runtime,
    ...(state.options.tools != null ? { tools: state.options.tools } : {}),
  });
  const sessionKind =
    typeof (session as { sessionKind?: unknown }).sessionKind === "string"
      ? ((session as { sessionKind: string }).sessionKind)
      : undefined;

  try {
    const validatedInput = state.inputSchema.parse(input);
    const resumed = (await session.resume?.()) ?? null;
    execution.trace.metadata = {
      ...(execution.trace.metadata ?? {}),
      rlmSession: {
        kind: sessionKind ?? "unspecified",
        resumed: resumed != null,
      },
    };
    if (resumed != null) {
      execution.trace = cloneRlmTrace(resumed.trace);
      execution.sampled = resumed.sampled;
      execution.trace.metadata = {
        ...(execution.trace.metadata ?? {}),
        rlmSession: {
          kind: sessionKind ?? "unspecified",
          resumed: true,
        },
      };
    }

    component = findOpenRlmComponent(execution, state.id, validatedInput);

    const preparedContext =
      resumed?.preparedContext ?? (await session.prepareContext(validatedInput as Record<string, unknown>));
    execution.trace.programmable ??= {
      mode: "rlm",
      context: {
        prepared: true,
        ...(state.options.trace?.includeContextManifest === false
          ? {}
          : {
              manifest:
                preparedContext.manifest ??
                {
                  contextRoot: preparedContext.contextRoot,
                  manifestPath: preparedContext.manifestPath,
                  resources: preparedContext.resources,
                },
            }),
      },
      steps: [],
    };
    execution.trace.programmable.context ??= {
      prepared: true,
      ...(state.options.trace?.includeContextManifest === false
        ? {}
        : {
            manifest:
              preparedContext.manifest ??
              {
                contextRoot: preparedContext.contextRoot,
                manifestPath: preparedContext.manifestPath,
                resources: preparedContext.resources,
              },
          }),
    };

    const inheritedCandidate = mergeCandidates(
      chooseArtifactCandidate(state.artifact),
      state.candidate,
      chooseArtifactCandidate(options?.artifact),
      options?.candidate,
    );
    const childOptions: RlmInternalOptions = {
      ...options,
      runtime,
      __execution: execution,
      ...(Object.keys(inheritedCandidate).length > 0 ? { candidate: inheritedCandidate } : {}),
      ...((options?.artifact ?? state.artifact)
        ? {
            artifact: options?.artifact ?? state.artifact,
          }
        : {}),
    };

    const history: RLMHistoryEntry[] = resumed?.history.map((entry) => ({ ...entry })) ?? [];
    const maxIterations = state.options.maxIterations ?? 8;
    const maxLlmCalls = state.options.maxLlmCalls ?? Math.max(maxIterations + 1, 8);
    const maxOutputChars = state.options.maxOutputChars ?? 10_000;
    let llmCallsUsed = resumed?.llmCallsUsed ?? 0;
    let queryCallsUsed = resumed?.queryCallsUsed ?? 0;
    let stepGuidance =
      resumed?.stepGuidance ??
      "Inspect the prepared context, verify concrete evidence, then SUBMIT the final typed output.";
    let checkpointed = resumed != null;
    const checkpointHook =
      runtime != null &&
      typeof runtime === "object" &&
      "__superobjectiveRlmCheckpoint" in runtime &&
      typeof (runtime as { __superobjectiveRlmCheckpoint?: unknown }).__superobjectiveRlmCheckpoint ===
        "function"
        ? ((runtime as {
            __superobjectiveRlmCheckpoint: (value: {
              runId: string;
              moduleId: string;
              nextIteration: number;
              llmCallsUsed: number;
              queryCallsUsed: number;
              sessionKind?: string;
            }) => Promise<void> | void;
          }).__superobjectiveRlmCheckpoint)
        : undefined;

    async function checkpointSession(value: RLMSessionCheckpoint) {
      await session.checkpoint?.(value);
      await checkpointHook?.({
        runId: execution.trace.runId,
        moduleId: state.id,
        nextIteration: value.nextIteration,
        llmCallsUsed: value.llmCallsUsed,
        queryCallsUsed: value.queryCallsUsed,
        ...(sessionKind != null ? { sessionKind } : {}),
      });
    }

    if (!checkpointed) {
      await checkpointSession({
        preparedContext,
        history,
        nextIteration: 0,
        llmCallsUsed,
        queryCallsUsed,
        stepGuidance,
        sampled: execution.sampled,
        trace: cloneRlmTrace(execution.trace),
      });
      checkpointed = true;
    }

    for (let iteration = resumed?.nextIteration ?? 0; iteration < maxIterations; iteration += 1) {
      if (llmCallsUsed >= maxLlmCalls) {
        break;
      }

      const action = await state.act(
        {
          contextRoot: preparedContext.contextRoot,
          contextManifest: preparedContext.manifestSummary,
          variablesInfo: preparedContext.variablesInfo ?? "No explicit REPL variable metadata was provided.",
          availableTools: preparedContext.availableTools ?? "No explicit tool summary was provided.",
          replHistory: formatHistory(history),
          iteration: `${iteration + 1}/${maxIterations}`,
          llmBudget: `${llmCallsUsed}/${maxLlmCalls} used`,
          queryBudget: `${queryCallsUsed} queries used`,
          stepGuidance,
        },
        childOptions,
      );
      llmCallsUsed += 1;

      const code = stripCodeFences(action.code);
      const startedAt = new Date().toISOString();
      const stepTrace: ProgrammableStepTrace = {
        index: iteration + 1,
        ...(action.reasoning ? { reasoning: action.reasoning } : {}),
        code,
        logs: [] as string[],
        toolCalls: [] as ToolCallTrace[],
        startedAt,
      };

      let stepResult: RLMExecuteStepResult;
      try {
        stepResult = await session.executeStep({
          code,
          context: preparedContext,
          ...(state.options.queryProvider ? { queryProvider: state.options.queryProvider } : {}),
          ...(state.options.tools != null ? { tools: state.options.tools } : {}),
          maxOutputChars,
          maxQueryCalls: Number.MAX_SAFE_INTEGER,
          queryCallsUsed,
        });
      } catch (error) {
        stepResult = {
          logs: [],
          queryCallsUsed,
          error: serializeError(error),
        };
      }

      queryCallsUsed = stepResult.queryCallsUsed;
      stepTrace.logs = [...(stepResult.logs ?? [])];
      if (stepResult.stdout != null) {
        stepTrace.stdout = stepResult.stdout;
      }
      if (stepResult.stderr != null) {
        stepTrace.stderr = stepResult.stderr;
      }
      if (stepResult.submitted !== undefined) {
        stepTrace.submitted = stepResult.submitted;
      }
      if (stepResult.error != null) {
        stepTrace.error = normalizeStepError(stepResult.error);
      }
      if (stepResult.toolCalls?.length) {
        stepTrace.toolCalls = stepResult.toolCalls.map((toolCall) => ({
          ...toolCall,
          source: "rlm",
        }));
        for (const toolCall of stepTrace.toolCalls) {
          recordToolCall(execution, toolCall);
        }
      }

      for (const line of collectStepLines(stepResult)) {
        logToTrace(execution, component, line);
      }

      if (stepResult.submitted !== undefined) {
        try {
          const output = state.outputSchema.parse(stepResult.submitted) as TOutput;
          stepTrace.endedAt = new Date().toISOString();
          execution.trace.programmable.steps.push(stepTrace);
          finishComponent(component, output);
          if (!internalOptions?.__execution) {
            await finalizeExecution(execution, { output });
          }
          return output;
        } catch (error) {
          stepTrace.submitValidationError = serializeError(error);
          stepGuidance = formatSubmitValidationGuidance(error);
        }
      } else if (stepTrace.error != null) {
        stepGuidance = `The previous step failed: ${stepTrace.error.message}. Inspect the prepared context again and make concrete progress.`;
      } else if (
        stepTrace.logs.length === 0 &&
        stepTrace.toolCalls.length === 0 &&
        stepTrace.stdout == null &&
        stepTrace.stderr == null
      ) {
        stepGuidance =
          "The previous step made no observable progress. Inspect context, call tools, log concrete observations, or SUBMIT the final answer.";
      } else {
        stepGuidance =
          "Continue from the observed evidence. If every required field is now known, call SUBMIT in this step.";
      }

      stepTrace.endedAt = new Date().toISOString();
      execution.trace.programmable.steps.push(stepTrace);
      history.push({
        reasoning: action.reasoning,
        code,
        output: formatStepOutput(stepTrace, maxOutputChars),
      });
      await checkpointSession({
        preparedContext,
        history,
        nextIteration: iteration + 1,
        llmCallsUsed,
        queryCallsUsed,
        stepGuidance,
        sampled: execution.sampled,
        trace: cloneRlmTrace(execution.trace),
      });
    }

    if (state.options.extract?.enabled === false) {
      throw new Error("RLM finished without a valid SUBMIT and extract fallback is disabled.");
    }

    if (llmCallsUsed >= maxLlmCalls) {
      throw new Error("RLM exhausted maxLlmCalls before a valid result was produced.");
    }

    const extracted = await state.extract(
      {
        contextRoot: preparedContext.contextRoot,
        contextManifest: preparedContext.manifestSummary,
        variablesInfo: preparedContext.variablesInfo ?? "No explicit REPL variable metadata was provided.",
        availableTools: preparedContext.availableTools ?? "No explicit tool summary was provided.",
        replHistory: formatHistory(history),
      },
      childOptions,
    );

    llmCallsUsed += 1;
    const output = state.outputSchema.parse(extracted) as TOutput;
    if (component != null) {
      finishComponent(component, output);
    }
    if (!internalOptions?.__execution) {
      await finalizeExecution(execution, { output });
    }
    return output;
  } catch (error) {
    if (component != null) {
      failComponent(component, error);
    }
    if (!internalOptions?.__execution) {
      await finalizeExecution(execution, { error });
    }
    throw error;
  } finally {
    await session.close();
  }
}

function cloneRlmTrace<TTrace>(trace: TTrace): TTrace {
  if (typeof structuredClone === "function") {
    return structuredClone(trace);
  }
  return JSON.parse(JSON.stringify(trace)) as TTrace;
}

function findOpenRlmComponent<TInput>(
  execution: ExecutionState,
  componentId: string,
  input: TInput,
) {
  const existing = execution.trace.components.find(
    (component) =>
      component.componentId === componentId &&
      component.componentKind === "rlm" &&
      component.endedAt == null,
  );
  if (existing != null) {
    return existing;
  }

  return startComponent(execution, {
    componentId,
    componentKind: "rlm",
    input,
  });
}

function resolveRuntime<TInput, TOutput>(
  state: RlmState<TInput, TOutput>,
  options?: RunOptions,
): RuntimeContext {
  return getRuntimeContext({
    ...options?.runtime,
    ...(state.model ? { model: state.model } : {}),
  });
}

function buildActSignature(
  value: Signature<any, any>,
  overrideInstructions: TextParam | undefined,
) {
  return signature(`${value.name}_act`)
    .withInstructions(composeInstructions(DEFAULT_ACT_INSTRUCTIONS, value.instructions, overrideInstructions))
    .withInput("contextRoot", z.string(), {
      description: "Filesystem or logical root for the prepared context.",
    })
    .withInput("contextManifest", z.string(), {
      description: "Summary of the prepared context resources and manifest.",
    })
    .withInput("variablesInfo", z.string(), {
      description: "Metadata about the values and variables directly available inside the RLM REPL.",
    })
    .withInput("availableTools", z.string(), {
      description: "Summary of the available runtime helpers and tools.",
    })
    .withInput("replHistory", z.string(), {
      description: "Formatted history of prior RLM steps and observations.",
    })
    .withInput("iteration", z.string(), {
      description: "Current iteration budget string.",
    })
    .withInput("llmBudget", z.string(), {
      description: "Remaining LLM budget summary.",
    })
    .withInput("queryBudget", z.string(), {
      description: "Query budget summary.",
    })
    .withInput("stepGuidance", z.string(), {
      description: "Guidance derived from prior failures or lack of progress.",
    })
    .withOutput("reasoning", z.string(), {
      description: "Short rationale for the next code step.",
    })
    .withOutput("code", z.string(), {
      description: "JavaScript or TypeScript code for the next RLM step.",
    })
    .build();
}

function buildExtractSignature(
  value: Signature<any, any>,
  overrideInstructions: TextParam | undefined,
) {
  return signature({
    name: `${value.name}_extract`,
    instructions: composeInstructions(DEFAULT_EXTRACT_INSTRUCTIONS, value.instructions, overrideInstructions),
    input: {
      contextRoot: input(z.string(), {
        description: text("Filesystem or logical root for the prepared context."),
      }),
      contextManifest: input(z.string(), {
        description: text("Summary of the prepared context resources and manifest."),
      }),
      variablesInfo: input(z.string(), {
        description: text("Metadata about the values and variables directly available inside the RLM REPL."),
      }),
      availableTools: input(z.string(), {
        description: text("Summary of the available runtime helpers and tools."),
      }),
      replHistory: input(z.string(), {
        description: text("Formatted history of prior RLM steps and observations."),
      }),
    },
    output: value.output,
  });
}

function composeInstructions(
  ...values: Array<TextParam | undefined>
): TextParam {
  return text({
    value: values
      .map((value) => value?.value)
      .filter((value): value is string => value != null && value.trim().length > 0)
      .join("\n\n"),
    optimize: values.some((value) => value?.optimize === true),
  });
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```$/);
  return match?.[1] ?? trimmed;
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  const omitted = value.length - maxChars;
  return [
    value.slice(0, head),
    "",
    `... (${omitted} characters omitted) ...`,
    "",
    value.slice(value.length - tail),
  ].join("\n");
}

function formatHistory(entries: RLMHistoryEntry[]): string {
  if (entries.length === 0) {
    return "No REPL history yet.";
  }

  return entries
    .map((entry, index) =>
      [
        `=== Step ${index + 1} ===`,
        `Reasoning: ${entry.reasoning ?? "(none)"}`,
        "Code:",
        "```javascript",
        entry.code,
        "```",
        entry.output,
      ].join("\n"),
    )
    .join("\n\n");
}

function normalizeStepError(value: SerializedError | string): SerializedError {
  return typeof value === "string" ? { message: value } : value;
}

function collectStepLines(result: RLMExecuteStepResult): string[] {
  const lines: string[] = [];
  for (const value of result.logs ?? []) {
    lines.push(value);
  }
  if (result.stdout != null && result.stdout.length > 0) {
    lines.push(result.stdout);
  }
  if (result.stderr != null && result.stderr.length > 0) {
    lines.push(result.stderr);
  }
  if (result.submitted !== undefined) {
    lines.push(`SUBMIT: ${stableStringify(result.submitted)}`);
  }
  if (result.error != null) {
    const normalized = normalizeStepError(result.error);
    lines.push(`ERROR: ${normalized.message}`);
  }
  return lines;
}

function formatStepOutput(
  step: {
    logs: string[];
    stdout?: string;
    stderr?: string;
    submitted?: unknown;
    error?: SerializedError;
    submitValidationError?: SerializedError;
    queryCallsUsed?: number;
  },
  maxOutputChars: number,
): string {
  const parts: string[] = [];
  if (step.logs.length > 0) {
    parts.push(`Logs:\n${step.logs.join("\n")}`);
  }
  if (step.stdout != null && step.stdout.length > 0) {
    parts.push(`Stdout:\n${truncateOutput(step.stdout, maxOutputChars)}`);
  }
  if (step.stderr != null && step.stderr.length > 0) {
    parts.push(`Stderr:\n${truncateOutput(step.stderr, maxOutputChars)}`);
  }
  if (step.submitted !== undefined) {
    parts.push(`SUBMIT: ${stableStringify(step.submitted)}`);
  }
  if (step.submitValidationError != null) {
    parts.push(`SUBMIT validation failed: ${step.submitValidationError.message}`);
  }
  if (step.error != null) {
    parts.push(`Error: ${step.error.message}`);
  }
  if (step.queryCallsUsed != null) {
    parts.push(`Query calls used: ${step.queryCallsUsed}`);
  }
  return parts.length === 0 ? "No observable output." : parts.join("\n\n");
}

function formatSubmitValidationGuidance(error: unknown): string {
  const normalized = serializeError(error);
  return `SUBMIT payload validation failed: ${normalized.message}. Submit only the final typed output with concrete values for every required field.`;
}

function extractRlmSeedCandidate<TInput, TOutput>(state: RlmState<TInput, TOutput>): TextCandidate {
  return mergeCandidates(
    {
      [`${state.signature.name}.instructions`]: state.signature.instructions.value,
    },
    chooseArtifactCandidate(state.artifact),
    state.candidate,
  );
}
