import { z } from "zod";

import type {
  CallableTargetLike,
  JsonSchema,
  McpSurfaceLike,
  ModelMessageLike,
  NormalizedProjectLike,
  ProjectLike,
  RunTraceLike,
  SerializedErrorLike,
  SignatureFieldLike,
  TextParamLike,
  ToolLike,
} from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveText(value: TextParamLike | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.value;
}

export function serializeError(error: unknown): SerializedErrorLike {
  if (error instanceof Error) {
    const serialized: SerializedErrorLike = {
      name: error.name,
      message: error.message,
    };
    if (error.stack != null) {
      serialized.stack = error.stack;
    }
    if ("cause" in error) {
      serialized.cause = (error as Error & { cause?: unknown }).cause;
    }
    return serialized;
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "Unknown error while handling request.",
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = sortValue(value[key]);
      return accumulator;
    }, {});
}

export function toJsonSchema(schema: z.ZodTypeAny | undefined): JsonSchema | undefined {
  if (schema == null) {
    return undefined;
  }
  return z.toJSONSchema(schema) as JsonSchema;
}

function applyFieldOptions(schema: z.ZodTypeAny, field: SignatureFieldLike): z.ZodTypeAny {
  let nextSchema = schema;
  const description = resolveText(field.description);
  if (description != null && description.length > 0) {
    nextSchema = nextSchema.describe(description);
  }
  if (field.optional) {
    nextSchema = nextSchema.optional();
  }
  if (field.default !== undefined) {
    nextSchema = nextSchema.default(field.default);
  }
  return nextSchema;
}

function buildSchemaFromFields(
  fields: Record<string, SignatureFieldLike> | undefined,
): z.ZodObject<Record<string, z.ZodTypeAny>> | undefined {
  if (fields == null) {
    return undefined;
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(fields)) {
    shape[key] = applyFieldOptions(field.schema ?? z.unknown(), field);
  }
  return z.object(shape);
}

export function getInputSchema(target: CallableTargetLike | ToolLike): z.ZodTypeAny | undefined {
  if ("inputSchema" in target && target.inputSchema != null) {
    return target.inputSchema;
  }

  if ("signature" in target && target.signature?.input != null) {
    return buildSchemaFromFields(target.signature.input);
  }

  return undefined;
}

export function getOutputSchema<TEnv>(
  target: CallableTargetLike<unknown, unknown, TEnv> | ToolLike<unknown, unknown, TEnv>,
): z.ZodTypeAny | undefined {
  if ("outputSchema" in target && target.outputSchema != null) {
    return target.outputSchema;
  }

  if ("signature" in target && target.signature?.output != null) {
    return buildSchemaFromFields(target.signature.output);
  }

  return undefined;
}

export function getTargetId<TEnv>(
  target: CallableTargetLike<unknown, unknown, TEnv> | ToolLike<unknown, unknown, TEnv>,
): string {
  if ("id" in target && typeof target.id === "string") {
    return target.id;
  }
  if ("name" in target && typeof target.name === "string") {
    return target.name;
  }
  if ("signature" in target && typeof target.signature?.name === "string") {
    return target.signature.name;
  }
  if (typeof target === "function" && target.name.length > 0) {
    return target.name;
  }
  return "anonymous";
}

export function getTargetKind(
  target: CallableTargetLike<unknown, unknown, unknown> | ToolLike<unknown, unknown, unknown>,
): "predict" | "program" | "tool" {
  if ("execute" in target) {
    return "tool";
  }
  if (target.kind === "program") {
    return "program";
  }
  return "predict";
}

export function validateWithSchema<T>(schema: z.ZodType<T> | undefined, value: unknown): T {
  if (schema == null) {
    return value as T;
  }
  return schema.parse(value);
}

function normalizeByName<T extends { name: string }>(
  items: T[] | undefined,
  kind: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) {
    if (map.has(item.name)) {
      throw new Error(`Duplicate ${kind} name "${item.name}" in project graph.`);
    }
    map.set(item.name, item);
  }
  return map;
}

