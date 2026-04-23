import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { Parser } from "../packages/cloudflare/node_modules/acorn";

import {
  cloudflare,
  createCloudflareWorker,
  type CloudflareEnvLike,
  type CloudflareHostedRlmSessionManager,
} from "@superobjective/cloudflare";
import { buildRlmFacetWorkerSource } from "../packages/cloudflare/src/rlm-facet-source";
import { so, type ModelProvider, type RLMSessionCheckpoint, type RunTrace, type TraceStore } from "superobjective";

const financeCorpus = so.corpus({
  id: "finance-records",
  storage: {
    kind: "r2",
    bucketBinding: "SO_DATA",
    prefix: "finance/2026/q1",
  },
  retrieval: {
    kind: "ai-search",
    binding: "AI_SEARCH",
    namespace: "finance-records",
    instanceId: "finance-records",
    sourceMode: "external-r2",
  },
});

function createScriptedStructuredModel(outputs: unknown[]): ModelProvider {
  let index = 0;
  return {
    id: "scripted-cloudflare-rlm-model",
    async structured() {
      const next = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return {
        object: next,
      };
    },
  };
}

function createScriptedQueryProvider(outputs: string[]) {
  let index = 0;
  return {
    async query(_prompt: string) {
      const next = outputs[Math.min(index, outputs.length - 1)] ?? "";
      index += 1;
      return next;
    },
    async batch(prompts: string[]) {
      return prompts.map(() => {
        const next = outputs[Math.min(index, outputs.length - 1)] ?? "";
        index += 1;
        return next;
      });
    },
  };
}

function createTraceCapture() {
  const saved: RunTrace[] = [];
  const store: TraceStore = {
    async saveTrace(trace) {
      saved.push(trace);
    },
    async loadTrace(runId) {
      return saved.find((trace) => trace.runId === runId) ?? null;
    },
    async listTraces() {
      return [...saved];
    },
  };
  return {
    saved,
    store,
  };
}

class TestBucket {
  private readonly store = new Map<string, string | Uint8Array>();

  constructor(seed?: Record<string, string | Uint8Array>) {
    for (const [key, value] of Object.entries(seed ?? {})) {
      this.store.set(key, value);
    }
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream) {
    if (typeof value === "string") {
      this.store.set(key, value);
      return;
    }

    if (value instanceof Blob) {
      this.store.set(key, new Uint8Array(await value.arrayBuffer()));
      return;
    }

    if (value instanceof ReadableStream) {
      this.store.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
      return;
    }

    if (ArrayBuffer.isView(value)) {
      this.store.set(key, new Uint8Array(value.buffer.slice(0)));
      return;
    }

    this.store.set(key, new Uint8Array(value.slice(0)));
  }

  async get(key: string) {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }

    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    return {
      size: bytes.byteLength,
      async text() {
        return typeof value === "string" ? value : new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right))
        .map((key) => ({ key })),
    };
  }
}

class TestSearchNamespace {
  private readonly instances = new Map<
    string,
    {
      info(): Promise<unknown>;
      search(args: Record<string, unknown>): Promise<unknown>;
      items: {
        uploadAndPoll(name: string): Promise<{ id: string; filename?: string }>;
        delete(itemId: string): Promise<void>;
      };
    }
  >();

  createInstance(name: string, responseFactory?: (args: Record<string, unknown>) => unknown) {
    this.instances.set(name, {
      async info() {
        return {
          id: name,
        };
      },
      async search(args: Record<string, unknown>) {
        return (
          responseFactory?.(args) ?? {
            results: [],
          }
        );
      },
      items: {
        async uploadAndPoll(filename: string) {
          return {
            id: `${name}:${filename}`,
            filename,
          };
        },
        async delete(_itemId: string) {},
      },
    });
  }

  get(name: string) {
    const instance = this.instances.get(name);
    if (instance == null) {
      throw new Error(`Search instance "${name}" was not found.`);
    }
    return instance;
  }

  async create(options: { id: string }) {
    this.createInstance(options.id);
    return this.get(options.id);
  }

  async delete(name: string) {
    this.instances.delete(name);
  }
}

