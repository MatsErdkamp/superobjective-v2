import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  so,
  type ModelProvider,
  type RLMPreparedContext,
  type RLMRuntime,
  type RLMSession,
  type RunTrace,
  type TraceStore,
} from "superobjective";

describe("RLM", () => {
  it("falls back to extract when SUBMIT payload is invalid", async () => {
    const traces = createTraceCapture();
    const model = createScriptedStructuredModel([
      {
        reasoning: "Submit the wrong shape first.",
        code: "await SUBMIT({ wrong: true });",
      },
      {
        answer: "fallback",
      },
    ]);

    const inspectQuestion = so.rlm(
      so
        .signature("inspect_question")
        .withInstructions("Inspect the prepared context and answer the question.")
        .withInput("question", z.string(), {
          description: "The question to answer.",
        })
        .withOutput("answer", z.string(), {
          description: "The final answer.",
        })
        .build(),
      {
        runtime: createQueuedRuntime({
          preparedContext: defaultPreparedContext(),
          steps: [
            {
              logs: ["attempted invalid submit"],
              queryCallsUsed: 0,
              submitted: {
                wrong: true,
              },
            },
          ],
        }),
        model,
        maxIterations: 1,
        maxLlmCalls: 2,
      },
    );

    const result = await inspectQuestion(
      {
        question: "What is the answer?",
      },
      {
        runtime: {
          traceStore: traces.store,
        },
      },
    );

    expect(result).toEqual({
      answer: "fallback",
    });

    const trace = traces.saved.at(-1);
    expect(trace?.targetKind).toBe("rlm");
    expect(trace?.programmable?.steps).toHaveLength(1);
    expect(trace?.programmable?.steps[0]?.submitValidationError?.message).toContain("answer");
  });

  it("executes a longCOT-style multi-step trajectory over long context", async () => {
    const traces = createTraceCapture();
    const longDossier = [
      "Investigation dossier:",
      ...Array.from({ length: 400 }, (_, index) => `Filler paragraph ${index + 1}.`),
      "The launch code is ORBIT-9.",
      "Use the launch code only after verification.",
    ].join("\n");

    const model = createScriptedStructuredModel([
      {
        reasoning: "Scan the prepared dossier summary and locate the likely evidence section.",
        code: "console.log('scan dossier');",
      },
      {
        reasoning: "Verify the exact evidence before submission.",
        code: "console.log('verify exact line');",
      },
      {
        reasoning: "Now submit the final typed output.",
        code: "await SUBMIT({ answer: 'ORBIT-9', evidence: 'The launch code is ORBIT-9.' });",
      },
    ]);

    let verified = false;
    let executeCalls = 0;
    const runtime: RLMRuntime = {
      async createSession(): Promise<RLMSession> {
        return {
          async prepareContext(input): Promise<RLMPreparedContext> {
            return {
              contextRoot: "/context/longcot",
              manifestPath: "/context/longcot/_manifest.json",
              manifestSummary: [
                "Context root: /context/longcot",
                "Resources:",
                `- dossier (/context/longcot/dossier.txt, ${String(input.dossier).length} chars)`,
              ].join("\n"),
              resources: [
                {
                  name: "dossier",
                  path: "/context/longcot/dossier.txt",
                  kind: "text",
                  preview: String(input.dossier).slice(0, 80),
                },
              ],
              availableTools:
                "console.log, query, queryBatch, SUBMIT, and runtime-specific readers",
            };
          },
          async executeStep(request) {
            executeCalls += 1;

            if (request.code.includes("scan dossier")) {
              return {
                logs: ["scanned dossier summary"],
                stdout: "Located likely evidence near the tail of the dossier.",
                queryCallsUsed: 1,
              };
            }

            if (request.code.includes("verify exact line")) {
              verified = true;
              return {
                logs: ["verified exact evidence line"],
                stdout: "Confirmed: The launch code is ORBIT-9.",
                queryCallsUsed: 2,
              };
            }

            if (request.code.includes("SUBMIT")) {
              return {
                logs: ["ready to submit"],
                queryCallsUsed: 2,
                submitted: verified
                  ? {
                      answer: "ORBIT-9",
                      evidence: "The launch code is ORBIT-9.",
                    }
                  : {
                      answer: "UNKNOWN",
                      evidence: "verification missing",
                    },
              };
            }

            return {
              logs: ["no-op"],
              queryCallsUsed: request.queryCallsUsed,
            };
          },
          async close() {},
        };
      },
    };

    const inspectDossier = so.rlm(
      so
        .signature("inspect_dossier")
        .withInstructions("Inspect the prepared dossier and return the launch code.")
        .withInput("question", z.string(), {
          description: "The user question.",
        })
        .withInput("dossier", z.string(), {
          description: "The long dossier text.",
        })
        .withOutput("answer", z.string(), {
          description: "The launch code.",
        })
        .withOutput("evidence", z.string(), {
          description: "The exact evidence string used to justify the answer.",
        })
        .build(),
      {
        runtime,
        model,
        maxIterations: 4,
        maxLlmCalls: 5,
      },
    );

    const result = await inspectDossier(
      {
        question: "What is the launch code?",
        dossier: longDossier,
      },
      {
        runtime: {
          traceStore: traces.store,
        },
      },
    );

    expect(result).toEqual({
      answer: "ORBIT-9",
      evidence: "The launch code is ORBIT-9.",
    });
    expect(verified).toBe(true);
    expect(executeCalls).toBe(3);

    const trace = traces.saved.at(-1);
    expect(trace?.programmable?.mode).toBe("rlm");
    expect(trace?.programmable?.steps).toHaveLength(3);
    expect(trace?.programmable?.steps[0]?.reasoning).toContain("Scan");
    expect(trace?.programmable?.steps[2]?.submitted).toEqual({
      answer: "ORBIT-9",
      evidence: "The launch code is ORBIT-9.",
    });
    expect(trace?.components.filter((component) => component.componentKind === "predict")).toHaveLength(3);
  });
});

