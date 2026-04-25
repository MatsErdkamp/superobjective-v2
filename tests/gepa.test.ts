import { describe, expect, it } from "vite-plus/test";

import {
  GepaBudgetExceededError,
  MetricBudget,
  gepa,
  type GepaCompileArgs,
  type GepaTargetLike,
  type RunTraceLike,
  type TextCandidate,
} from "@superobjective/optimizer-gepa";

type Input = {
  subject: string;
};

type Output = {
  category: "billing" | "other";
};

describe("GEPA optimizer", () => {
  it("prefers candidate-bound runWithTrace during default evaluation", async () => {
    let directCalls = 0;
    let tracedCalls = 0;

    const buildTarget = (
      candidate: TextCandidate = {
        "demo.instructions": "Route by generic intent.",
      },
    ): GepaTargetLike<Input, Output> =>
      Object.assign(
        async () => {
          directCalls += 1;
          return {
            category: "other" as const,
          };
        },
        {
          kind: "predict" as const,
          id: "traceable_demo",
          inspectTextCandidate() {
            return candidate;
          },
          withCandidate(nextCandidate: TextCandidate) {
            return buildTarget(nextCandidate);
          },
          async runWithTrace(input: Input) {
            tracedCalls += 1;
            const output = {
              category: candidate["demo.instructions"]?.includes("billing")
                ? ("billing" as const)
                : ("other" as const),
            };

            return {
              output,
              trace: createTrace({
                targetId: "traceable_demo",
                input,
                output,
                metadata: {
                  source: "runWithTrace",
                },
              }),
            };
          },
        },
      );

    const artifact = await gepa({
      maxMetricCalls: 1,
      reflectionBatchSize: 1,
    }).compile({
      target: buildTarget({
        "demo.instructions": "Route billing requests to billing.",
      }),
      trainset: [
        {
          input: { subject: "Refund not received" },
          expected: { category: "billing" as const },
        },
      ],
      metric: {
        name: "trace_source",
        evaluate(ctx) {
          expect(ctx.trace.metadata?.source).toBe("runWithTrace");
          expect(ctx.target?.componentId).toBe("traceable_demo");
          return {
            score: ctx.prediction.category === ctx.expected.category ? 1 : 0,
          };
        },
      },
      objective: "Improve category accuracy.",
    });

    expect(artifact.optimizer.id).toBe("gepa");
    expect(directCalls).toBe(0);
    expect(tracedCalls).toBe(1);
  });

  it("keeps seed, candidate, final, and validation evaluation within the metric budget", async () => {
    let metricCalls = 0;

    const artifact = await gepa({
      maxMetricCalls: 2,
      reflectionBatchSize: 1,
      reflectionModel: {
        async generatePatch() {
          return {
            candidatePatch: {
              "demo.instructions": "Route refund and invoice requests to billing.",
            },
            rationale: "Make the billing routing instruction explicit.",
          };
        },
      },
    }).compile<Input, Output, Output>({
      sourceJobId: "job_gepa_budget_1",
      target: buildSyntheticTarget(),
      trainset: [
        {
          input: { subject: "Refund not received" },
          expected: { category: "billing" as const },
        },
      ],
      valset: [
        {
          input: { subject: "Invoice question" },
          expected: { category: "billing" as const },
        },
      ],
      metric: {
        name: "category_accuracy",
        evaluate(ctx) {
          metricCalls += 1;
          return {
            score: ctx.prediction.category === ctx.expected.category ? 1 : 0,
            feedback: ctx.prediction.category === ctx.expected.category ? "Correct." : "Wrong.",
          };
        },
      },
      objective: "Improve category accuracy.",
    } as GepaCompileArgs<Input, Output, Output> & { sourceJobId: string });

    const metricBudget = (artifact.metadata?.budget as
      | { metric?: Record<string, unknown> }
      | undefined)?.metric;

    expect(metricCalls).toBe(2);
    expect(artifact.metadata?.sourceJobId).toBe("job_gepa_budget_1");
    expect(artifact.metadata?.metricCallsUsed).toBe(2);
    expect(artifact.metadata?.validationSkippedForBudget).toBe(true);
    expect(metricBudget?.maxMetricCalls).toBe(2);
    expect(metricBudget?.usedMetricCalls).toBe(2);
    expect(metricBudget?.remainingMetricCalls).toBe(0);
    expect(metricBudget?.phaseUsage).toEqual({
      seed: 1,
      candidate: 1,
    });
  });

  it("rejects unknown candidate paths and non-string values during patch validation", () => {
    const optimizer = gepa({
      mutation: {
        allowNewPaths: true,
      },
    });

    const result = optimizer.validatePatch({
      currentCandidate: {
        "demo.instructions": "Route by generic intent.",
      },
      candidatePatch: {
        "demo.unknown": "New path.",
        "demo.instructions": 42,
      } as unknown as Partial<TextCandidate>,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unknown_path",
      "non_string_value",
      "empty_patch",
    ]);
  });

  it("throws GepaBudgetExceededError when a metric budget is over-consumed", () => {
    const budget = new MetricBudget(1);
    budget.consume({ phase: "seed" });

    expect(() => budget.consume({ phase: "final" })).toThrow(GepaBudgetExceededError);
  });
});

function buildSyntheticTarget(
  candidate: TextCandidate = {
    "demo.instructions": "Route by generic intent.",
  },
): GepaTargetLike<Input, Output> {
  return Object.assign(
    async () =>
      ({
        category: candidate["demo.instructions"]?.includes("billing") ? "billing" : "other",
      }) satisfies Output,
    {
      kind: "predict" as const,
      id: "synthetic_demo",
      inspectTextCandidate() {
        return candidate;
      },
      withCandidate(nextCandidate: TextCandidate) {
        return buildSyntheticTarget(nextCandidate);
      },
    },
  );
}

function createTrace(args: {
  targetId: string;
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown>;
}): RunTraceLike {
  const timestamp = new Date().toISOString();

  return {
    runId: `trace_${args.targetId}`,
    targetId: args.targetId,
    targetKind: "predict",
    startedAt: timestamp,
    endedAt: timestamp,
    input: args.input,
    output: args.output,
    stdout: "",
    components: [
      {
        componentId: args.targetId,
        componentKind: "predict",
        startedAt: timestamp,
        endedAt: timestamp,
        input: args.input,
        output: args.output,
        stdout: "",
      },
    ],
    modelCalls: [],
    toolCalls: [],
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
}