function createCorpusEnv(): CloudflareEnvLike {
  const bucket = new TestBucket({
    "finance/2026/q1/refunds.csv": "order_id,amount,status\nord_1,42.00,settled\n",
    "finance/2026/q1/ledger.csv": "entry_id,kind\nent_1,refund\n",
  });
  const search = new TestSearchNamespace();
  search.createInstance("finance-records", () => ({
    data: [
      {
        id: "hit-refund-1",
        text: "refund settled",
        score: 0.91,
        metadata: {
          key: "refunds.csv",
          source: "finance/2026/q1/refunds.csv",
        },
      },
    ],
  }));
  return {
    SO_DATA: bucket as NonNullable<CloudflareEnvLike["SO_DATA"]>,
    AI_SEARCH: search as NonNullable<CloudflareEnvLike["AI_SEARCH"]>,
  };
}

function createNodeExecutor() {
  return {
    async execute(
      code: string,
      providersOrFns:
        | Array<{
            name: string;
            fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
            positionalArgs?: boolean;
          }>
        | Record<string, (...args: unknown[]) => Promise<unknown>>,
    ) {
      const providers = Array.isArray(providersOrFns)
        ? providersOrFns
        : [
            {
              name: "codemode",
              fns: providersOrFns,
            },
          ];

      const logs: string[] = [];
      const scope: Record<string, unknown> = {
        console: {
          log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
          warn: (...args: unknown[]) => logs.push(`[warn] ${args.map((value) => String(value)).join(" ")}`),
          error: (...args: unknown[]) => logs.push(`[error] ${args.map((value) => String(value)).join(" ")}`),
        },
      };

      for (const provider of providers) {
        scope[provider.name] = new Proxy(
          {},
          {
            get(_target, toolName) {
              return async (...args: unknown[]) => {
                const fn = provider.fns[String(toolName)];
                if (fn == null) {
                  throw new Error(`Tool "${String(toolName)}" was not found.`);
                }
                if (provider.positionalArgs) {
                  return fn(...args);
                }
                return fn(args[0] ?? {});
              };
            },
          },
        );
      }

      try {
        const names = Object.keys(scope);
        const values = Object.values(scope);
        const runner = new Function(...names, `return (${code})();`);
        const result = await runner(...values);
        return {
          result,
          logs,
        };
      } catch (error) {
        return {
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
          logs,
        };
      }
    },
  };
}

