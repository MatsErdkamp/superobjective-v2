import { describe, expect, it } from "vite-plus/test";

import { so } from "superobjective";

import { traceProbeFlow } from "../apps/cloudflare-worker/src/trace-probe";
import { mockModel } from "./support/mock-model";

describe("trace probe flow", () => {
  it("records three predict calls inside one program trace", async () => {
    const traceStore = so.stores.memory();
    const artifactStore = so.stores.memory();

    so.configure({
      model: mockModel([
        {
          queue: "billing",
          intent: "refund",
          customerTone: "frustrated",
        },
        {
          severity: "high",
          escalationReason: "financial-risk",
          needsHuman: true,
        },
        {
          operatorSummary: "Refund request is delayed and should be handled by the billing team.",
          nextAction: "Escalate to a billing specialist and verify the refund ledger entry.",
          customerReply:
            "I am escalating this to our billing team now and will follow up with an update.",
        },
      ]),
      traceStore,
      artifactStore,
    });

    const result = await traceProbeFlow({
      subject: "Refund still missing",
      body: "My refund still has not landed and I need confirmation that someone is checking it today.",
    });

    expect(result.traceSummary.expectedModelCalls).toBe(3);
    expect(result.traceSummary.expectedToolCalls).toBe(3);
    expect(result.traceSummary.observedModelCalls).toBe(3);
    expect(result.traceSummary.observedToolCalls).toBe(3);
    expect(result.traceSummary.observedComponentCount).toBe(4);
    expect(result.toolResults.email.queued).toBe(true);

    const traces = await traceStore.listTraces?.({
      targetKind: "program",
      targetId: "trace_probe_flow",
    });

    expect(traces).toHaveLength(1);
    expect(traces?.[0]?.modelCalls).toHaveLength(3);
    expect(traces?.[0]?.toolCalls).toHaveLength(3);
    expect(traces?.[0]?.components.map((component) => component.componentId)).toEqual([
      "trace_probe_flow",
      "trace_probe_intake",
      "trace_probe_risk",
      "trace_probe_resolution",
    ]);
  });
});
