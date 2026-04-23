import { z } from "zod";

import type {
  ExecutionPlanTrace,
  InputSource,
  ModelMessage,
  PreparedSource,
  TextParam,
  ToolBindingDefinition,
  ToolContext,
} from "./types.js";
import { text } from "./candidate.js";

function getObjectShape(schema: z.ZodTypeAny | undefined): Record<string, z.ZodTypeAny> | null {
  if (schema == null) {
    return null;
  }

  const candidate = schema as z.ZodTypeAny & {
    shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
    _def?: {
      shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
    };
  };

  const directShape = candidate.shape;
  if (typeof directShape === "function") {
    return directShape();
  }
  if (directShape != null && typeof directShape === "object") {
    return directShape;
  }

  const nestedShape = candidate._def?.shape;
  if (typeof nestedShape === "function") {
    return nestedShape();
  }
  if (nestedShape != null && typeof nestedShape === "object") {
    return nestedShape;
  }

  return null;
}

function getPathValue(value: unknown, path: string): unknown {
  if (path.trim().length === 0) {
    return value;
  }

  const parts = path.split(".").filter(Boolean);
  let current: unknown = value;

  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function inferCurrentUserMessage(history: ModelMessage[] | undefined): string | undefined {
  const latest = [...(history ?? [])].reverse().find((message) => message.role === "user");
  return typeof latest?.content === "string" ? latest.content : undefined;
}

function inferLatestAssistantMessage(history: ModelMessage[] | undefined): string | undefined {
  const latest = [...(history ?? [])].reverse().find((message) => message.role === "assistant");
  return typeof latest?.content === "string" ? latest.content : undefined;
}

function historyAsText(history: ModelMessage[] | undefined): string {
  return (history ?? [])
    .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : ""}`)
    .join("\n");
}

function sliceHistory(
  history: ModelMessage[] | undefined,
  options: Record<string, unknown> | undefined,
): ModelMessage[] {
  const entries = history ?? [];
  const maxMessages =
    typeof options?.maxMessages === "number" && Number.isFinite(options.maxMessages)
      ? Math.max(0, Math.trunc(options.maxMessages))
      : undefined;

  if (maxMessages == null) {
    return entries.slice();
  }

  return entries.slice(-maxMessages);
}

function toolNameFromOptions(options: Record<string, unknown> | undefined): string | undefined {
  return typeof options?.toolName === "string" && options.toolName.trim().length > 0
    ? options.toolName.trim()
    : undefined;
}

function messagesSinceLastToolCall(
  history: ModelMessage[] | undefined,
  options: Record<string, unknown> | undefined,
): ModelMessage[] {
  const entries = history ?? [];
  const toolName = toolNameFromOptions(options);
  let lastToolIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== "tool") {
      continue;
    }

    if (toolName != null && entry.toolName !== toolName) {
      continue;
    }

    if (entry.role === "tool") {
      lastToolIndex = index;
      break;
    }
  }

  const recent = lastToolIndex >= 0 ? entries.slice(lastToolIndex + 1) : entries.slice();
  return sliceHistory(recent, options);
}

function normalizeSource<T>(field: string, source: InputSource<T> | undefined): InputSource<T> {
  return source ?? { kind: "arg", path: field };
}

function sourceLabel(source: InputSource<unknown>): string {
  switch (source.kind) {
    case "arg":
      return `arg:${source.path}`;
    case "literal":
      return "literal";
    case "tool.latestResult":
      return `tool.latestResult:${source.toolName}`;
    case "tool.resultById":
      return `tool.resultById:${source.toolName}`;
    case "state":
      return `state:${source.key}`;
    case "prepared":
      return `prepared:${source.mode}`;
    default:
      return source.kind;
  }
}

export function createExecutionPlan<TInput>(
  inputSchema: z.ZodType<TInput> | undefined,
  binding: ToolBindingDefinition<TInput> | undefined,
): ExecutionPlanTrace {
  const shape = getObjectShape(inputSchema);
  const fieldNames = new Set<string>([
    ...Object.keys(shape ?? {}),
    ...Object.keys((binding?.input ?? {}) as Record<string, unknown>),
  ]);

  const fields = Array.from(fieldNames)
    .sort()
    .map((field) => {
      const source = normalizeSource(
        field,
        (binding?.input as Record<string, InputSource<unknown> | undefined> | undefined)?.[field],
      );
      return {
        field,
        source,
      };
    });

  const explicitMode = binding?.execution;
  if (explicitMode != null && explicitMode !== "auto") {
    return {
      selected: explicitMode,
      explicit: true,
      reasons: [`execution explicitly set to ${explicitMode}`],
      dependencyGraph: {
        fields: fields.map(({ field, source }) => ({
          field,
          source: sourceLabel(source),
        })),
      },
    };
  }

  const preparedSources = fields.filter(({ source }) => source.kind === "prepared");
  const toolDerivedSources = fields.filter(
    ({ source }) => source.kind === "tool.latestResult" || source.kind === "tool.resultById",
  );

  const selected =
    preparedSources.find(({ source }) => (source as PreparedSource).mode === "codemode") != null
      ? "codemode"
      : "direct";

  const reasons: string[] = [];

  if (preparedSources.length > 0) {
    for (const entry of preparedSources) {
      reasons.push(
        `input.${entry.field} requires prepared ${(entry.source as PreparedSource).mode} resolution`,
      );
    }
  }

  if (toolDerivedSources.length > 0) {
    reasons.push(`${toolDerivedSources.length} tool-derived dependency edges detected`);
  }

  if (reasons.length === 0) {
    reasons.push("all inputs are directly resolvable from args, chat context, state, or tool history");
  }

  return {
    selected,
    explicit: false,
    reasons,
    dependencyGraph: {
      fields: fields.map(({ field, source }) => ({
        field,
        source: sourceLabel(source),
      })),
    },
  };
}

export function buildBoundInputSchema<TInput>(
  inputSchema: z.ZodType<TInput> | undefined,
  binding: ToolBindingDefinition<TInput> | undefined,
): z.ZodTypeAny | undefined {
  if (inputSchema == null) {
    return undefined;
  }

  if (binding?.input == null) {
    return inputSchema as z.ZodTypeAny;
  }

  const shape = getObjectShape(inputSchema);
  if (shape == null) {
    return inputSchema as z.ZodTypeAny;
  }

  const boundShape: Record<string, z.ZodTypeAny> = {};

  for (const [field, schema] of Object.entries(shape)) {
    const source = normalizeSource(
      field,
      (binding.input as Record<string, InputSource<unknown> | undefined>)[field],
    );

    if (source.kind === "arg") {
      boundShape[field] = schema;
    }
  }

  return z.object(boundShape);
}

export async function resolveBoundInput<TInput extends Record<string, unknown>>(
  args: unknown,
  inputSchema: z.ZodType<TInput> | undefined,
  binding: ToolBindingDefinition<TInput> | undefined,
  ctx: ToolContext,
): Promise<TInput> {
  if (inputSchema == null) {
    return (args ?? {}) as TInput;
  }

  const shape = getObjectShape(inputSchema);
  if (shape == null) {
    return inputSchema.parse(args) as TInput;
  }

  const history = ctx.bindingState?.chatHistory;
  const resolvedEntries = await Promise.all(
    Object.keys(shape).map(async (field) => {
      const source = normalizeSource(
        field,
        (binding?.input as Record<string, InputSource<unknown> | undefined> | undefined)?.[field],
      );

      switch (source.kind) {
        case "arg":
          return [field, getPathValue(args, source.path)] as const;
        case "literal":
          return [field, source.value] as const;
        case "chat.currentUserMessage":
          return [
            field,
            ctx.bindingState?.currentUserMessage ?? inferCurrentUserMessage(history),
          ] as const;
        case "chat.latestAssistantMessage":
          return [
            field,
            ctx.bindingState?.latestAssistantMessage ?? inferLatestAssistantMessage(history),
          ] as const;
        case "chat.history":
          return [field, history ?? []] as const;
        case "chat.historyAsContext":
          return [field, sliceHistory(history, source.options)] as const;
        case "chat.historyAsText":
          return [field, historyAsText(sliceHistory(history, source.options))] as const;
        case "chat.messagesSinceLastToolCall":
          return [field, messagesSinceLastToolCall(history, source.options)] as const;
        case "tool.latestResult":
        case "tool.resultById": {
          if (ctx.bindingState?.loadLatestToolResult == null) {
            if (source.required) {
              throw new Error(
                `Tool input "${field}" depends on "${source.toolName}", but no tool history resolver is available.`,
              );
            }
            return [field, undefined] as const;
          }

          const value = await ctx.bindingState.loadLatestToolResult(source.toolName, {
            ...(source.resultId ? { resultId: source.resultId } : {}),
            ...(source.path ? { path: source.path } : {}),
            ...(source.required !== undefined ? { required: source.required } : {}),
          });
          return [field, value] as const;
        }
        case "state": {
          if (ctx.bindingState?.loadState == null) {
            return [field, undefined] as const;
          }
          const value = await ctx.bindingState.loadState(source.key, source.path);
          return [field, value] as const;
        }
        case "prepared":
          throw new Error(
            `Prepared input source "${field}" (${source.mode}) requires a programmable executor. This repo does not expose that runtime yet.`,
          );
      }
    }),
  );

  return inputSchema.parse(Object.fromEntries(resolvedEntries)) as TInput;
}

export const from = {
  arg<T = unknown>(path: string) {
    return { kind: "arg", path } as const;
  },
  literal<T>(value: T) {
    return { kind: "literal", value } as const;
  },
  chat: {
    currentUserMessage() {
      return { kind: "chat.currentUserMessage" } as const;
    },
    history() {
      return { kind: "chat.history" } as const;
    },
    historyAsText(options?: Record<string, unknown>) {
      return { kind: "chat.historyAsText", options } as const;
    },
    historyAsContext(options?: Record<string, unknown>) {
      return { kind: "chat.historyAsContext", options } as const;
    },
    messagesSinceLastToolCall(
      toolNameOrOptions?: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>,
    ) {
      const options =
        typeof toolNameOrOptions === "string"
          ? {
              ...maybeOptions,
              toolName: toolNameOrOptions,
            }
          : toolNameOrOptions;
      return { kind: "chat.messagesSinceLastToolCall", options } as const;
    },
    latestAssistantMessage() {
      return { kind: "chat.latestAssistantMessage" } as const;
    },
  },
  latestToolResult(toolName: string, options?: { path?: string; required?: boolean }) {
    return {
      kind: "tool.latestResult",
      toolName,
      ...(options?.path ? { path: options.path } : {}),
      ...(options?.required !== undefined ? { required: options.required } : {}),
    } as const;
  },
  toolResult(toolName: string, options?: { resultId?: string; path?: string; required?: boolean }) {
    return {
      kind: "tool.resultById",
      toolName,
      ...(options?.resultId ? { resultId: options.resultId } : {}),
      ...(options?.path ? { path: options.path } : {}),
      ...(options?.required !== undefined ? { required: options.required } : {}),
    } as const;
  },
  state(key: string, path?: string) {
    return {
      kind: "state",
      key,
      ...(path ? { path } : {}),
    } as const;
  },
};

type PreparedSourceInit =
  | string
  | {
      instructions?: string | TextParam;
      metadata?: Record<string, unknown>;
      tools?: Array<{ name?: string; id?: string } | string>;
    };

function normalizePreparedSource(
  mode: PreparedSource["mode"],
  value: PreparedSourceInit,
): PreparedSource {
  const specification = typeof value === "string" ? { instructions: value } : value;
  const instructions =
    specification.instructions == null
      ? undefined
      : typeof specification.instructions === "string"
        ? text(specification.instructions)
        : specification.instructions;
  const toolNames =
    specification.tools
      ?.map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (typeof entry?.name === "string" && entry.name.trim().length > 0) {
          return entry.name.trim();
        }
        if (typeof entry?.id === "string" && entry.id.trim().length > 0) {
          return entry.id.trim();
        }
        return undefined;
      })
      .filter((entry): entry is string => entry != null) ?? [];

  const metadata =
    specification.metadata == null && toolNames.length === 0
      ? undefined
      : {
          ...(toolNames.length > 0 ? { tools: toolNames } : {}),
          ...(specification.metadata ?? {}),
        };

  return {
    kind: "prepared",
    mode,
    ...(instructions != null ? { instructions } : {}),
    ...(metadata != null ? { metadata } : {}),
  };
}

export const prepare = {
  direct(value: PreparedSourceInit) {
    return normalizePreparedSource("direct", value);
  },
  codemode(value: PreparedSourceInit) {
    return normalizePreparedSource("codemode", value);
  },
};

export const bindingInternals = {
  getObjectShape,
  getPathValue,
  createExecutionPlan,
  buildBoundInputSchema,
  resolveBoundInput,
};
