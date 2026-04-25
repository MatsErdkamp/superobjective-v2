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

    const TriageTicket = so
      .signature("triage_ticket_predict_test")
      .withInstructions("Classify a support ticket for routing.", {
        optimize: true,
      })
      .withInput("subject", z.string(), {
        description: "The support ticket subject line.",
        optimize: true,
      })
      .withInput("body", z.string(), {
        description: "The customer-written support request body.",
        optimize: true,
      })
      .withOutput("category", z.enum(["billing", "technical", "other"]), {
        description: "The queue that should handle the request.",
        optimize: true,
      })
      .withOutput("priority", z.enum(["low", "medium", "high"]), {
        description: "Urgency based on impact and time sensitivity.",
        optimize: true,
      })
      .withOutput("needsHuman", z.boolean(), {
        description: "Whether this request requires a human agent.",
        optimize: true,
      })
      .build();

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

  it("returns output and trace from runWithTrace", async () => {
    so.configure({
      model: mockModel([
        {
          answer: "ok",
        },
      ]),
      traceStore: so.stores.memory(),
      artifactStore: so.stores.memory(),
    });

    const Answer = so
      .signature("answer_with_trace")
      .withInstructions("Answer briefly.")
      .withOutput("answer", z.string(), {
        description: "The answer.",
      })
      .build();

    const answer = so.predict<Record<string, never>, { answer: string }>(Answer);
    const result = await answer.runWithTrace({});

    expect(result.output).toEqual({
      answer: "ok",
    });
    expect(result.trace.targetKind).toBe("predict");
    expect(result.trace.output).toEqual(result.output);
    expect(result.trace.components[0]?.spanId).toBeTruthy();
    expect(result.trace.modelCalls[0]?.spanId).toBeTruthy();
    expect(result.trace.modelCalls[0]?.parentSpanId).toBe(result.trace.components[0]?.spanId);
  });

  it("parses XML fallback booleans as booleans and escapes output field names", async () => {
    so.configure({
      model: {
        id: "xml-fallback-model",
        async structured() {
          throw new Error("structured generation unavailable");
        },
        async complete() {
          return {
            text: "<needsXhuman>false</needsXhuman>\n<needs.human>true</needs.human>",
          };
        },
      },
      traceStore: so.stores.memory(),
      artifactStore: so.stores.memory(),
    });

    const CheckEscapedField = so
      .signature("check_escaped_field")
      .withInstructions("Return whether the case needs a human.")
      .withOutput("needs.human", z.boolean(), {
        description: "Whether this case needs a human.",
      })
      .build();

    const checkEscapedField = so.predict<Record<string, never>, { "needs.human": boolean }>(
      CheckEscapedField,
      {
        adapter: so.adapters.xml(),
      },
    );

    const result = await checkEscapedField({});

    expect(result).toEqual({
      "needs.human": true,
    });
    expect(typeof result["needs.human"]).toBe("boolean");
  });
});
