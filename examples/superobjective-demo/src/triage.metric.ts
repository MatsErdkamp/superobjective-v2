import { so } from "superobjective";

import type { TriageInput, TriageOutput } from "./triage";

export const triageQuality = so.metric<TriageInput, TriageOutput, TriageOutput>({
  name: "triage_quality",
  evaluate(ctx) {
    const prediction = ctx.prediction;
    const expected = ctx.expected;
    const checks = [
      prediction.category === expected.category,
      prediction.priority === expected.priority,
      prediction.needsHuman === expected.needsHuman,
    ];
    const score = checks.filter(Boolean).length / checks.length;

    if (score === 1) {
      return {
        score,
        feedback: "Prediction matched the expected triage output.",
      };
    }

    const mismatches = [
      prediction.category !== expected.category
        ? `category=${prediction.category} expected ${expected.category}`
        : null,
      prediction.priority !== expected.priority
        ? `priority=${prediction.priority} expected ${expected.priority}`
        : null,
      prediction.needsHuman !== expected.needsHuman
        ? `needsHuman=${String(prediction.needsHuman)} expected ${String(expected.needsHuman)}`
        : null,
    ].filter((value): value is string => value != null);

    return {
      score,
      feedback: `Triage mismatches: ${mismatches.join("; ")}`,
    };
  },
});
