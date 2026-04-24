import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import { so } from "superobjective";

import { createWorkersAiJsonModel, createWorkersAiQueryProvider } from "./workers-ai";

const LONGCOT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const longcotStructuredModel = createWorkersAiJsonModel({
  model: LONGCOT_MODEL,
  nativeSchema: true,
  systemPreamble: [
    "You are the structured planning model for a general-purpose LongCoT RLM run.",
    "For act steps, return JSON with string fields reasoning and code.",
    "For final extraction, return JSON matching the requested schema exactly.",
  ],
});

const longcotQueryProvider = createWorkersAiQueryProvider({
  model: LONGCOT_MODEL,
  systemPrompt: [
    "You are a careful LongCoT subsolver.",
    "Return concise plain text only.",
    "When asked for an exact final answer surface, return only that exact answer surface with no markdown fences.",
  ].join("\n"),
});

export const solveLongCotQuestion = so.rlm(
  so
    .signature("solve_longcot_question")
    .withInstructions(
      [
        "Solve an official LongCoT benchmark question.",
        "Use the RLM runtime as a general-purpose iterative environment rather than a benchmark-specific solver.",
        "Return the exact raw response text that should be passed directly into the official LongCoT verifier.",
      ].join(" "),
    )
    .withInput("question_id", z.string().optional(), {
      description: "The official benchmark question id, if available.",
      optional: true,
    })
    .withInput("domain", z.string(), {
      description: "The official LongCoT domain such as logic, cs, chemistry, chess, or math.",
    })
    .withInput("difficulty", z.string(), {
      description: "The official LongCoT difficulty such as easy, medium, or hard.",
    })
    .withInput("prompt", z.string(), {
      description: "The raw benchmark prompt.",
    })
    .withOutput("response_text", z.string(), {
      description: "The raw benchmark response text that will be passed directly into the official LongCoT verifier.",
    })
    .build(),
  {
    runtime: cloudflare.rlm.runtime({
      inlineStringChars: 200_000,
    }),
    model: longcotStructuredModel as never,
    queryProvider: longcotQueryProvider,
    maxIterations: 6,
    maxLlmCalls: 10,
    maxOutputChars: 12_000,
    adapter: so.adapters.nativeStructured(),
    act: {
      instructions: so.text({
        value: [
          "Operate as a general-purpose iterative JavaScript RLM.",
          "The REPL exposes `inputs`, `getInput`, `print`, `llm_query`, `llm_query_batched`, `getManifest`, `listResources`, `readText`, `searchText`, `readMatchWindow`, and `SUBMIT`.",
          "Start by exploring the prompt and understanding the task before attempting a final answer.",
          "In the first step, inspect the available inputs and print a short summary such as the domain, question id, prompt length, and the answer surface the prompt seems to require.",
          "Use `print(...)` every step to record concrete observations. Do not stay silent unless you are submitting.",
          "Do not print the full prompt. Print bounded slices, parsed values, counts, and exact evidence snippets only.",
          "This is a Worker JavaScript REPL, not Node.js. Do not use `require`, `fs`, `process`, `Buffer`, or other Node-only APIs.",
          "Treat `inputs.prompt` as data. Parse or inspect the exact text instead of relying on memory of benchmark families.",
          "If the prompt is long or structured, break the work into smaller inspected subproblems and only use `llm_query` on bounded snippets or clearly-scoped semantic questions.",
          "Use `llm_query_batched` when several independent subquestions can be asked in parallel.",
          "Do not hard-code benchmark-family branches or assume a solver exists for a known domain.",
          "Do not submit immediately after a semantic guess. Verify the exact answer surface from the prompt and your computed evidence first.",
          "If the previous step failed or produced malformed formatting, repair only the failing part instead of restarting the whole solution.",
          'The final submitted object must be exactly { response_text: "..." }.',
          "The benchmark grader consumes raw text. Match the exact answer surface required by the prompt.",
          "Return only the next JavaScript step.",
        ].join("\n"),
        optimize: true,
      }),
    },
    extract: {
      instructions: so.text({
        value: [
          "Produce the final benchmark response text from the verified trajectory.",
          "Use the trajectory exactly as evidence. Do not invent unsupported details.",
          "Match the exact answer surface required by the prompt and avoid markdown fences or explanatory prose.",
        ].join("\n"),
        optimize: true,
      }),
    },
  },
);
