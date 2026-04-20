import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { so } from "superobjective";

import { mockModel } from "./support/mock-model";

describe("predict()", () => {
  it("runs a predict module end-to-end and returns typed output", async () => {
    const traceStore = so.stores.memory();
    const artifactStore = so.stores.memory();

    so.configure({
      model: mockModel([
        {
          category: "billing",
          priority: "high",
          needsHuman: false,
        },
      ]),
      traceStore,
      artifactStore,
    });

    const TriageTicket = so.signature({
      name: "triage_ticket_predict_test",
      instructions: so.text({
        value: "Classify a support ticket for routing.",
        optimize: true,
      }),
      input: {
        subject: so.input(z.string(), {
          description: so.text({
            value: "The support ticket subject line.",
            optimize: true,
          }),
        }),
        body: so.input(z.string(), {
          description: so.text({
            value: "The customer-written support request body.",
            optimize: true,
          }),
        }),
      },
      output: {
        category: so.output(z.enum(["billing", "technical", "other"]), {
          description: so.text({
            value: "The queue that should handle the request.",
            optimize: true,
          }),
        }),
        priority: so.output(z.enum(["low", "medium", "high"]), {
          description: so.text({
            value: "Urgency based on impact and time sensitivity.",
            optimize: true,
          }),
        }),
        needsHuman: so.output(z.boolean(), {
          description: so.text({
            value: "Whether this request requires a human agent.",
            optimize: true,
          }),
        }),
      },
    });

    const triageTicket = so.predict<
      {
        subject: string;
        body: string;
      },
      {
        category: "billing" | "technical" | "other";
        priority: "low" | "medium" | "high";
        needsHuman: boolean;
      }
    >(TriageTicket, {
      adapter: so.adapters.xml(),
    });

    const result = await triageTicket({
      subject: "Refund not received",
      body: "I returned my order two weeks ago and still have not received the refund.",
    });

    expect(result).toEqual({
      category: "billing",
      priority: "high",
      needsHuman: false,
    });

    const traces = await traceStore.listTraces?.({
      targetKind: "predict",
      targetId: "triage_ticket_predict_test",
    });

    expect(traces).toHaveLength(1);
    expect(traces?.[0]?.components[0]?.componentKind).toBe("predict");
    expect(traces?.[0]?.modelCalls[0]?.outputJsonSchema).toBeTruthy();
  });
});
