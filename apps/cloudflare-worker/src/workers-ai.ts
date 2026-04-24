import { type CloudflareEnvLike } from "@superobjective/cloudflare";
import { type ModelMessage, type RLMQueryProvider } from "superobjective";
import { z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type WorkersAiBinding = {
  run: Function;
};

function isWorkersAiBinding(value: unknown): value is WorkersAiBinding {
  return isRecord(value) && typeof value.run === "function";
}

export function extractWorkersAiText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractWorkersAiText(item)).join("\n");
  }
  if (!isRecord(value)) {
    return String(value ?? "");
  }

  for (const key of ["response", "text", "content", "result", "output"]) {
    if (key in value) {
      return extractWorkersAiText(value[key]);
    }
  }

  if (Array.isArray(value.choices) && value.choices.length > 0) {
    const first = value.choices[0];
    if (isRecord(first)) {
      if (isRecord(first.message) && "content" in first.message) {
        return extractWorkersAiText(first.message.content);
      }
      if ("text" in first) {
        return extractWorkersAiText(first.text);
      }
    }
  }

  return JSON.stringify(value);
}

export function parseWorkersAiJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(trimmed);
  } catch {}

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (error) {
      const lenient = parseLenientStringObject(candidate);
      if (lenient != null) {
        return lenient;
      }
      throw error;
    }
  }

  const lenient = parseLenientStringObject(trimmed);
  if (lenient != null) {
    return lenient;
  }

  throw new Error("Workers AI response did not contain a parseable JSON object.");
}

function parseLenientStringObject(text: string): Record<string, string> | null {
  const source = text.trim();
  if (!source.startsWith("{") || !source.endsWith("}")) {
    return null;
  }

  const output: Record<string, string> = {};
  let cursor = 1;

  const skipWhitespaceAndCommas = () => {
    while (cursor < source.length && /[\s,]/.test(source[cursor]!)) {
      cursor += 1;
    }
  };

  const readString = (): string | null => {
    if (source[cursor] !== "\"") {
      return null;
    }
    cursor += 1;
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor]!;
      cursor += 1;
      if (char === "\"") {
        return value;
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      if (cursor >= source.length) {
        value += "\\";
        return value;
      }
      const escaped = source[cursor]!;
      cursor += 1;
      switch (escaped) {
        case "\"":
        case "\\":
        case "/":
          value += escaped;
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u": {
          const hex = source.slice(cursor, cursor + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            cursor += 4;
          } else {
            value += "\\u";
          }
          break;
        }
        default:
          value += `\\${escaped}`;
      }
    }
    return null;
  };

  while (cursor < source.length - 1) {
    skipWhitespaceAndCommas();
    if (source[cursor] === "}") {
      break;
    }
    const key = readString();
    if (key == null) {
      return Object.keys(output).length > 0 ? output : null;
    }
    skipWhitespaceAndCommas();
    if (source[cursor] !== ":") {
      return Object.keys(output).length > 0 ? output : null;
    }
    cursor += 1;
    skipWhitespaceAndCommas();
    const value = readString();
    if (value == null) {
      return Object.keys(output).length > 0 ? output : null;
    }
    output[key] = value;
  }

  return Object.keys(output).length > 0 ? output : null;
}

function describeSchema(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodObject) {
    const keys = Object.keys(schema.shape);
    if (keys.length > 0) {
      return `Top-level keys: ${keys.join(", ")}.`;
    }
  }
  return "Return a JSON object that matches the requested schema.";
}

function sanitizeSchemaName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "structured_output"
  );
}

function coerceObjectShape(schema: z.ZodTypeAny, raw: unknown): unknown {
  if (!(schema instanceof z.ZodObject)) {
    return raw;
  }

  const targetKeys = Object.keys(schema.shape);
  if (targetKeys.length !== 1) {
    return raw;
  }

  const targetKey = targetKeys[0]!;
  if (typeof raw === "string") {
    return {
      [targetKey]: raw,
    };
  }

  if (!isRecord(raw) || targetKey in raw) {
    return raw;
  }

  for (const alias of ["response_text", "responseText", "response", "answer", "text", "output"]) {
    const value = raw[alias];
    if (typeof value === "string" && value.trim().length > 0) {
      return {
        [targetKey]: value,
      };
    }
  }

  return raw;
}

