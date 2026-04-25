import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createCloudflareWorker, cloudflare, type ProjectLike } from "@superobjective/cloudflare";
import { so } from "superobjective";

import { mockModel } from "./support/mock-model";

function createTriageModule() {
  const signature = so
    .signature("triage_ticket")
    .withInstructions("Classify a support ticket.", {
      optimize: true,
    })
    .withInput("subject", z.string(), {
      description: "The support ticket subject line.",
      optimize: true,
    })
    .withOutput("category", z.enum(["billing", "other"]), {
      description: "The destination support queue.",
      optimize: true,
    })
    .build();

  return so.predict<{ subject: string }, { category: "billing" | "other" }>(signature, {
    adapter: so.adapters.xml(),
  });
}

describe("superobjective prototype", () => {
  it("renders candidate-aware prompts and schemas", async () => {
    const triage = createTriageModule().withCandidate({
      "triage_ticket.output.category.description":
        "Use the billing queue for refunds, charges, invoices, and subscriptions.",
    });

    const inspection = await triage.inspectPrompt({
      subject: "Refund not received",
    });

    expect(inspection.messages[0]?.content).toContain("billing queue for refunds");
    expect(
      (
        inspection.output.jsonSchema as {
          properties?: Record<string, { description?: string }>;
        }
      ).properties?.category?.description,
    ).toContain("billing queue for refunds");
  });

  it("executes a predict module and records traces", async () => {
    const store = so.stores.memory();
    const model = mockModel([
      {
        category: "billing",
      },
    ]);

    so.configure({
      model,
      traceStore: store,
      artifactStore: store,
    });

    const triage = createTriageModule();
    const result = await triage({
      subject: "Refund not received",
    });

    expect(result.category).toBe("billing");

    const traces = await store.listTraces?.({
      targetKind: "predict",
      targetId: "triage_ticket",
    });

    expect(traces?.length).toBe(1);
    expect(traces?.[0]?.modelCalls).toHaveLength(1);
    expect(traces?.[0]?.components[0]?.prompt?.messages[0]?.content).toContain("<task>");
  });

  it("supports the lazy GEPA convenience wrapper on so.optimizers", async () => {
    type Input = { subject: string };
    type Output = { category: "billing" | "other" };

    const buildTarget = (
      candidate: Record<string, string> = {
        "demo.instructions": "Route by generic intent.",
      },
    ) =>
      Object.assign(
        async (_input: Input) =>
          ({
            category: candidate["demo.instructions"]?.includes("refund") ? "billing" : "other",
          }) satisfies Output,
        {
          kind: "predict" as const,
          id: "demo_target",
          inspectTextCandidate() {
            return candidate;
          },
          withCandidate(nextCandidate: Record<string, string>) {
            return buildTarget(nextCandidate);
          },
          adapter: {
            id: "xml",
            version: "0.1.0",
          },
        },
      );

    const target = buildTarget();
    const optimizer = so.optimizers.gepa({
      maxMetricCalls: 2,
      reflectionBatchSize: 1,
      reflectionModel: {
        async generatePatch() {
          return {
            candidatePatch: {
              "demo.instructions": "Route refund and invoice requests to billing.",
            },
            rationale: "Make the routing instruction explicit.",
          };
        },
      },
    });

    const artifact = await so.compile(target, {
      optimizer,
      trainset: [
        {
          input: { subject: "Refund not received" },
          expected: { category: "billing" as const },
        },
      ],
      metric: so.metric({
        name: "category_accuracy",
        evaluate(ctx) {
          const correct = ctx.prediction.category === ctx.expected.category;
          return {
            score: correct ? 1 : 0,
            feedback: correct ? "Correct." : "Wrong category.",
          };
        },
      }),
      objective: "Improve category accuracy.",
    });

    expect(artifact.textCandidate["demo.instructions"]).toContain("billing");
    expect(artifact.optimizer.id).toBe("gepa");
  });

  it("passes real execution traces to GEPA metrics by default", async () => {
    so.configure({
      model: mockModel([
        { category: "billing" },
        { category: "billing" },
      ]),
      traceStore: so.stores.memory(),
      artifactStore: so.stores.memory(),
    });

    const triage = createTriageModule();
    const metricTraces: Array<{
      componentCount: number;
      modelCallCount: number;
      targetComponentId?: string;
      optimizer?: unknown;
    }> = [];

    const artifact = await so.compile(triage, {
      optimizer: so.optimizers.gepa({
        maxMetricCalls: 1,
        reflectionBatchSize: 1,
      }),
      trainset: [
        {
          input: { subject: "Refund not received" },
          expected: { category: "billing" as const },
        },
      ],
      metric: so.metric({
        name: "trace_presence",
        evaluate(ctx) {
          metricTraces.push({
            componentCount: ctx.trace.components.length,
            modelCallCount: ctx.trace.modelCalls.length,
            ...(ctx.target ? { targetComponentId: ctx.target.componentId } : {}),
            optimizer: ctx.trace.metadata?.optimizer,
          });

          return {
            score: ctx.prediction.category === ctx.expected.category ? 1 : 0,
          };
        },
      }),
      objective: "Improve category accuracy.",
    });

    expect(artifact.optimizer.id).toBe("gepa");
    expect(metricTraces.length).toBeGreaterThan(0);
    expect(metricTraces.every((trace) => trace.componentCount > 0)).toBe(true);
    expect(metricTraces.every((trace) => trace.modelCallCount > 0)).toBe(true);
    expect(metricTraces.every((trace) => trace.targetComponentId === "triage_ticket")).toBe(true);
    expect(metricTraces.every((trace) => trace.optimizer === "gepa")).toBe(true);
  });

  it("only exposes optimizable tool and agent text candidates", () => {
    const chat = so.program({
      name: "candidate_empty_chat",
      input: z.object({}),
      output: z.object({}),
      async run() {
        return {};
      },
    });

    const hiddenTool = so.tool({
      name: "hidden_lookup",
      description: so.text("Do not optimize this tool description."),
      input: z.object({}),
      output: z.object({}),
      async execute() {
        return {};
      },
    });
    const visibleTool = so.tool({
      name: "visible_lookup",
      description: so.text({
        value: "Optimize this tool description.",
        optimize: true,
      }),
      input: z.object({}),
      output: z.object({}),
      async execute() {
        return {};
      },
    });
    const agent = so.agent({
      name: "candidate_agent",
      system: so.text("Do not optimize this agent system prompt."),
      chat,
      tools: [hiddenTool, visibleTool],
    });

    expect(hiddenTool.inspectTextCandidate()).toEqual({});
    expect(visibleTool.inspectTextCandidate()).toEqual({
      "tool.visible_lookup.description": "Optimize this tool description.",
    });
    expect(agent.inspectTextCandidate()).toEqual({
      "tool.visible_lookup.description": "Optimize this tool description.",
    });
  });

  it("exposes optimizable agent system text candidates", () => {
    const chat = so.program({
      name: "candidate_visible_system_chat",
      input: z.object({}),
      output: z.object({}),
      async run() {
        return {};
      },
    });
    const agent = so.agent({
      name: "visible_system_agent",
      system: so.text({
        value: "Optimize this agent system prompt.",
        optimize: true,
      }),
      chat,
    });

    expect(agent.inspectTextCandidate()).toEqual({
      "agent.visible_system_agent.system": "Optimize this agent system prompt.",
    });
  });

  it("normalizes non-optimizable text without optimize:false leaks", () => {
    expect(so.text("Hidden text")).toEqual({
      value: "Hidden text",
    });
    expect(
      so.optimizableTextAt("demo.hidden", {
        value: "Hidden text",
        optimize: false,
      }),
    ).toEqual({});
    expect(
      so.optimizableTextAt("demo.visible", {
        value: "Visible text",
        optimize: true,
      }),
    ).toEqual({
      "demo.visible": "Visible text",
    });

    const direct = so.signature({
      name: "normalizes_direct_signature_text",
      instructions: {
        value: "Do not optimize this instruction.",
        optimize: false,
      },
      input: {},
      output: {
        answer: so.output(z.string(), {
          description: {
            value: "Do not optimize this output.",
            optimize: false,
          },
        }),
      },
    });

    expect(direct.instructions).toEqual({
      value: "Do not optimize this instruction.",
    });
    expect(direct.output.answer.description).toEqual({
      value: "Do not optimize this output.",
    });
    expect(so.extractSignatureTextCandidate(direct)).toEqual({});
  });

  it("registers program children and returns topology aliases in traces", async () => {
    const child = so.program({
      name: "registered_child_program",
      input: z.object({
        value: z.string(),
      }),
      output: z.object({
        value: z.string(),
      }),
      async run(_ctx, input) {
        return input;
      },
    });
    const parent = so.program({
      name: "registered_parent_program",
      input: z.object({
        value: z.string(),
      }),
      output: z.object({
        value: z.string(),
      }),
      async run(ctx, input) {
        return ctx.call(child, input);
      },
    });

    expect(parent.children()).toEqual([]);

    const result = await parent.runWithTrace({
      value: "ok",
    });

    expect(result.output).toEqual({
      value: "ok",
    });
    expect(parent.children()).toEqual([
      {
        kind: "program",
        id: "registered_child_program",
        name: "registered_child_program",
      },
    ]);

    const [parentSpan, childSpan] = result.trace.components;
    expect(parentSpan?.componentId).toBe("registered_parent_program");
    expect(childSpan?.componentId).toBe("registered_child_program");
    expect(parentSpan?.spanId).toBeTruthy();
    expect(childSpan?.parentSpanId).toBe(parentSpan?.spanId);
  });

  it("supports explicit program modules for ctx.modules and candidate inspection", async () => {
    const child = createTriageModule();
    const flow = so.program({
      name: "explicit_module_flow",
      modules: {
        triageTicket: child,
      },
      input: z.object({
        subject: z.string(),
      }),
      output: z.object({
        category: z.enum(["billing", "other"]),
      }),
      async run(ctx, input) {
        return ctx.call(ctx.modules.triageTicket!, input);
      },
    });

    expect(flow.children()).toEqual([
      {
        kind: "predict",
        id: "triage_ticket",
        name: "triage_ticket",
      },
    ]);
    expect(flow.inspectTextCandidate()).toHaveProperty("triage_ticket.instructions");

    const optimized = flow.withCandidate({
      "triage_ticket.instructions": "Route refunds to billing.",
    });

    expect(optimized.inspectTextCandidate()["triage_ticket.instructions"]).toBe(
      "Route refunds to billing.",
    );
  });

  it("serves RPC handlers through the Cloudflare worker surface", async () => {
    const triage = createTriageModule();
    const traceStore = cloudflare.prototypeTraceStore();
    const artifactStore = cloudflare.prototypeArtifactStore();
    const model = mockModel([
      {
        category: "billing",
      },
    ]);

    const worker = createCloudflareWorker({
      project: so.project({
        programs: [triage],
        rpc: [
          so.rpc({
            name: "support_rpc",
            handlers: {
              triageTicket: triage,
            },
          }),
        ],
      }) as ProjectLike,
      runtime: {
        model,
        traceStore,
        artifactStore,
      },
    });

    const response = await worker.fetch(
      new Request("https://example.com/rpc/support_rpc/triageTicket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject: "Refund not received",
        }),
      }),
      {},
      {
        waitUntil() {
          return undefined;
        },
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        category: string;
      };
      traceId: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.category).toBe("billing");

    const traces = await traceStore.listTraces?.({
      targetKind: "rpc",
      targetId: "support_rpc.triageTicket",
    });

    expect(traces?.[0]?.output).toEqual({
      category: "billing",
    });
  });

  it("prefers the kernel durable object when SO_KERNEL is bound", async () => {
    const worker = createCloudflareWorker({
      project: so.project({
        programs: [createTriageModule()],
      }) as ProjectLike,
    });

    const forwardedPaths: string[] = [];
    const env = {
      SO_KERNEL: {
        getByName(name: string) {
          expect(name).toBe("default");
          return {
            async fetch(request: Request) {
              forwardedPaths.push(new URL(request.url).pathname);
              return new Response(JSON.stringify({ ok: true, delegated: true }), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              });
            },
          };
        },
      },
    };

    const response = await worker.fetch(
      new Request("https://example.com/kernel/traces/run_demo"),
      env,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      delegated: boolean;
    };

    expect(payload.ok).toBe(true);
    expect(payload.delegated).toBe(true);
    expect(forwardedPaths).toEqual(["/kernel/traces/run_demo"]);
  });
});
