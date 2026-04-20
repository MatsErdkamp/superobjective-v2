export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
  }

  return `${toHex(left)}${toHex(right)}`;
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
  }

  return sorted[midpoint]!;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newArtifactId(prefix: string): string {
  return `${prefix}_${createUuidLike()}`;
}

export function summarizeUnique(
  values: readonly string[],
  options?: {
    maxItems?: number;
    maxLength?: number;
  },
): string | undefined {
  const maxItems = options?.maxItems ?? 4;
  const maxLength = options?.maxLength ?? 800;

  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  let currentLength = 0;

  for (const value of unique.slice(0, maxItems)) {
    const nextLength = currentLength + value.length + (lines.length === 0 ? 0 : 1);
    if (nextLength > maxLength) {
      break;
    }

    lines.push(value);
    currentLength = nextLength;
  }

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n");
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("GEPA compile aborted.");
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortValue(entryValue)]),
    );
  }

  return value;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function createUuidLike(): string {
  const runtimeCrypto =
    typeof globalThis !== "undefined" &&
    "crypto" in globalThis &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto
      : undefined;

  if (runtimeCrypto) {
    return runtimeCrypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
