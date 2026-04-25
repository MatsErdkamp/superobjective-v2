import type {
  ComponentTrace,
  ModelCallTrace,
  RunTrace,
  RuntimeContext,
  ToolCallTrace,
} from "./types.js";
import { createId, serializeError } from "./utils.js";

export type ExecutionState = {
  runtime: RuntimeContext;
  trace: RunTrace;
  sampled: boolean;
};

export function createExecutionState(args: {
  runtime: RuntimeContext;
  targetId: string;
  targetKind: RunTrace["targetKind"];
  input: unknown;
  runId?: string;
  metadata?: Record<string, unknown>;
}): ExecutionState {
  const sampleRate = args.runtime.trace?.sampleRate ?? 1;
  const sampled = Math.random() <= sampleRate;

  return {
    runtime: args.runtime,
    sampled,
    trace: {
      runId: args.runId ?? createId("run"),
      targetId: args.targetId,
      targetKind: args.targetKind,
      startedAt: new Date().toISOString(),
      input: args.input,
      stdout: "",
      components: [],
      modelCalls: [],
      toolCalls: [],
      ...(args.metadata ? { metadata: args.metadata } : {}),
    },
  };
}

export function startComponent(
  state: ExecutionState,
  args: Omit<ComponentTrace, "startedAt" | "stdout"> & {
    prompt?: ComponentTrace["prompt"];
  },
): ComponentTrace {
  const component: ComponentTrace = {
    ...args,
    spanId: args.spanId ?? createId("span"),
    startedAt: new Date().toISOString(),
    stdout: "",
  };
  state.trace.components.push(component);
  return component;
}

export function logToTrace(
  state: ExecutionState,
  component: ComponentTrace | undefined,
  message: string,
): void {
  state.trace.stdout = state.trace.stdout ? `${state.trace.stdout}\n${message}` : message;

  if (component) {
    component.stdout = component.stdout ? `${component.stdout}\n${message}` : message;
  }
}

export function finishComponent(component: ComponentTrace, output: unknown): void {
  component.output = output;
  component.endedAt = new Date().toISOString();
}

export function failComponent(component: ComponentTrace, error: unknown): void {
  component.error = serializeError(error);
  component.endedAt = new Date().toISOString();
}

export function recordModelCall(state: ExecutionState, value: ModelCallTrace): void {
  state.trace.modelCalls.push(value);
}

export function recordToolCall(state: ExecutionState, value: ToolCallTrace): void {
  state.trace.toolCalls.push(value);
}

export async function finalizeExecution(
  state: ExecutionState,
  args: {
    output?: unknown;
    error?: unknown;
  },
): Promise<RunTrace> {
  if (args.output !== undefined) {
    state.trace.output = args.output;
  }

  if (args.error !== undefined) {
    state.trace.error = serializeError(args.error);
  }

  state.trace.endedAt = new Date().toISOString();

  if (state.sampled && state.runtime.traceStore) {
    const redactor = state.runtime.redactor ?? state.runtime.trace?.redact;
    const trace = redactor ? redactor.redactTrace(state.trace) : state.trace;
    await state.runtime.traceStore.saveTrace(trace);
  }

  return state.trace;
}
