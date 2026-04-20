import type {
  CompiledArtifact,
  ModelHandle,
  ModelProvider,
  SerializedError,
  TextCandidate,
} from "./types.js";

let idCounter = 0;

export function createId(prefix: string): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return `${prefix}_${globalCrypto.randomUUID()}`;
  }

  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortValue(nestedValue)]),
    );
  }

  return value;
}

export function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown error",
  };
}

export function appendLine(original: string | undefined, line: string): string {
  if (!original) {
    return line;
  }

  return `${original}\n${line}`;
}

export function mergeCandidates(
  ...candidates: Array<TextCandidate | undefined | null>
): TextCandidate {
  return Object.assign({}, ...candidates.filter(Boolean));
}

export function shallowClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }

  if (value && typeof value === "object") {
    return { ...(value as Record<string, unknown>) } as T;
  }

  return value;
}

export function chooseArtifactCandidate(
  artifact: CompiledArtifact | undefined,
): TextCandidate | undefined {
  return artifact?.textCandidate;
}

export function describeModelHandle(model: ModelHandle | ModelProvider): {
  provider: string;
  model: string;
} {
  if (typeof model === "string") {
    return {
      provider: "unknown",
      model,
    };
  }

  if ("id" in model && typeof model.id === "string" && "structured" in model) {
    return {
      provider: model.id,
      model: model.id,
    };
  }

  return {
    provider:
      typeof (model as { provider?: unknown }).provider === "string"
        ? ((model as { provider?: string }).provider ?? "unknown")
        : "unknown",
    model:
      typeof (model as { model?: unknown }).model === "string"
        ? ((model as { model?: string }).model ?? "unknown")
        : typeof (model as { id?: unknown }).id === "string"
          ? ((model as { id?: string }).id ?? "unknown")
          : "unknown",
  };
}

export function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const next = mulberry32(seed);
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [copy[index], copy[target]] = [copy[target] as T, copy[index] as T];
  }

  return copy;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
