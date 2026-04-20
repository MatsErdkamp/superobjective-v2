import { z } from "zod";

import {
  resolveTextParam,
  sanitizeJsonValue,
  signatureInstructionsPath,
  stringifyValue,
} from "./candidate";
import {
  describeFieldType,
  signatureToOutputJsonSchema,
  signatureToOutputZodSchema,
} from "./schema";
import type { Adapter, Example, Field, ModelMessage, Signature, TextCandidate } from "./types";

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderFieldXml(args: {
  signature: Signature<any, any>;
  kind: "input" | "output";
  fieldName: string;
  field: Field<any, any>;
  candidate: TextCandidate;
}) {
  const { signature, kind, fieldName, field, candidate } = args;
  const description = resolveTextParam({
    text: field.description,
    path: `${signature.name}.${kind}.${fieldName}.description`,
    candidate,
  });

  return [
    `  <field name="${escapeXml(fieldName)}" type="${escapeXml(describeFieldType(field))}">`,
    `    ${escapeXml(description)}`,
    "  </field>",
  ].join("\n");
}

function renderInputXml(input: unknown) {
  if (!input || typeof input !== "object") {
    return `<input>${escapeXml(stringifyValue(input))}</input>`;
  }

  const body = Object.entries(input).map(
    ([key, value]) => `  <${key}>${escapeXml(stringifyValue(value))}</${key}>`,
  );

  return ["<input>", ...body, "</input>"].join("\n");
}

function renderExamples(examples?: Example<any, any>[]) {
  if (!examples?.length) {
    return undefined;
  }

  const lines = ["<examples>"];
  for (const example of examples) {
    lines.push("  <example>");
    lines.push(`    <input>${escapeXml(JSON.stringify(example.input))}</input>`);
    lines.push(`    <expected>${escapeXml(JSON.stringify(example.expected))}</expected>`);
    lines.push("  </example>");
  }
  lines.push("</examples>");

  return lines.join("\n");
}

function renderXmlPrompt(args: {
  signature: Signature<any, any>;
  candidate: TextCandidate;
  input: unknown;
  examples?: Example<any, any>[];
}) {
  const { signature, candidate, input, examples } = args;
  const instructions = resolveTextParam({
    text: signature.instructions,
    path: signatureInstructionsPath(signature),
    candidate,
  });

  const parts = [
    "<task>",
    escapeXml(instructions),
    "</task>",
    "",
    "<input_fields>",
    ...Object.entries(signature.input as Record<string, Field<any, any>>).map(
      ([fieldName, field]) =>
        renderFieldXml({
          signature,
          kind: "input",
          fieldName,
          field,
          candidate,
        }),
    ),
    "</input_fields>",
    "",
    "<output_fields>",
    ...Object.entries(signature.output as Record<string, Field<any, any>>).map(
      ([fieldName, field]) =>
        renderFieldXml({
          signature,
          kind: "output",
          fieldName,
          field,
          candidate,
        }),
    ),
    "</output_fields>",
  ];

  const renderedExamples = renderExamples(examples);
  if (renderedExamples) {
    parts.push("", renderedExamples);
  }

  parts.push("", renderInputXml(input));

  return parts.join("\n");
}

function renderJsonPrompt(args: {
  signature: Signature<any, any>;
  candidate: TextCandidate;
  input: unknown;
}) {
  const { signature, candidate, input } = args;
  const instructions = resolveTextParam({
    text: signature.instructions,
    path: signatureInstructionsPath(signature),
    candidate,
  });

  const payload = {
    task: instructions,
    inputFields: Object.fromEntries(
      Object.entries(signature.input as Record<string, Field<any, any>>).map(
        ([fieldName, field]) => [
          fieldName,
          {
            type: describeFieldType(field),
            description: resolveTextParam({
              text: field.description,
              path: `${signature.name}.input.${fieldName}.description`,
              candidate,
            }),
          },
        ],
      ),
    ),
    outputFields: Object.fromEntries(
      Object.entries(signature.output as Record<string, Field<any, any>>).map(
        ([fieldName, field]) => [
          fieldName,
          {
            type: describeFieldType(field),
            description: resolveTextParam({
              text: field.description,
              path: `${signature.name}.output.${fieldName}.description`,
              candidate,
            }),
          },
        ],
      ),
    ),
    input: sanitizeJsonValue(input),
  };

  return JSON.stringify(payload, null, 2);
}