export function createWorkersAiJsonModel(options: {
  model: string;
  binding?: string;
  gatewayId?: string;
  id?: string;
  systemPreamble?: string[];
  nativeSchema?: boolean;
}) {
  const runStructured = async <T>(args: {
    binding: { run: Function };
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }) => {
    const schemaName = sanitizeSchemaName(args.schemaName ?? options.model);
    const response = await args.binding.run(
      options.model,
      {
        messages: [
          ...args.messages,
          {
            role: "system",
            content: [
              ...(options.systemPreamble ?? []),
              "Use the provided response schema. Return only the structured object.",
            ].join("\n"),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            ...(args.schemaDescription ? { description: args.schemaDescription } : {}),
            schema: z.toJSONSchema(args.schema),
            strict: true,
          },
        },
      },
      {
        gateway: {
          id: options.gatewayId ?? "default",
        },
      },
    );

    const rawText = extractWorkersAiText(response);
    const parsed = coerceObjectShape(args.schema, parseWorkersAiJson(rawText));
    return {
      object: args.schema.parse(parsed),
      rawResponse: response,
    };
  };

  const runTextFallback = async <T>(args: {
    binding: { run: Function };
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
    previousError?: unknown;
    previousRawText?: string;
  }) => {
    const response = await args.binding.run(
      options.model,
      {
        messages: [
          ...args.messages,
          {
            role: "system",
            content: [
              ...(options.systemPreamble ?? []),
              "Return only a valid JSON object.",
              "Do not wrap the JSON in markdown fences.",
              describeSchema(args.schema),
              ...(args.schemaDescription ? [`Schema purpose: ${args.schemaDescription}`] : []),
              ...(args.previousError != null
                ? [`Previous structured-output attempt failed: ${String(args.previousError)}`]
                : []),
              ...(args.previousRawText != null
                ? [`Previous raw response to repair:\n${args.previousRawText.slice(0, 4000)}`]
                : []),
            ].join("\n"),
          },
        ],
      },
      {
        gateway: {
          id: options.gatewayId ?? "default",
        },
      },
    );

    const rawText = extractWorkersAiText(response);
    const parsed = coerceObjectShape(args.schema, parseWorkersAiJson(rawText));
    return {
      object: args.schema.parse(parsed),
      rawResponse: response,
    };
  };

  return {
    id: options.id ?? `cloudflare-workers-ai:${options.model}:custom-json`,
    provider: "cloudflare-workers-ai",
    model: options.model,
    async generateObject<T>(args: {
      messages: ModelMessage[];
      schema: z.ZodType<T>;
      env?: CloudflareEnvLike;
      schemaName?: string;
      schemaDescription?: string;
    }) {
      const bindingName = options.binding ?? "AI";
      const binding = args.env?.[bindingName];
      if (!isWorkersAiBinding(binding)) {
        throw new Error(`Workers AI binding "${bindingName}" was not found in the Cloudflare env.`);
      }

      if (options.nativeSchema === true) {
        try {
          return await runStructured({
            binding,
            messages: args.messages,
            schema: args.schema,
            ...(args.schemaName ? { schemaName: args.schemaName } : {}),
            ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
          });
        } catch (structuredError) {
          let previousRawText: string | undefined;
          if (isRecord(structuredError) && "rawResponse" in structuredError) {
            previousRawText = extractWorkersAiText(structuredError.rawResponse);
          }

          return runTextFallback({
            binding,
            messages: args.messages,
            schema: args.schema,
            ...(args.schemaName ? { schemaName: args.schemaName } : {}),
            ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
            previousError: structuredError,
            ...(previousRawText != null ? { previousRawText } : {}),
          });
        }
      }

      return runTextFallback({
        binding,
        messages: args.messages,
        schema: args.schema,
        ...(args.schemaName ? { schemaName: args.schemaName } : {}),
        ...(args.schemaDescription ? { schemaDescription: args.schemaDescription } : {}),
      });
    },
  };
}

export function createWorkersAiQueryProvider(options: {
  model: string;
  binding?: string;
  gatewayId?: string;
  systemPrompt?: string;
}): RLMQueryProvider {
  const runQuery = async (env: CloudflareEnvLike | undefined, prompt: string): Promise<string> => {
    const bindingName = options.binding ?? "AI";
    const binding = env?.[bindingName];
    if (!isRecord(binding) || typeof binding.run !== "function") {
      throw new Error(`Workers AI binding "${bindingName}" was not found in the Cloudflare env.`);
    }

    const response = await binding.run(
      options.model,
      {
        messages: [
          ...(options.systemPrompt != null
            ? [
                {
                  role: "system",
                  content: options.systemPrompt,
                } as const,
              ]
            : []),
          {
            role: "user",
            content: prompt,
          },
        ],
      },
      {
        gateway: {
          id: options.gatewayId ?? "default",
        },
      },
    );

    return extractWorkersAiText(response).trim();
  };

  return {
    async query(prompt, queryOptions) {
      return runQuery(queryOptions?.metadata?.env as CloudflareEnvLike | undefined, prompt);
    },
    async batch(prompts, queryOptions) {
      return Promise.all(
        prompts.map((prompt) =>
          runQuery(queryOptions?.metadata?.env as CloudflareEnvLike | undefined, prompt),
        ),
      );
    },
  };
}
