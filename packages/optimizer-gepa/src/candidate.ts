import type {
  AllowedCandidatePath,
  GepaTargetLike,
  ReflectionPathKind,
  TextCandidate,
} from "./types.js";
import { sha256, sortRecord, stableStringify } from "./utils.js";

export function extractTextCandidate(
  target: Pick<GepaTargetLike, "inspectTextCandidate">,
): TextCandidate {
  const candidate = target.inspectTextCandidate();
  return normalizeTextCandidate(candidate);
}

export function normalizeTextCandidate(candidate: TextCandidate): TextCandidate {
  const normalizedEntries = Object.entries(candidate).map(([path, value]) => {
    if (typeof value !== "string") {
      throw new TypeError(`TextCandidate path "${path}" must resolve to a string.`);
    }

    return [path, value] as const;
  });

  return Object.fromEntries(normalizedEntries.sort(([left], [right]) => left.localeCompare(right)));
}

export function applyCandidatePatch(
  currentCandidate: TextCandidate,
  patch: Partial<TextCandidate>,
): TextCandidate {
  const definedPatchEntries = Object.entries(sortRecord(patch)).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>;

  return normalizeTextCandidate({
    ...currentCandidate,
    ...Object.fromEntries(definedPatchEntries),
  });
}

export function hashTextCandidate(candidate: TextCandidate): string {
  return sha256(stableStringify(normalizeTextCandidate(candidate)));
}

export function buildAllowedCandidatePaths(candidate: TextCandidate): AllowedCandidatePath[] {
  return Object.entries(normalizeTextCandidate(candidate)).map(([path, currentValue]) => ({
    path,
    currentValue,
    kind: classifyCandidatePath(path),
  }));
}

export function classifyCandidatePath(path: string): ReflectionPathKind {
  if (path.endsWith(".instructions")) {
    return "instructions";
  }

  if (path.includes(".input.") && path.endsWith(".description")) {
    return "input_description";
  }

  if (path.includes(".output.") && path.endsWith(".description")) {
    return "output_description";
  }

  if (path.startsWith("agent.") && path.endsWith(".system")) {
    return "agent_system";
  }

  if (path.endsWith(".description")) {
    return "tool_description";
  }

  return "instructions";
}
