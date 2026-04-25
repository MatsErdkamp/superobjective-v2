import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import { so } from "superobjective";

import { createWorkersAiJsonModel, createWorkersAiQueryProvider } from "./workers-ai";

const LONGCOT_MODEL = "openai/gpt-5.4";

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
    .withOutput("response_text", z.string().trim().min(1), {
      description: "The raw benchmark response text that will be passed directly into the official LongCoT verifier.",
    })
    .build(),
  {
    runtime: cloudflare.rlm.runtime({
      inlineStringChars: 4_000,
    }),
    model: longcotStructuredModel as never,
    queryProvider: longcotQueryProvider,
    maxIterations: 50,
    maxLlmCalls: 50,
    maxOutputChars: 10_000,
    adapter: so.adapters.nativeStructured(),
    act: {
      instructions: so.text({
        value: [
          "Operate as a general-purpose iterative JavaScript RLM.",
          "The REPL exposes `inputs`, `print`, `rlm.query`, `rlm.queryBatch`, and `SUBMIT`; for large prompts it also exposes `resources.list()` and `resources.readText(...)`.",
          "Start by exploring the prompt and understanding the task before attempting a final answer.",
          "In the first step, inspect `inputs.prompt` when present; otherwise locate the prompt resource with `resources.list()` and read bounded slices with `resources.readText(...)`.",
          "Print a short summary such as the domain, question id, prompt length, and the answer surface the prompt seems to require.",
          "Use `print(...)` every step to record concrete observations. Do not stay silent unless you are submitting.",
          "Do not print the full prompt. Print bounded slices, parsed values, counts, and exact evidence snippets only.",
          "This is a Worker JavaScript REPL, not Node.js. Do not use `require`, `fs`, `process`, `Buffer`, or other Node-only APIs.",
          "Treat `inputs.prompt` as data. Parse or inspect the exact text instead of relying on memory of benchmark families.",
          "If the prompt contains examples plus a separate puzzle/problem instance, ignore the examples for computation. Create a `taskText` variable from the final actual instance section, for example `const taskText = prompt.includes('Puzzle instance:') ? prompt.slice(prompt.lastIndexOf('Puzzle instance:')) : prompt;`, and parse task data only from `taskText`.",
          "When a prompt defines an exact output item schema, preserve it exactly. For example, if it says a move is `[block, from_stack, to_stack]`, every move must contain exactly those three fields in that order.",
          "Before submitting any computed structured solution, verify that parsed sizes/counts match the declared instance metadata and that simulation/checking reaches the exact requested goal.",
          "If the prompt is long or structured, break the work into smaller inspected subproblems and only use `rlm.query` on bounded snippets or clearly-scoped semantic questions.",
          "Use `rlm.queryBatch` when several independent subquestions can be asked in parallel.",
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