function createHostedSessionManager(config?: {
  failStepExecutionOnceAt?: number;
}): CloudflareHostedRlmSessionManager {
  const sessions = new Map<
    string,
    {
      inlineInputs: Record<string, unknown>;
      trackedNames: string[];
      globals: Record<string, unknown>;
      checkpoint: RLMSessionCheckpoint | null;
      stepCount: number;
      failureConsumed: boolean;
    }
  >();

  return {
    async openSession({ runId }) {
      let state = sessions.get(runId);
      if (state == null) {
        state = {
          inlineInputs: {},
          trackedNames: [],
          globals: {},
          checkpoint: null,
          stepCount: 0,
          failureConsumed: false,
        };
        sessions.set(runId, state);
      }

      return {
        async init(payload) {
          state.inlineInputs = payload.inlineInputs;
          state.trackedNames = [];
          state.globals = {};
          state.checkpoint = null;
          state.stepCount = 0;
          state.failureConsumed = false;
        },
        async describe() {
          return {
            trackedNames: state.trackedNames,
          };
        },
        async step({ compiled, request }) {
          state.stepCount += 1;
          if (
            config?.failStepExecutionOnceAt != null &&
            state.stepCount === config.failStepExecutionOnceAt &&
            !state.failureConsumed
          ) {
            state.failureConsumed = true;
            throw new Error("Simulated hosted session crash");
          }

          const logs: string[] = [];
          const globals = structuredClone(state.globals);
          const trackedPrelude = compiled.trackedNames
            .map((name) => `let ${name} = __globals[${JSON.stringify(name)}];`)
            .join("\n");
          const trackedSync = compiled.trackedNames
            .map((name) => `__globals[${JSON.stringify(name)}] = ${name};`)
            .join("\n");
          const body = [
            "let __submitted;",
            "const __globals = globalThis.__rlmGlobals;",
            "const inputs = globalThis.__rlmInputs;",
            "const SUBMIT = async (value) => { __submitted = value; return value; };",
            "const print = (...args) => globalThis.__rlmLogs.push(args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));",
            "const console = { log: (...args) => print(...args), warn: (...args) => print(...args), error: (...args) => print(...args) };",
            "const getInput = async (key) => key == null ? inputs : inputs[key];",
            "const getManifest = async () => null;",
            "const listResources = async () => [];",
            "const query = async () => { throw new Error('query not configured in test'); };",
            "const llm_query = async (...args) => query(...args);",
            "const queryBatch = async () => { throw new Error('queryBatch not configured in test'); };",
            "const llm_query_batched = async (...args) => queryBatch(...args);",
            "const readText = async () => { throw new Error('readText not configured in test'); };",
            "const searchText = async () => { throw new Error('searchText not configured in test'); };",
            "const readMatchWindow = async () => { throw new Error('readMatchWindow not configured in test'); };",
            trackedPrelude,
            compiled.transformedCode,
            trackedSync,
            "return { submitted: __submitted };",
          ].join("\n");

          (globalThis as Record<string, unknown>).__rlmGlobals = globals;
          (globalThis as Record<string, unknown>).__rlmInputs = state.inlineInputs;
          (globalThis as Record<string, unknown>).__rlmLogs = logs;

          try {
            const runner = new Function(`return (async () => { ${body} })();`);
            const result = (await runner()) as { submitted?: unknown };
            state.globals = globals;
            state.trackedNames = compiled.trackedNames;
            return {
              ...(result.submitted !== undefined ? { submitted: result.submitted } : {}),
              ...(logs.length > 0 ? { logs, stdout: logs.join("\n") } : {}),
              queryCallsUsed: request.queryCallsUsed,
            };
          } finally {
            delete (globalThis as Record<string, unknown>).__rlmGlobals;
            delete (globalThis as Record<string, unknown>).__rlmInputs;
            delete (globalThis as Record<string, unknown>).__rlmLogs;
          }
        },
        async checkpoint(value) {
          state.checkpoint = structuredClone(value);
        },
        async resume() {
          return state.checkpoint == null ? null : structuredClone(state.checkpoint);
        },
        async close() {},
      };
    },
  };
}

