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
