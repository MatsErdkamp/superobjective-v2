import type { CompiledArtifact, Example, Metric, Optimizer } from "./types.js";

export async function compile<TTarget>(
  target: TTarget,
  args: {
    optimizer: Optimizer<TTarget>;
    trainset: Example<any, any>[];
    valset?: Example<any, any>[];
    metric: Metric<any, any, any>;
    objective: string;
    background?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<CompiledArtifact> {
  return args.optimizer.compile({
    target,
    trainset: args.trainset,
    ...(args.valset ? { valset: args.valset } : {}),
    metric: args.metric,
    objective: args.objective,
    ...(args.background ? { background: args.background } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  });
}
