import { describe, expect, it } from "vite-plus/test";

import { standardPIIRedactor, type RunTrace } from "superobjective";

describe("trace redactors", () => {
  it("preserves structural ids while redacting sensitive payload text", () => {
    const trace: RunTrace = {
      runId: "run_4111111111111111",
      targetId: "target_555-123-4567",
      targetKind: "rlm",
      startedAt: "2026-04-22T00:00:00.000Z",
      input: {
        traceId: "trace_4242 4242 4242 4242",
        customerPhone: "+1 555-123-4567",
      },
      output: {
        answer: "Call me at +1 555-123-4567",
      },
      stdout: "credit card 4111 1111 1111 1111",
      components: [
        {
          componentId: "solver",
          componentKind: "rlm",
          startedAt: "2026-04-22T00:00:00.000Z",
          input: {
            traceId: "trace_4242 4242 4242 4242",
          },
          stdout: "phone +1 555-123-4567",
        },
      ],
      modelCalls: [],
      toolCalls: [
        {
          toolName: "lookup",
          input: {
            traceId: "trace_4242 4242 4242 4242",
          },
          metadata: {
            traceId: "trace_4242 4242 4242 4242",
            note: "customer card 4111 1111 1111 1111",
          },
        },
      ],
      metadata: {
        traceId: "trace_4242 4242 4242 4242",
        note: "phone +1 555-123-4567",
      },
    };

    const redacted = standardPIIRedactor().redactTrace(trace);

    expect(redacted.runId).toBe("run_4111111111111111");
    expect(redacted.targetId).toBe("target_555-123-4567");
    expect((redacted.input as { traceId: string }).traceId).toBe("trace_4242 4242 4242 4242");
    expect((redacted.metadata as { traceId: string }).traceId).toBe(
      "trace_4242 4242 4242 4242",
    );
    expect(
      (
        redacted.toolCalls[0]?.metadata as {
          traceId: string;
        }
      ).traceId,
    ).toBe("trace_4242 4242 4242 4242");

    expect((redacted.output as { answer: string }).answer).toContain("[redacted-phone]");
    expect(redacted.stdout).toContain("[redacted-card]");
    expect(
      (
        redacted.toolCalls[0]?.metadata as {
          note: string;
        }
      ).note,
    ).toContain("[redacted-card]");
    expect((redacted.metadata as { note: string }).note).toContain("[redacted-phone]");
  });
});
