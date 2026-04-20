import {
  applyCandidatePatch,
  buildAllowedCandidatePaths,
  extractTextCandidate,
  hashTextCandidate,
} from "./candidate.js";
import { GEPA_VERSION, resolveGepaConfig } from "./defaults.js";
import { evaluateCandidate, selectReflectionExamples } from "./evaluate.js";
import { validateCandidatePatch } from "./patch.js";
import type {
  CandidateEvaluation,
  CompiledArtifactLike,
  FrontierSnapshot,
  GepaCompileArgs,
  GepaConfig,
  GepaOptimizerLike,
  ReflectionExample,
  ResolvedGepaConfig,
  TextCandidate,
} from "./types.js";
import { assertNotAborted, newArtifactId, nowIso, sha256, stableStringify } from "./utils.js";

type FrontierNode<TInput, TPrediction, TExpected> = {
  id: string;
  parentId?: string;
  candidate: TextCandidate;
  evaluation: CandidateEvaluation<TInput, TPrediction, TExpected>;
  rationale?: string;
  feedbackSummary?: string;
};

export class GepaOptimizer implements GepaOptimizerLike {
  readonly id = "gepa";
  readonly version = GEPA_VERSION;
  readonly config: ResolvedGepaConfig;

  constructor(config?: GepaConfig) {
    this.config = resolveGepaConfig(config);
  }

  extractTextCandidate(target: Parameters<typeof extractTextCandidate>[0]): TextCandidate {
    return extractTextCandidate(target);
  }

  validatePatch(args: { currentCandidate: TextCandidate; candidatePatch: Partial<TextCandidate> }) {
    return validateCandidatePatch({
      ...args,
      config: this.config,
    });
  }

