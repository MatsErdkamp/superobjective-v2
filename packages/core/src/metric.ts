import type { Metric } from "./types.js";

export function metric<TInput, TPrediction, TExpected>(
  value: Metric<TInput, TPrediction, TExpected>,
): Metric<TInput, TPrediction, TExpected> {
  return value;
}
