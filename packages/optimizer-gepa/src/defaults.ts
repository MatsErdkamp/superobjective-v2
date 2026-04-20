import type { GepaConfig, ResolvedGepaConfig } from "./types.js";

export const GEPA_VERSION = "0.1.0";

export const DEFAULT_GEPA_CONFIG: ResolvedGepaConfig = {
  maxMetricCalls: 120,
  reflectionBatchSize: 3,
  skipPerfectScores: true,
  candidateSelection: "pareto",
  mutation: {
    maxPathsPerMutation: 3,
    allowNewPaths: false,
  },
  scoring: {
    aggregate: "mean",
  },
  trace: {
    includePrompts: true,
    includeModelResponses: false,
    includePassingExamples: false,
  },
  maxTextLengthPerPath: 4_000,
  minTextLengthPerPath: 1,
};

export function resolveGepaConfig(config?: GepaConfig): ResolvedGepaConfig {
  const resolved: ResolvedGepaConfig = {
    maxMetricCalls: integerOrDefault(config?.maxMetricCalls, DEFAULT_GEPA_CONFIG.maxMetricCalls),
    reflectionBatchSize: integerOrDefault(
      config?.reflectionBatchSize,
      DEFAULT_GEPA_CONFIG.reflectionBatchSize,
    ),
    skipPerfectScores: config?.skipPerfectScores ?? DEFAULT_GEPA_CONFIG.skipPerfectScores,
    candidateSelection: config?.candidateSelection ?? DEFAULT_GEPA_CONFIG.candidateSelection,
    mutation: {
      maxPathsPerMutation: integerOrDefault(
        config?.mutation?.maxPathsPerMutation,
        DEFAULT_GEPA_CONFIG.mutation.maxPathsPerMutation,
      ),
      allowNewPaths: config?.mutation?.allowNewPaths ?? DEFAULT_GEPA_CONFIG.mutation.allowNewPaths,
    },
    scoring: {
      aggregate: config?.scoring?.aggregate ?? DEFAULT_GEPA_CONFIG.scoring.aggregate,
    },
    trace: {
      includePrompts: config?.trace?.includePrompts ?? DEFAULT_GEPA_CONFIG.trace.includePrompts,
      includeModelResponses:
        config?.trace?.includeModelResponses ?? DEFAULT_GEPA_CONFIG.trace.includeModelResponses,
      includePassingExamples:
        config?.trace?.includePassingExamples ?? DEFAULT_GEPA_CONFIG.trace.includePassingExamples,
    },
    maxTextLengthPerPath: config?.maxTextLengthPerPath ?? DEFAULT_GEPA_CONFIG.maxTextLengthPerPath,
    minTextLengthPerPath: config?.minTextLengthPerPath ?? DEFAULT_GEPA_CONFIG.minTextLengthPerPath,
    ...(config?.reflectionModel ? { reflectionModel: config.reflectionModel } : {}),
  };

  if (resolved.maxMetricCalls <= 0) {
    throw new RangeError("GEPA maxMetricCalls must be greater than 0.");
  }

  if (resolved.reflectionBatchSize <= 0) {
    throw new RangeError("GEPA reflectionBatchSize must be greater than 0.");
  }

  if (resolved.mutation.maxPathsPerMutation <= 0) {
    throw new RangeError("GEPA mutation.maxPathsPerMutation must be greater than 0.");
  }

  if (resolved.minTextLengthPerPath < 0) {
    throw new RangeError("GEPA minTextLengthPerPath cannot be negative.");
  }

  if (resolved.maxTextLengthPerPath < resolved.minTextLengthPerPath) {
    throw new RangeError("GEPA maxTextLengthPerPath cannot be smaller than minTextLengthPerPath.");
  }

  return resolved;
}

function integerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    throw new RangeError("GEPA numeric config values must be finite numbers.");
  }

  return Math.max(0, Math.floor(value));
}