describe("cloudflare RLM runtime", () => {
  it("exposes DSPy-style REPL primitives for inputs, print, and llm_query", async () => {
    const traces = createTraceCapture();
    const solvePrompt = so.rlm(
      so
        .signature("solve_prompt")
        .withInstructions("Solve the prompt and return the final answer surface.")
        .withInput("question_id", z.string(), {
          description: "Benchmark question id.",
        })
        .withInput("domain", z.string(), {
          description: "Benchmark domain.",
        })
        .withInput("difficulty", z.string(), {
          description: "Benchmark difficulty.",
        })
        .withInput("prompt", z.string(), {
          description: "Raw prompt text.",
        })
        .withOutput("response_text", z.string(), {
          description: "Final answer text.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          executor: createNodeExecutor(),
          inlineStringChars: 10_000,
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Inspect the inline inputs first.",
            code: "print(inputs.domain, inputs.question_id, inputs.difficulty); print(inputs.prompt.slice(0, 18));",
          },
          {
            reasoning: "Use the semantic alias on the bounded prompt and submit the returned answer surface.",
            code: "const response_text = (await llm_query(`Return only the final answer surface for this prompt:\\n${inputs.prompt}`)).trim(); await SUBMIT({ response_text });",
          },
        ]),
        queryProvider: createScriptedQueryProvider(["solution = sample-answer"]),
        maxIterations: 3,
        maxLlmCalls: 4,
      },
    );

    const result = await solvePrompt(
      {
        question_id: "logic_easy_1",
        domain: "logic",
        difficulty: "easy",
        prompt: "Return exactly: solution = sample-answer",
      },
      {
        runtime: {
          traceStore: traces.store,
        },
      },
    );

    expect(result.response_text).toBe("solution = sample-answer");

    const trace = traces.saved.at(-1);
    expect(trace?.programmable?.steps).toHaveLength(2);
    expect(trace?.programmable?.steps[0]?.stdout).toContain("logic logic_easy_1 easy");
    expect(trace?.programmable?.steps[0]?.stdout).toContain("Return exactly:");
    expect(trace?.programmable?.steps[1]?.toolCalls[0]?.toolName).toBe("rlm.query");
  });

  it("executes a longCOT-style replayed trajectory over corpus search and file reads", async () => {
    const env = createCorpusEnv();
    const traces = createTraceCapture();
    const inspectFinance = so.rlm(
      so
        .signature("inspect_finance_records")
        .withInstructions("Inspect finance records and answer with the refund status.")
        .withInput("question", z.string(), {
          description: "The question to answer.",
        })
        .withOutput("answer", z.string(), {
          description: "The resolved status.",
        })
        .withOutput("evidence", z.string(), {
          description: "The exact evidence snippet.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          executor: createNodeExecutor(),
          env,
          corpora: [financeCorpus],
          corpusIds: ["finance-records"],
          includeSearchInfo: true,
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Use retrieval to find the likely file first.",
            code: "let hit = (await searchCorpus('finance-records', { query: 'refund settled', maxResults: 1 })).chunks[0];",
          },
          {
            reasoning: "Verify the exact row in the underlying file before answering.",
            code: "let filePath = `/corpora/finance-records/${hit.item.key}`; let match = (await searchText(filePath, 'settled')).matches[0]; let evidence = (await readMatchWindow(filePath, match, { beforeChars: 12, afterChars: 12 })).text;",
          },
          {
            reasoning: "Submit the final typed output now that the row is verified.",
            code: "await SUBMIT({ answer: 'settled', evidence });",
          },
        ]),
        maxIterations: 4,
        maxLlmCalls: 5,
      },
    );

    const result = await inspectFinance(
      {
        question: "What is the refund status?",
      },
      {
        runtime: {
          traceStore: traces.store,
        },
      },
    );

    expect(result.answer).toBe("settled");
    expect(result.evidence).toContain("settled");

    const trace = traces.saved.at(-1);
    expect(trace?.programmable?.mode).toBe("rlm");
    expect(trace?.programmable?.steps).toHaveLength(3);
    expect((trace?.metadata as { rlmSession?: { kind?: string } } | undefined)?.rlmSession?.kind).toBe(
      "cloudflare-replay",
    );
    expect(trace?.programmable?.steps[0]?.toolCalls[0]?.toolName).toBe("rlm.searchCorpus");
    expect(trace?.programmable?.steps[1]?.toolCalls[0]?.toolName).toBe("rlm.searchText");
  });

  it("uses the hosted session manager to preserve variables without replaying prior logs", async () => {
    const traces = createTraceCapture();
    const hostedManager = createHostedSessionManager();
    const module = so.rlm(
      so
        .signature("hosted_session_probe")
        .withInstructions("Use the persistent session state across steps.")
        .withInput("prompt", z.string(), {
          description: "Prompt text.",
        })
        .withOutput("answer", z.string(), {
          description: "Final answer.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          hostedSessionManager: hostedManager,
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Create the initial state.",
            code: "const results = [1, 2, 3]; print('step1', results.length);",
          },
          {
            reasoning: "Reuse and overwrite the same top-level binding in the hot session.",
            code: "const results = results.slice(1); print('step2', results.join(',')); await SUBMIT({ answer: results.join(',') });",
          },
        ]),
        maxIterations: 2,
        maxLlmCalls: 4,
        extract: {
          enabled: false,
        },
      },
    );

    const result = await module(
      {
        prompt: "reuse results",
      },
      {
        runtime: {
          traceStore: traces.store,
        },
      },
    );

    expect(result.answer).toBe("2,3");

    const trace = traces.saved.at(-1);
    expect(trace?.programmable?.steps).toHaveLength(2);
    expect((trace?.metadata as { rlmSession?: { kind?: string; resumed?: boolean } } | undefined)?.rlmSession).toEqual({
      kind: "cloudflare-hosted-facet",
      resumed: false,
    });
    expect(trace?.programmable?.steps[0]?.stdout).toContain("step1 3");
    expect(trace?.programmable?.steps[1]?.stdout).toContain("step2 2,3");
    expect(trace?.programmable?.steps[1]?.stdout).not.toContain("step1 3");
  });

  it("resumes a hosted session from the saved checkpoint on the same runId", async () => {
    const traces = createTraceCapture();
    const hostedManager = createHostedSessionManager();
    const firstAttempt = so.rlm(
      so
        .signature("resume_hosted_session_probe")
        .withInstructions("Resume from a saved hosted-session checkpoint.")
        .withInput("prompt", z.string(), {
          description: "Prompt text.",
        })
        .withOutput("answer", z.string(), {
          description: "Final answer.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          hostedSessionManager: hostedManager,
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Create the first value.",
            code: "const counter = 1; print('first', counter);",
          },
        ]),
        maxIterations: 1,
        maxLlmCalls: 2,
        extract: {
          enabled: false,
        },
      },
    );

    await expect(
      firstAttempt(
        {
          prompt: "resume me",
        },
        {
          runtime: {
            traceStore: traces.store,
          },
        },
      ),
    ).rejects.toThrow("extract fallback is disabled");

    const failedTrace = traces.saved.at(-1);
    expect(failedTrace?.programmable?.steps).toHaveLength(1);
    const runId = failedTrace?.runId;
    expect(typeof runId).toBe("string");

    const resumedAttempt = so.rlm(
      so
        .signature("resume_hosted_session_probe")
        .withInstructions("Resume from a saved hosted-session checkpoint.")
        .withInput("prompt", z.string(), {
          description: "Prompt text.",
        })
        .withOutput("answer", z.string(), {
          description: "Final answer.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          hostedSessionManager: hostedManager,
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Resume from the checkpointed value.",
            code: "const counter = counter + 1; print('second', counter); await SUBMIT({ answer: String(counter) });",
          },
        ]),
        maxIterations: 2,
        maxLlmCalls: 3,
        extract: {
          enabled: false,
        },
      },
    );

    const resumed = await resumedAttempt(
      {
        prompt: "resume me",
      },
      {
        runtime: {
          traceStore: traces.store,
          __superobjectiveRlmResume: {
            runId,
          },
        } as unknown as Parameters<typeof module>[1]["runtime"],
      },
    );

    expect(resumed.answer).toBe("2");

    const resumedTrace = traces.saved.at(-1);
    expect(resumedTrace?.runId).toBe(runId);
    expect(resumedTrace?.programmable?.steps).toHaveLength(2);
    expect(
      (resumedTrace?.metadata as { rlmSession?: { kind?: string; resumed?: boolean } } | undefined)?.rlmSession,
    ).toEqual({
      kind: "cloudflare-hosted-facet",
      resumed: true,
    });
    expect(resumedTrace?.programmable?.steps[0]?.stdout).toContain("first 1");
    expect(resumedTrace?.programmable?.steps[1]?.stdout).toContain("second 2");
  });

  it("emits a syntactically valid facet worker source", () => {
    const source = buildRlmFacetWorkerSource();
    expect(source).toContain("export class RlmSessionFacet");
    expect(() =>
      Parser.parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
      }),
    ).not.toThrow();
  });

  it("runs through /kernel/rlm/:moduleId and persists the RLM run plus steps", async () => {
    const env = createCorpusEnv();
    const inspectFinance = so.rlm(
      so
        .signature("inspect_finance_records")
        .withInstructions("Inspect finance records and answer with the refund status.")
        .withInput("question", z.string(), {
          description: "The question to answer.",
        })
        .withOutput("answer", z.string(), {
          description: "The resolved status.",
        })
        .withOutput("evidence", z.string(), {
          description: "The exact evidence snippet.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          executor: createNodeExecutor(),
          corpora: [financeCorpus],
          corpusIds: ["finance-records"],
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Search the indexed corpus first.",
            code: "let hit = (await searchCorpus('finance-records', { query: 'refund settled', maxResults: 1 })).chunks[0];",
          },
          {
            reasoning: "Read the exact file and submit the answer.",
            code: "let content = (await readCorpusFile('finance-records', hit.item.key)).content; await SUBMIT({ answer: content.includes('settled') ? 'settled' : 'unknown', evidence: content.trim() });",
          },
        ]),
        maxIterations: 3,
        maxLlmCalls: 4,
      },
    );

    const worker = createCloudflareWorker({
      project: so.project({
        programs: [inspectFinance],
        corpora: [financeCorpus],
      }),
    });

    const response = await worker.fetch(
      new Request("https://example.com/kernel/rlm/inspect_finance_records", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            question: "What is the refund status?",
          },
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      output: {
        answer: string;
        evidence: string;
      };
      traceId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.output.answer).toBe("settled");

    const runResponse = await worker.fetch(
      new Request(`https://example.com/kernel/rlm/${encodeURIComponent(payload.traceId)}`),
      env,
    );

    expect(runResponse.status).toBe(200);
    const runPayload = (await runResponse.json()) as {
      ok: boolean;
      run: {
        moduleId: string;
        status: string;
      };
      steps: Array<{
        stepIndex: number;
      }>;
    };

    expect(runPayload.ok).toBe(true);
    expect(runPayload.run.moduleId).toBe("inspect_finance_records");
    expect(runPayload.run.status).toBe("completed");
    expect(runPayload.steps.map((step) => step.stepIndex)).toEqual([1, 2]);
  });

  it("returns a traceId and persists a failed RLM trace", async () => {
    const failingRlm = so.rlm(
      so
        .signature("failing_longcot_probe")
        .withInstructions("Return a raw benchmark response text.")
        .withInput("prompt", z.string(), {
          description: "The benchmark prompt.",
        })
        .withOutput("response_text", z.string(), {
          description: "The final raw benchmark response text.",
        })
        .build(),
      {
        runtime: cloudflare.rlm.runtime({
          executor: createNodeExecutor(),
        }),
        model: createScriptedStructuredModel([
          {
            reasoning: "Submit the wrong field to force a schema error.",
            code: "await SUBMIT({ answer: 'wrong shape' });",
          },
        ]),
        maxIterations: 1,
        maxLlmCalls: 2,
      },
    );

    const worker = createCloudflareWorker({
      project: so.project({
        programs: [failingRlm],
      }),
    });

    const response = await worker.fetch(
      new Request("https://example.com/kernel/rlm/failing_longcot_probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt: "Return solution = 4",
          },
        }),
      }),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      ok: boolean;
      error: string;
      traceId?: string;
    };
    expect(payload.ok).toBe(false);
    expect(typeof payload.traceId).toBe("string");
    expect(payload.error).toContain("response_text");

    const traceResponse = await worker.fetch(
      new Request(`https://example.com/kernel/traces/${encodeURIComponent(payload.traceId ?? "")}`),
    );
    expect(traceResponse.status).toBe(200);

    const tracePayload = (await traceResponse.json()) as {
      ok: boolean;
      trace: {
        targetId: string;
        targetKind: string;
        error?: {
          message: string;
        };
        programmable?: {
          mode: string;
          steps: Array<{
            submitted?: unknown;
            submitValidationError?: {
              message: string;
            };
          }>;
        };
      };
    };

    expect(tracePayload.ok).toBe(true);
    expect(tracePayload.trace.targetId).toBe("failing_longcot_probe");
    expect(tracePayload.trace.targetKind).toBe("rlm");
    expect(tracePayload.trace.error?.message).toContain("response_text");
    expect(tracePayload.trace.programmable?.mode).toBe("rlm");
    expect(tracePayload.trace.programmable?.steps).toHaveLength(1);
    expect(tracePayload.trace.programmable?.steps[0]?.submitted).toEqual({
      answer: "wrong shape",
    });
    expect(tracePayload.trace.programmable?.steps[0]?.submitValidationError?.message).toContain(
      "response_text",
    );
  });
});
