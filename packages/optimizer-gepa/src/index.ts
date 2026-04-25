export { DEFAULT_GEPA_CONFIG, GEPA_VERSION, resolveGepaConfig } from "./defaults.js";
export { GepaBudgetExceededError, MetricBudget } from "./budget.js";
export type { MetricBudgetPhase, MetricBudgetSnapshot } from "./budget.js";
export {
  applyCandidatePatch,
  buildAllowedCandidatePaths,
  classifyCandidatePath,
  extractTextCandidate,
  hashTextCandidate,
  normalizeTextCandidate,
} from "./candidate.js";
export { validateCandidatePatch } from "./patch.js";
export { GepaOptimizer, gepa } from "./gepa.js";
export type {
  AllowedCandidatePath,
  CandidateEvaluation,
  CandidatePatchValidationIssue,
  CandidatePatchValidationResult,
  CompiledArtifactLike,
  ExampleLike,
  FrontierSnapshot,
  GepaCompileArgs,
  GepaConfig,
  GepaExecutionHook,
  GepaOptimizerLike,
  GepaRunResult,
  GepaRunWithTraceResult,
  GepaTargetLike,
  ReflectionExample,
  ReflectionModel,
  ReflectionPathKind,
  ResolvedGepaConfig,
  RunTraceLike,
  ScoreLike,
  TextCandidate,
} from "./types.js";
