import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  extractSignatureTextCandidate,
  input,
  mergeCandidates,
  output,
  resolveTextParam,
  signature,
  signatureFieldDescriptionPath,
  signatureInstructionsPath,
  text,
  stringifyValue,
} from "./candidate";
import type { AnyTarget, Field, JsonSchema, Signature, TextCandidate } from "./types";
import { stableStringify } from "./utils";

function applyFieldSchemaDescription(field: Field<any, z.ZodTypeAny>, description: string) {
  let schema: z.ZodTypeAny = field.schema;

  if (field.optional) {
    schema = schema.optional();
  }

  if (field.default !== undefined) {
    schema = schema.default(field.default);
  }

  // `.describe()` must be last for metadata-sensitive downstream consumers.
  schema = schema.describe(description);

  return schema;
}

function fieldDescription(
  signature: Signature<any, any>,
  kind: "input" | "output",
  fieldName: string,
  field: Field<any, z.ZodTypeAny>,
  candidate?: TextCandidate,
) {
  return resolveTextParam({
    text: field.description,
    path: signatureFieldDescriptionPath({
      signature,
      kind,
      fieldName,
    }),
    candidate,
  });
}

function createObjectSchema(args: {
  signature: Signature<any, any>;
  kind: "input" | "output";
  candidate: TextCandidate | undefined;
}) {
  const { signature, kind, candidate } = args;
  const fieldMap = (kind === "input" ? signature.input : signature.output) as Record<
    string,
    Field<any, any>
  >;
  const shape = Object.fromEntries(
    Object.entries(fieldMap).map(([fieldName, field]) => [
      fieldName,
      applyFieldSchemaDescription(
        field,
        fieldDescription(signature, kind, fieldName, field, candidate),
      ),
    ]),
  );

  return z.object(shape);
}

export function signatureToInputZodSchema(args: {
  signature: Signature<any, any>;
  candidate?: TextCandidate;
}) {
  return createObjectSchema({
    signature: args.signature,
    kind: "input",
    candidate: args.candidate,
  });
}

export function signatureToOutputZodSchema(args: {
  signature: Signature<any, any>;
  candidate?: TextCandidate;
}) {
  return createObjectSchema({
    signature: args.signature,
    kind: "output",
    candidate: args.candidate,
  });
}

function normalizeJsonSchema(schema: unknown): JsonSchema {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as JsonSchema;
  }

  return {
    type: "object",
  };
}

export function zodSchemaToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const zodBuiltIn = z as typeof z & {
    toJSONSchema?: (schema: z.ZodTypeAny) => unknown;
  };

  if (typeof zodBuiltIn.toJSONSchema === "function") {
    return normalizeJsonSchema(zodBuiltIn.toJSONSchema(schema));
  }

  return normalizeJsonSchema(
    zodToJsonSchema(schema as any, {
      target: "jsonSchema7",
      $refStrategy: "none",
    }),
  );
}

export function signatureToInputJsonSchema(args: {
  signature: Signature<any, any>;
  candidate?: TextCandidate;
}) {
  return zodSchemaToJsonSchema(signatureToInputZodSchema(args));
}

export function signatureToOutputJsonSchema(args: {
  signature: Signature<any, any>;
  candidate?: TextCandidate;
}) {
  return zodSchemaToJsonSchema(signatureToOutputZodSchema(args));
}

export function describeFieldType(field: Field<any, z.ZodTypeAny>) {
  const jsonSchema = zodSchemaToJsonSchema(field.schema);
  if (Array.isArray(jsonSchema.enum)) {
    return jsonSchema.enum.map((value) => stringifyValue(value)).join(" | ");
  }

  if (typeof jsonSchema.type === "string") {
    return jsonSchema.type;
  }

  if (Array.isArray(jsonSchema.type)) {
    return jsonSchema.type.join(" | ");
  }

  return "object";
}

export function getTargetInputSchema(target: AnyTarget) {
  if (target.kind === "predict" || target.kind === "rlm") {
    return signatureToInputZodSchema({
      signature: target.signature,
    });
  }

  if (target.kind === "program") {
    return target.inputSchema;
  }

  if (target.kind === "tool") {
    return target.inputSchema;
  }

  return getTargetInputSchema(target.chat);
}

export function getTargetOutputSchema(target: AnyTarget) {
  if (target.kind === "predict" || target.kind === "rlm") {
    return signatureToOutputZodSchema({
      signature: target.signature,
    });
  }

  if (target.kind === "program") {
    return target.outputSchema;
  }

  if (target.kind === "tool") {
    return target.outputSchema ?? z.unknown();
  }

  return getTargetOutputSchema(target.chat);
}

export function signatureInstructionPath(signatureValue: Signature<any, any>) {
  return signatureInstructionsPath(signatureValue);
}

export function signatureFieldPath(
  signatureName: string,
  kind: "input" | "output",
  fieldName: string,
) {
  return `${signatureName}.${kind}.${fieldName}.description`;
}

export function mergeWithSeedCandidate(
  signatureValue: Signature<any, any>,
  ...candidates: Array<TextCandidate | undefined>
): TextCandidate {
  return mergeCandidates(extractSignatureTextCandidate(signatureValue), ...candidates);
}

export function outputSchemaSummary(schema: JsonSchema): string {
  return stableStringify(schema);
}

export { text, input, output, signature, extractSignatureTextCandidate, resolveTextParam };
