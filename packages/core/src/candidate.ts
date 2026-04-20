import { z } from "zod";

import type {
  Agent,
  Field,
  FieldRecord,
  JsonValue,
  Signature,
  TextCandidate,
  TextParam,
  Tool,
} from "./types";

export function text(input: string | TextParam): TextParam {
  if (typeof input === "string") {
    return {
      value: input,
      optimize: false,
    };
  }

  return {
    optimize: false,
    ...input,
  };
}

type FieldOptions<T> = {
  description: TextParam;
  optional?: boolean;
  default?: T;
  examples?: T[];
  metadata?: Record<string, unknown>;
};

export function input<
  T,
  TSchema extends z.ZodType<T>,
  TOptional extends boolean | undefined = undefined,
>(
  schema: TSchema,
  options: FieldOptions<TOptional extends true ? T | undefined : T> & {
    optional?: TOptional;
  },
): Field<TOptional extends true ? T | undefined : T, TSchema> {
  return {
    kind: "input",
    schema,
    description: options.description,
    ...(options.optional !== undefined ? { optional: options.optional } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
    ...(options.examples ? { examples: options.examples } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  } as Field<TOptional extends true ? T | undefined : T, TSchema>;
}

export function output<
  T,
  TSchema extends z.ZodType<T>,
  TOptional extends boolean | undefined = undefined,
>(
  schema: TSchema,
  options: FieldOptions<TOptional extends true ? T | undefined : T> & {
    optional?: TOptional;
  },
): Field<TOptional extends true ? T | undefined : T, TSchema> {
  return {
    kind: "output",
    schema,
    description: options.description,
    ...(options.optional !== undefined ? { optional: options.optional } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
    ...(options.examples ? { examples: options.examples } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  } as Field<TOptional extends true ? T | undefined : T, TSchema>;
}

export function inputField<TField extends Field<any, any>>(field: TField): TField {
  return field;
}

export function outputField<TField extends Field<any, any>>(field: TField): TField {
  return field;
}

export function signature<TInput extends FieldRecord, TOutput extends FieldRecord>(
  value: Omit<Signature<TInput, TOutput>, "kind">,
): Signature<TInput, TOutput> {
  validateFieldDescriptions(value.name, "input", value.input);
  validateFieldDescriptions(value.name, "output", value.output);
  return {
    kind: "signature",
    ...value,
  };
}

function validateFieldDescriptions(
  signatureName: string,
  kind: "input" | "output",
  fields: Record<string, Field<any, any>>,
): void {
  for (const [fieldName, field] of Object.entries(fields)) {
    if (!field.description?.value?.trim()) {
      throw new Error(
        `Signature "${signatureName}" ${kind} field "${fieldName}" requires a description.`,
      );
    }
  }
}

export function mergeCandidates(...candidates: Array<TextCandidate | undefined>): TextCandidate {
  return Object.assign({}, ...candidates.filter(Boolean));
}

export function hashCandidate(candidate: TextCandidate): string {
  const source = JSON.stringify(
    Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)),
  );

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function signatureInstructionsPath(signatureValue: Signature<any, any>) {
  return `${signatureValue.name}.instructions`;
}

export function signatureFieldDescriptionPath(args: {
  signature: Signature<any, any>;
  kind: "input" | "output";
  fieldName: string;
}) {
  const { signature, kind, fieldName } = args;
  return `${signature.name}.${kind}.${fieldName}.description`;
}

export function toolDescriptionPath(tool: Tool<any, any>) {
  return `tool.${tool.name}.description`;
}

export function agentSystemPath(agent: Agent<any, any>) {
  return `agent.${agent.name}.system`;
}

export function resolveTextParam(args: {
  text: TextParam;
  path?: string;
  candidate: TextCandidate | undefined;
}) {
  const { text, path, candidate } = args;
  if (path && candidate && candidate[path] != null) {
    return candidate[path]!;
  }

  return text.value;
}

export function extractSignatureTextCandidate(signatureValue: Signature<any, any>) {
  const candidate: TextCandidate = {};
  if (signatureValue.instructions.optimize) {
    candidate[signatureInstructionsPath(signatureValue)] = signatureValue.instructions.value;
  }

  for (const [fieldName, field] of Object.entries(
    signatureValue.input as Record<string, Field<any, any>>,
  )) {
    if (field.description.optimize) {
      candidate[
        signatureFieldDescriptionPath({
          signature: signatureValue,
          kind: "input",
          fieldName,
        })
      ] = field.description.value;
    }
  }

  for (const [fieldName, field] of Object.entries(
    signatureValue.output as Record<string, Field<any, any>>,
  )) {
    if (field.description.optimize) {
      candidate[
        signatureFieldDescriptionPath({
          signature: signatureValue,
          kind: "output",
          fieldName,
        })
      ] = field.description.value;
    }
  }

  return candidate;
}

export function extractToolTextCandidate(tool: Tool<any, any>) {
  const candidate: TextCandidate = {};
  if (tool.description.optimize) {
    candidate[toolDescriptionPath(tool)] = tool.description.value;
  }

  return candidate;
}

export function extractAgentTextCandidate(agent: Agent<any, any>) {
  const candidate: TextCandidate = {};
  if (agent.system.optimize) {
    candidate[agentSystemPath(agent)] = agent.system.value;
  }

  return candidate;
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "undefined") {
    return "undefined";
  }

  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }

  const json = JSON.stringify(value, null, 2);
  return json ?? Object.prototype.toString.call(value);
}

export function sanitizeJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeJsonValue(entry)]),
    );
  }

  return typeof value === "symbol"
    ? value.description
      ? `Symbol(${value.description})`
      : "Symbol()"
    : Object.prototype.toString.call(value);
}
