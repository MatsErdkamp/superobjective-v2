import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import { so } from "superobjective";

import { createWorkersAiJsonModel } from "./workers-ai";

const relaxedXmlAdapter = (() => {
  const base = so.adapters.xml();
  return {
    ...base,
    async format(args: Parameters<typeof base.format>[0]) {
      const formatted = await base.format(args);
      return {
        ...formatted,
        output: {
          ...formatted.output,
          strict: false,
        },
      };
    },
  };
})();

const gemmaStructuredModel = createWorkersAiJsonModel({
  model: "@cf/google/gemma-4-26b-a4b-it",
  systemPreamble: [
    "For act steps, return JSON with string fields reasoning and code.",
    "For final extraction, return JSON matching the requested schema exactly.",
  ],
});

export const inspectLaunchDossier = so.rlm(
  so
    .signature("inspect_launch_dossier")
    .withInstructions(
      "Inspect the long dossier and return the verified launch code plus exact evidence. The dossier contains one exact line in the format LAUNCH_CODE=<value>.",
    )
    .withInput("question", z.string(), {
      description: "The user question.",
    })
    .withInput("dossier", z.string(), {
      description: "A long dossier that must be inspected through the RLM runtime helpers.",
    })
    .withOutput("answer", z.string(), {
      description: "The verified launch code.",
    })
    .withOutput("evidence", z.string(), {
      description: "The exact evidence line that supports the answer.",
    })
    .build(),
  {
    runtime: cloudflare.rlm.runtime(),
    model: gemmaStructuredModel as never,
    maxIterations: 4,
    maxLlmCalls: 4,
    adapter: relaxedXmlAdapter,
    act: {
      instructions: so.text({
        value: [
          "Use the prepared runtime helpers to inspect the dossier before answering.",
          "Every runtime helper returns a Promise. Always use await with listResources, searchText, readMatchWindow, and SUBMIT.",
          "Use a short three-step plan and keep each step focused.",
          "When there is no REPL history yet, only initialize dossierPath. Use code like: const resources = await listResources(); const dossier = resources.find((resource) => resource.name === 'dossier'); if (!dossier) throw new Error('dossier resource missing'); const dossierPath = dossier.path;",
          "When dossierPath is available but match is not, only run searchText. Use code like: const results = await searchText(dossierPath, 'LAUNCH_CODE='); if (!results.matches.length) throw new Error('launch code evidence missing'); const match = results.matches[0];",
          "When match is available, read the exact evidence line with await readMatchWindow(...), parse the answer from the LAUNCH_CODE=<value> format, and then await SUBMIT({ answer, evidence }).",
          "The final answer must be parsed from the evidence line itself. Do not guess it ahead of time.",
          "If parsing fails, throw an error instead of submitting a guess.",
          "Use concise JavaScript and reuse prior variables rather than recomputing everything.",
          "Do not call SUBMIT until you have read the exact evidence line from the dossier.",
          "Keep variables reusable across steps because the runtime preserves prior successful cells.",
          "Return only the next JavaScript step.",
        ].join("\n"),
        optimize: true,
      }),
    },
    extract: {
      instructions: so.text({
        value: [
          "Produce the final output only from concrete evidence in the trajectory.",
          "If the exact launch code evidence was not verified, do not invent missing details.",
        ].join("\n"),
        optimize: true,
      }),
    },
  },
);
