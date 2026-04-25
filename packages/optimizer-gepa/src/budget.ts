export type MetricBudgetPhase = "seed" | "reflection" | "candidate" | "validation" | "final";

export type MetricBudgetSnapshot = {
  maxMetricCalls: number;
  usedMetricCalls: number;
  remainingMetricCalls: number;
  exhausted: boolean;
  phaseUsage: Partial<Record<MetricBudgetPhase, number>>;
};

export class GepaBudgetExceededError extends Error {
  readonly name = "GepaBudgetExceededError";
  readonly maxMetricCalls: number;
  readonly usedMetricCalls: number;
  readonly requestedMetricCalls: number;
  readonly phase?: MetricBudgetPhase;

  constructor(args: {
    maxMetricCalls: number;
    usedMetricCalls: number;
    requestedMetricCalls: number;
    phase?: MetricBudgetPhase;
  }) {
    const remainingMetricCalls = Math.max(0, args.maxMetricCalls - args.usedMetricCalls);
    super(
      `GEPA metric budget exceeded: requested ${args.requestedMetricCalls} metric call(s) with ${remainingMetricCalls} remaining.`,
    );
    this.maxMetricCalls = args.maxMetricCalls;
    this.usedMetricCalls = args.usedMetricCalls;
    this.requestedMetricCalls = args.requestedMetricCalls;
    if (args.phase) {
      this.phase = args.phase;
    }
  }
}

export class MetricBudget {
  readonly maxMetricCalls: number;
  private usedMetricCallsValue = 0;
  private readonly phaseUsageValue: Partial<Record<MetricBudgetPhase, number>> = {};

  constructor(maxMetricCalls: number) {
    if (!Number.isFinite(maxMetricCalls) || maxMetricCalls <= 0) {
      throw new RangeError("GEPA metric budget must be a finite number greater than 0.");
    }

    this.maxMetricCalls = Math.floor(maxMetricCalls);
  }

  get usedMetricCalls(): number {
    return this.usedMetricCallsValue;
  }

  get remainingMetricCalls(): number {
    return Math.max(0, this.maxMetricCalls - this.usedMetricCallsValue);
  }

  get exhausted(): boolean {
    return this.remainingMetricCalls === 0;
  }

  canConsume(metricCalls = 1): boolean {
    return this.normalizeMetricCalls(metricCalls) <= this.remainingMetricCalls;
  }

  consume(args?: { metricCalls?: number; phase?: MetricBudgetPhase }): void {
    const metricCalls = this.normalizeMetricCalls(args?.metricCalls ?? 1);
    if (metricCalls > this.remainingMetricCalls) {
      throw new GepaBudgetExceededError({
        maxMetricCalls: this.maxMetricCalls,
        usedMetricCalls: this.usedMetricCallsValue,
        requestedMetricCalls: metricCalls,
        ...(args?.phase ? { phase: args.phase } : {}),
      });
    }

    this.usedMetricCallsValue += metricCalls;
    if (args?.phase) {
      this.phaseUsageValue[args.phase] = (this.phaseUsageValue[args.phase] ?? 0) + metricCalls;
    }
  }

  snapshot(): MetricBudgetSnapshot {
    return {
      maxMetricCalls: this.maxMetricCalls,
      usedMetricCalls: this.usedMetricCallsValue,
      remainingMetricCalls: this.remainingMetricCalls,
      exhausted: this.exhausted,
      phaseUsage: { ...this.phaseUsageValue },
    };
  }

  private normalizeMetricCalls(metricCalls: number): number {
    if (!Number.isFinite(metricCalls) || metricCalls <= 0) {
      throw new RangeError("GEPA metric budget consumption must be a finite number greater than 0.");
    }

    return Math.floor(metricCalls);
  }
}