function createScriptedStructuredModel(outputs: unknown[]): ModelProvider {
  let index = 0;
  return {
    id: "scripted-structured-model",
    async structured() {
      const next = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return {
        object: next,
      };
    },
  };
}

function defaultPreparedContext(): RLMPreparedContext {
  return {
    contextRoot: "/context/test",
    manifestPath: "/context/test/_manifest.json",
    manifestSummary: "Context root: /context/test\nResources:\n- document (/context/test/document.txt)",
    resources: [
      {
        name: "document",
        path: "/context/test/document.txt",
        kind: "text",
        preview: "Preview",
      },
    ],
    availableTools: "query, queryBatch, SUBMIT",
  };
}

function createQueuedRuntime(args: {
  preparedContext: RLMPreparedContext;
  steps: Array<{
    stdout?: string;
    stderr?: string;
    logs?: string[];
    submitted?: unknown;
    queryCallsUsed: number;
    error?: string;
  }>;
}): RLMRuntime {
  return {
    async createSession(): Promise<RLMSession> {
      const queue = [...args.steps];
      return {
        async prepareContext() {
          return args.preparedContext;
        },
        async executeStep() {
          const next = queue.shift();
          if (next == null) {
            throw new Error("No scripted RLM step result remaining.");
          }
          return next;
        },
        async close() {},
      };
    },
  };
}

function createTraceCapture(): {
  saved: RunTrace[];
  store: TraceStore;
} {
  const saved: RunTrace[] = [];
  return {
    saved,
    store: {
      async saveTrace(trace) {
        saved.push(structuredClone(trace));
      },
      async loadTrace(runId) {
        return saved.find((trace) => trace.runId === runId) ?? null;
      },
    },
  };
}
