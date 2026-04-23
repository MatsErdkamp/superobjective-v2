import { type CloudflareEnvLike } from "@superobjective/cloudflare";
import { type ModelMessage, type RLMQueryProvider } from "superobjective";
import { z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("Workers AI response did not contain a parseable JSON object.");
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
}) {
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
      if (!isRecord(binding) || typeof binding.run !== "function") {
        throw new Error(`Workers AI binding "${bindingName}" was not found in the Cloudflare env.`);
      }

      const response = await binding.run(
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
