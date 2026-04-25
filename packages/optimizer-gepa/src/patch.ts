import { buildAllowedCandidatePaths } from "./candidate.js";
import type {
  AllowedCandidatePath,
  CandidatePatchValidationIssue,
  CandidatePatchValidationResult,
  ResolvedGepaConfig,
  TextCandidate,
} from "./types.js";
import { sortRecord } from "./utils.js";

export function validateCandidatePatch(args: {
  currentCandidate: TextCandidate;
  candidatePatch: Partial<TextCandidate>;
  config: ResolvedGepaConfig;
  allowedPaths?: AllowedCandidatePath[];
}): CandidatePatchValidationResult {
  const { currentCandidate, candidatePatch, config } = args;
  const allowedPaths = args.allowedPaths ?? buildAllowedCandidatePaths(currentCandidate);
  const allowedPathSet = new Set(allowedPaths.map((path) => path.path));
  const issues: CandidatePatchValidationIssue[] = [];

  if (!candidatePatch || typeof candidatePatch !== "object" || Array.isArray(candidatePatch)) {
    return {
      ok: false,
      candidatePatch: {},
      changedPaths: [],
      issues: [
        {
          code: "invalid_patch",
          message: "Reflection model must return an object patch keyed by candidate path.",
        },
      ],
    };
  }

  const normalizedPatch: Partial<TextCandidate> = {};
  const changedPaths: string[] = [];

  for (const [path, nextValue] of Object.entries(candidatePatch)) {
    if (!allowedPathSet.has(path)) {
      issues.push({
        code: "unknown_path",
        path,
        message: `Patch attempted to modify unknown path "${path}".`,
      });
      continue;
    }

    if (typeof nextValue !== "string") {
      issues.push({
        code: "non_string_value",
        path,
        message: `Patch value for "${path}" must be a string.`,
      });
      continue;
    }

    if (nextValue.trim().length < config.minTextLengthPerPath) {
      issues.push({
        code: "too_short",
        path,
        message: `Patch value for "${path}" must be at least ${config.minTextLengthPerPath} trimmed characters.`,
      });
      continue;
    }

    if (nextValue.length > config.maxTextLengthPerPath) {
      issues.push({
        code: "too_long",
        path,
        message: `Patch value for "${path}" exceeds ${config.maxTextLengthPerPath} characters.`,
      });
      continue;
    }

    if (currentCandidate[path] === nextValue) {
      continue;
    }

    normalizedPatch[path] = nextValue;
    changedPaths.push(path);
  }

  if (changedPaths.length > config.mutation.maxPathsPerMutation) {
    issues.push({
      code: "too_many_paths",
      message: `Patch modified ${changedPaths.length} paths, which exceeds the configured limit of ${config.mutation.maxPathsPerMutation}.`,
    });
  }

  if (changedPaths.length === 0) {
    issues.push({
      code: issues.length === 0 ? "no_effect" : "empty_patch",
      message:
        issues.length === 0
          ? "Patch did not change any candidate values."
          : "Patch did not contain any valid candidate updates.",
    });
  }

  return {
    ok: issues.length === 0,
    candidatePatch: sortRecord(normalizedPatch),
    changedPaths,
    issues,
  };
}