export function normalizeProject<TEnv = unknown>(
  project: ProjectLike<TEnv>,
): NormalizedProjectLike<TEnv> {
  const programs = new Map<string, CallableTargetLike<unknown, unknown, TEnv>>();
  for (const program of project.programs ?? []) {
    const id = getTargetId(program);
    if (programs.has(id)) {
      throw new Error(`Duplicate program/module name "${id}" in project graph.`);
    }
    programs.set(id, program);
  }

  return {
    programs,
    agents: normalizeByName(project.agents, "agent"),
    rpc: normalizeByName(project.rpc, "rpc surface"),
    mcp: normalizeByName(project.mcp, "mcp surface"),
  };
}

export function createRouteTrace(
  targetId: string,
  targetKind: RunTraceLike["targetKind"],
  input: unknown,
  metadata?: Record<string, unknown>,
): RunTraceLike {
  const trace: RunTraceLike = {
    runId: createId("run"),
    targetId,
    targetKind,
    startedAt: nowIso(),
    input,
    stdout: "",
    components: [],
    modelCalls: [],
    toolCalls: [],
  };

  if (metadata != null) {
    trace.metadata = metadata;
  }

  return trace;
}

export async function maybeInspectPrompt(
  target: CallableTargetLike<unknown, unknown, unknown>,
  input: unknown,
): Promise<RunTraceLike["components"][number]["prompt"] | undefined> {
  if (typeof target.inspectPrompt !== "function") {
    return undefined;
  }

  try {
    const inspected = await target.inspectPrompt(input, { runtime: {} });
    if (!isRecord(inspected)) {
      return undefined;
    }

    const prompt: RunTraceLike["components"][number]["prompt"] = {
      adapterId: typeof inspected.adapterId === "string" ? inspected.adapterId : "unknown",
      adapterVersion:
        typeof inspected.adapterVersion === "string" ? inspected.adapterVersion : "unknown",
      messages: Array.isArray(inspected.messages) ? (inspected.messages as ModelMessageLike[]) : [],
    };

    if (isRecord(inspected.outputJsonSchema)) {
      prompt.outputJsonSchema = inspected.outputJsonSchema as JsonSchema;
    } else if (isRecord(inspected.output) && isRecord(inspected.output.jsonSchema)) {
      prompt.outputJsonSchema = inspected.output.jsonSchema as JsonSchema;
    }

    return prompt;
  } catch {
    return undefined;
  }
}

export function buildToolDefinition(tool: ToolLike | CallableTargetLike): {
  definition: {
    name: string;
    description?: string;
    inputSchema?: z.ZodTypeAny;
  };
  jsonSchema: JsonSchema | undefined;
} {
  const inputSchema = getInputSchema(tool);
  const description =
    "description" in tool
      ? resolveText(tool.description)
      : typeof tool === "function"
        ? resolveText(tool.signature?.instructions)
        : undefined;

  const definition: {
    name: string;
    description?: string;
    inputSchema?: z.ZodTypeAny;
  } = {
    name: getTargetId(tool),
  };
  if (description != null) {
    definition.description = description;
  }
  if (inputSchema != null) {
    definition.inputSchema = inputSchema;
  }

  return {
    definition,
    jsonSchema: toJsonSchema(inputSchema),
  };
}

export function listMcpTools(mcp: McpSurfaceLike): Array<{
  name: string;
  description?: string;
  inputJsonSchema?: JsonSchema;
}> {
  return mcp.tools.map((tool) => {
    const { definition, jsonSchema } = buildToolDefinition(tool);
    const item: {
      name: string;
      description?: string;
      inputJsonSchema?: JsonSchema;
    } = {
      name: definition.name,
    };
    if (definition.description != null) {
      item.description = definition.description;
    }
    if (jsonSchema != null) {
      item.inputJsonSchema = jsonSchema;
    }
    return item;
  });
}