function renderNativeStructuredPrompt(args: {
  signature: Signature<any, any>;
  candidate: TextCandidate;
  input: unknown;
}) {
  const { signature, candidate, input } = args;
  const instructions = resolveTextParam({
    text: signature.instructions,
    path: signatureInstructionsPath(signature),
    candidate,
  });

  const outputFieldNotes = Object.entries(signature.output).map(
    ([fieldName, field]) =>
      `- ${fieldName}: ${resolveTextParam({
        text: (field as Field<any, any>).description,
        path: `${signature.name}.output.${fieldName}.description`,
        candidate,
      })}`,
  );

  return [
    instructions,
    "",
    "Return a structured object that satisfies the provided schema.",
    ...outputFieldNotes,
    "",
    "Current input:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function createMessages(system: string, history?: ModelMessage[]) {
  return [
    {
      role: "system" as const,
      content: system,
    },
    ...(history ?? []),
  ];
}

function createFallbackParser(mode: "xml-tags" | "json-text", signature: Signature<any, any>) {
  if (mode === "json-text") {
    return async (rawText: string) => JSON.parse(rawText);
  }

  return async (rawText: string) => {
    const value: Record<string, string> = {};
    for (const key of Object.keys(signature.output)) {
      const pattern = new RegExp(`<${key}>([\\s\\S]*?)<\\/${key}>`, "i");
      const match = rawText.match(pattern);
      if (match?.[1]) {
        const field = (signature.output as Record<string, Field<any, any>>)[key];
        if (field?.schema instanceof z.ZodBoolean) {
          value[key] = String(match[1].trim().toLowerCase() === "true");
        } else {
          value[key] = match[1].trim();
        }
      }
    }

    return value;
  };
}

function createAdapter(args: {
  id: string;
  renderPrompt: (args: {
    signature: Signature<any, any>;
    candidate: TextCandidate;
    input: unknown;
    examples?: Example<any, any>[];
  }) => string;
  fallbackMode: "xml-tags" | "json-text";
}) {
  const { id, renderPrompt, fallbackMode } = args;
  return {
    id,
    version: "0.1.0",
    async format({ signature, candidate, input, examples, history }) {
      const messages = createMessages(
        renderPrompt({
          signature,
          candidate,
          input,
          ...(examples ? { examples } : {}),
        }),
        history,
      );

      return {
        messages,
        output: {
          zodSchema: signatureToOutputZodSchema({
            signature,
            candidate,
          }),
          jsonSchema: signatureToOutputJsonSchema({
            signature,
            candidate,
          }),
          name: signature.name,
          description: resolveTextParam({
            text: signature.instructions,
            path: signatureInstructionsPath(signature),
            candidate,
          }),
          strict: true,
        },
        fallback: {
          mode: fallbackMode,
          parse: createFallbackParser(fallbackMode, signature),
        },
      };
    },
    async parseStructured({ signature, value }) {
      return signatureToOutputZodSchema({
        signature,
      }).parse(value);
    },
    async parseTextFallback({ signature, rawText }) {
      return createFallbackParser(fallbackMode, signature)(rawText);
    },
    formatFailureAsFeedback(error) {
      return error instanceof Error ? error.message : String(error);
    },
  } satisfies Adapter;
}

export function xmlAdapter() {
  return createAdapter({
    id: "xml",
    renderPrompt: renderXmlPrompt,
    fallbackMode: "xml-tags",
  });
}

export function jsonAdapter() {
  return createAdapter({
    id: "json",
    renderPrompt: ({ signature, candidate, input }) =>
      renderJsonPrompt({
        signature,
        candidate,
        input,
      }),
    fallbackMode: "json-text",
  });
}

export function nativeStructuredAdapter() {
  return createAdapter({
    id: "native-structured",
    renderPrompt: ({ signature, candidate, input }) =>
      renderNativeStructuredPrompt({
        signature,
        candidate,
        input,
      }),
    fallbackMode: "json-text",
  });
}

export const xml = xmlAdapter;
export const json = jsonAdapter;
export const nativeStructured = nativeStructuredAdapter;

export const adapters = {
  xml,
  json,
  nativeStructured,
};
