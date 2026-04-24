import type { R2BucketLike } from "./types";

export function asR2Bucket(value: unknown): R2BucketLike | null {
  if (
    value != null &&
    typeof value === "object" &&
    "put" in value &&
    typeof value.put === "function" &&
    "get" in value &&
    typeof value.get === "function"
  ) {
    return value as R2BucketLike;
  }
  return null;
}

export async function listR2Keys(bucket: R2BucketLike, prefix: string): Promise<string[]> {
  if (bucket.list == null) {
    return [];
  }

  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await bucket.list({
      prefix,
      ...(cursor ? { cursor } : {}),
    });

    if (Array.isArray(response)) {
      keys.push(...response.map((item) => (typeof item === "string" ? item : item.key)));
      break;
    }

    keys.push(...(response.objects ?? []).map((item) => item.key));
    cursor =
      response.truncated === true && typeof response.cursor === "string"
        ? response.cursor
        : undefined;
  } while (cursor);

  return keys;
}