  async compile<TInput, TPrediction, TExpected>(
    args: GepaCompileArgs<TInput, TPrediction, TExpected>,
  ): Promise<CompiledArtifactLike> {
    assertNotAborted(args.signal);

    if (args.trainset.length === 0) {
      throw new RangeError("GEPA compile requires at least one training example.");
    }

    const activeReflectionModel = args.reflectionModel ?? this.config.reflectionModel;
    const seedCandidate = extractTextCandidate(args.target);
    const nodes = new Map<string, FrontierNode<TInput, TPrediction, TExpected>>();
    const expandedNodes = new Set<string>();
    let consecutiveRejectedMutations = 0;
    let metricCallsUsed = 0;
    let batchCursor = 0;

    const seedBatch = selectEvaluationBatch(
      args.trainset,
      batchCursor,
      this.config.reflectionBatchSize,
    );
    batchCursor = advanceCursor(batchCursor, seedBatch.length, args.trainset.length);

    const seedEvaluation = await evaluateCandidate({
      target: args.target,
      candidate: seedCandidate,
      examples: seedBatch,
      metric: args.metric,
      dataset: "train",
      config: this.config,
      ...(args.execute ? { execute: args.execute } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    metricCallsUsed += seedBatch.length;

    const seedNode: FrontierNode<TInput, TPrediction, TExpected> = {
      id: seedEvaluation.candidateId,
      candidate: seedCandidate,
      evaluation: seedEvaluation,
      ...(seedEvaluation.feedbackSummary
        ? { feedbackSummary: seedEvaluation.feedbackSummary }
        : {}),
    };
    nodes.set(seedNode.id, seedNode);

    while (metricCallsUsed < this.config.maxMetricCalls) {
      assertNotAborted(args.signal);

      const baseNode = selectBaseNode(nodes, expandedNodes, this.config);
      if (!baseNode) {
        break;
      }

      expandedNodes.add(baseNode.id);

      const reflectionExamples = selectReflectionExamples(baseNode.evaluation, this.config);
      if (reflectionExamples.length === 0) {
        if (!hasUnexpandedNodes(nodes, expandedNodes)) {
          break;
        }

        continue;
      }

      if (!activeReflectionModel) {
        break;
      }

      const reflectionResult = await activeReflectionModel.generatePatch({
        objective: args.objective,
        ...(args.background ? { background: args.background } : {}),
        currentCandidate: baseNode.candidate,
        allowedPaths: buildAllowedCandidatePaths(baseNode.candidate),
        examples: reflectionExamples.map((example) => toReflectionExample(example)),
      });

      const patchValidation = validateCandidatePatch({
        currentCandidate: baseNode.candidate,
        candidatePatch: reflectionResult.candidatePatch,
        config: this.config,
        allowedPaths: buildAllowedCandidatePaths(baseNode.candidate),
      });

      if (!patchValidation.ok) {
        consecutiveRejectedMutations += 1;
        if (consecutiveRejectedMutations >= 3) {
          break;
        }
        continue;
      }

      consecutiveRejectedMutations = 0;

      const nextCandidate = applyCandidatePatch(baseNode.candidate, patchValidation.candidatePatch);
      const nextCandidateId = hashTextCandidate(nextCandidate);

      if (nodes.has(nextCandidateId)) {
        if (!hasUnexpandedNodes(nodes, expandedNodes)) {
          break;
        }
        continue;
      }

      const remainingBudget = this.config.maxMetricCalls - metricCallsUsed;
      const batchSize = Math.min(this.config.reflectionBatchSize, remainingBudget);
      if (batchSize <= 0) {
        break;
      }

      const evaluationBatch = selectEvaluationBatch(args.trainset, batchCursor, batchSize);
      batchCursor = advanceCursor(batchCursor, evaluationBatch.length, args.trainset.length);

      const nextEvaluation = await evaluateCandidate({
        target: args.target,
        candidate: nextCandidate,
        examples: evaluationBatch,
        metric: args.metric,
        dataset: "train",
        config: this.config,
        ...(args.execute ? { execute: args.execute } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });

      metricCallsUsed += evaluationBatch.length;

      nodes.set(nextCandidateId, {
        id: nextCandidateId,
        parentId: baseNode.id,
        candidate: nextCandidate,
        evaluation: nextEvaluation,
        ...(reflectionResult.rationale ? { rationale: reflectionResult.rationale } : {}),
        ...(nextEvaluation.feedbackSummary
          ? { feedbackSummary: nextEvaluation.feedbackSummary }
          : {}),
      });
    }

    const rerankCandidates = [...nodes.values()]
      .sort((left, right) => right.evaluation.aggregateScore - left.evaluation.aggregateScore)
      .slice(0, Math.min(3, nodes.size));

    const rerankedResults = [];
    for (const node of rerankCandidates) {
      const evaluation = await evaluateCandidate({
        target: args.target,
        candidate: node.candidate,
        examples: args.trainset,
        metric: args.metric,
        dataset: "train",
        config: this.config,
        ...(args.execute ? { execute: args.execute } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });

      rerankedResults.push({
        node,
        evaluation,
      });
    }

    const bestFinalResult = rerankedResults.sort((left, right) => {
      if (right.evaluation.aggregateScore !== left.evaluation.aggregateScore) {
        return right.evaluation.aggregateScore - left.evaluation.aggregateScore;
      }

      return right.node.evaluation.aggregateScore - left.node.evaluation.aggregateScore;
    })[0] ?? {
      node: selectBestNode(nodes),
      evaluation: await evaluateCandidate({
        target: args.target,
        candidate: selectBestNode(nodes).candidate,
        examples: args.trainset,
        metric: args.metric,
        dataset: "train",
        config: this.config,
        ...(args.execute ? { execute: args.execute } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      }),
    };

    const bestNode = bestFinalResult.node;
    const finalTrainEvaluation = bestFinalResult.evaluation;

    const finalValEvaluation =
      args.valset && args.valset.length > 0
        ? await evaluateCandidate({
            target: args.target,
            candidate: bestNode.candidate,
            examples: args.valset,
            metric: args.metric,
            dataset: "val",
            config: this.config,
            ...(args.execute ? { execute: args.execute } : {}),
            ...(args.signal ? { signal: args.signal } : {}),
          })
        : undefined;

    return {
      id: newArtifactId("gepa"),
      target: {
        kind: args.target.kind,
        id: args.target.id,
      },
      optimizer: {
        id: "gepa",
        version: this.version,
        configHash: hashConfig(this.config),
      },
      textCandidate: bestNode.candidate,
      adapter: resolveArtifactAdapter(args.target),
      eval: {
        metricName: args.metric.name,
        trainScore: finalTrainEvaluation.aggregateScore,
        ...(finalValEvaluation ? { valScore: finalValEvaluation.aggregateScore } : {}),
        trainSize: args.trainset.length,
        ...(args.valset ? { valSize: args.valset.length } : {}),
      },
      frontier: buildFrontierSnapshot(nodes),
      createdAt: nowIso(),
      metadata: {
        metricCallsUsed,
        optimizationCandidates: nodes.size,
        rerankedCandidates: rerankCandidates.length,
        reflectionModelConfigured: Boolean(activeReflectionModel),
        reflectionBatchSize: this.config.reflectionBatchSize,
      },
    };
  }
}

export function gepa(config?: GepaConfig): GepaOptimizer {
  return new GepaOptimizer(config);
}

function selectEvaluationBatch<TExample>(
  examples: readonly TExample[],
  cursor: number,
  batchSize: number,
): readonly TExample[] {
  const normalizedBatchSize = Math.max(1, Math.min(batchSize, examples.length));
  const batch: TExample[] = [];

  for (let index = 0; index < normalizedBatchSize; index += 1) {
    batch.push(examples[(cursor + index) % examples.length]!);
  }

  return batch;
}

function advanceCursor(cursor: number, amount: number, length: number): number {
  if (length === 0) {
    return 0;
  }

  return (cursor + amount) % length;
}

function selectBaseNode<TInput, TPrediction, TExpected>(
  nodes: Map<string, FrontierNode<TInput, TPrediction, TExpected>>,
  expandedNodes: Set<string>,
  config: ResolvedGepaConfig,
): FrontierNode<TInput, TPrediction, TExpected> | undefined {
  const ordered = [...nodes.values()].sort(
    (left, right) => right.evaluation.aggregateScore - left.evaluation.aggregateScore,
  );

  if (config.candidateSelection === "best-score") {
    return ordered[0];
  }

  return ordered.find((node) => !expandedNodes.has(node.id)) ?? ordered[0];
}

function selectBestNode<TInput, TPrediction, TExpected>(
  nodes: Map<string, FrontierNode<TInput, TPrediction, TExpected>>,
): FrontierNode<TInput, TPrediction, TExpected> {
  const bestNode = [...nodes.values()].sort(
    (left, right) => right.evaluation.aggregateScore - left.evaluation.aggregateScore,
  )[0];

  if (!bestNode) {
    throw new Error("GEPA did not evaluate any candidates.");
  }

  return bestNode;
}

function hasUnexpandedNodes<TInput, TPrediction, TExpected>(
  nodes: Map<string, FrontierNode<TInput, TPrediction, TExpected>>,
  expandedNodes: Set<string>,
): boolean {
  return [...nodes.keys()].some((nodeId) => !expandedNodes.has(nodeId));
}

function toReflectionExample(example: {
  example: { input: unknown; expected: unknown };
  prediction: unknown;
  score: number;
  feedback?: string;
  logs: string[];
  trace?: unknown;
  target?: { componentId: string; trace?: unknown };
}): ReflectionExample {
  return {
    input: example.example.input,
    expected: example.example.expected,
    prediction: example.prediction,
    score: example.score,
    ...(example.feedback ? { feedback: example.feedback } : {}),
    ...(example.logs.length > 0 ? { logs: example.logs } : {}),
    ...(example.trace ? { trace: example.trace as NonNullable<ReflectionExample["trace"]> } : {}),
    ...(example.target
      ? { target: example.target as NonNullable<ReflectionExample["target"]> }
      : {}),
  };
}

function resolveArtifactAdapter(target: {
  adapter?: {
    id: string;
    version: string;
  };
}): {
  id: string;
  version: string;
} {
  return {
    id: target.adapter?.id ?? "unknown",
    version: target.adapter?.version ?? "0.0.0",
  };
}

function buildFrontierSnapshot<TInput, TPrediction, TExpected>(
  nodes: Map<string, FrontierNode<TInput, TPrediction, TExpected>>,
): FrontierSnapshot[] {
  return [...nodes.values()]
    .sort((left, right) => right.evaluation.aggregateScore - left.evaluation.aggregateScore)
    .map((node) => ({
      candidateId: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      aggregateScore: node.evaluation.aggregateScore,
      textCandidate: node.candidate,
      ...(node.rationale ? { rationale: node.rationale } : {}),
      ...(node.feedbackSummary ? { feedbackSummary: node.feedbackSummary } : {}),
    }));
}

function hashConfig(config: ResolvedGepaConfig): string {
  return sha256(
    stableStringify({
      ...config,
      ...(config.reflectionModel ? { reflectionModel: "[configured]" } : {}),
    }),
  );
}
