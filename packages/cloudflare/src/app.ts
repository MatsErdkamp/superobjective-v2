import type {
  JsonValue,
  SuperobjectiveApp,
  SuperobjectiveCreateOptions,
  SuperobjectiveHostAdapter,
  SuperobjectiveStateTraceRecord,
  SuperobjectiveStorageObject,
  SuperobjectiveStorageObjectRef,
  SuperobjectiveStoragePutInput,
  SuperobjectiveStorageSearchConfig,
  SuperobjectiveStorageSearchHit,
  SuperobjectiveStorageSpaceConfig,
} from "superobjective";
import { createId, stableStringify } from "@superobjective/hosting";

import type { AISearchNamespaceLike, CloudflareEnvLike, R2BucketLike } from "./types";
import { asR2Bucket, listR2Keys } from "./r2";

const APP_PREFIX = "__superobjective/apps";
const memoryBuckets = new Map<string, Map<string, string>>();

type CloudflareHostOptions = {
  bucketBinding?: string;
  stateBinding?: string;
  aiSearchBinding?: string;
};

type StoredBody =
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "json";
      value: JsonValue;
    }
  | {
      kind: "bytes";
      value: string;
    };

type StoredObjectMeta = SuperobjectiveStorageObjectRef & {
  searchableText?: string;
  searchItemId?: string;
};

type StateEntry<T extends JsonValue = JsonValue> = {
  value: T;
  version: number;
};

type AppManifest = {
  id: string;
  createdAt: string;
  updatedAt: string;
  storage: Record<string, SuperobjectiveStorageSpaceConfig>;
};

type AppStateBackend = {
  bootstrapApp(options: SuperobjectiveCreateOptions): Promise<AppManifest>;
  getManifest(appId: string): Promise<AppManifest | null>;
  destroyApp(appId: string): Promise<void>;
  putStorageObject(appId: string, space: string, value: StoredObjectMeta): Promise<void>;
  getStorageObject(
    appId: string,
    space: string,
    objectId: string,
  ): Promise<StoredObjectMeta | null>;
  listStorageObjects(
    appId: string,
    space: string,
    args?: {
      kind?: string;
      limit?: number;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<StoredObjectMeta[]>;
  getStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
  ): Promise<StateEntry<T> | null>;
  putStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
    value: T,
    expectedVersion: number | null,
  ): Promise<{ ok: boolean; version: number }>;
  deleteStateEntry(appId: string, namespace: string, key: string): Promise<void>;
  listStateEntries<T extends JsonValue>(args: {
    appId: string;
    namespace?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>>;
  startTrace(
    appId: string,
    input: {
      traceId?: string;
      targetKind: string;
      targetId: string;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<{ traceId: string }>;
  appendTrace(
    appId: string,
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): Promise<void>;
  finishTrace(appId: string, traceId: string, summary?: Record<string, JsonValue>): Promise<void>;
  getTrace(appId: string, traceId: string): Promise<SuperobjectiveStateTraceRecord | null>;
  listTraces(args: {
    appId: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<SuperobjectiveStateTraceRecord[]>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }

  let base64 = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    base64 += BASE64_ALPHABET[(chunk >> 18) & 0x3f];
    base64 += BASE64_ALPHABET[(chunk >> 12) & 0x3f];
    base64 += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 0x3f] : "=";
    base64 += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 0x3f] : "=";
  }

  return base64;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const normalized = value.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const outputLength = Math.floor((normalized.length * 3) / 4) - padding;
  const bytes = new Uint8Array(outputLength);
  let offset = 0;

  for (let index = 0; index < normalized.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(normalized[index] ?? "A");
    const second = BASE64_ALPHABET.indexOf(normalized[index + 1] ?? "A");
    const thirdChar = normalized[index + 2] ?? "=";
    const fourthChar = normalized[index + 3] ?? "=";
    const third = thirdChar === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdChar);
    const fourth = fourthChar === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthChar);
    const chunk = (first << 18) | (second << 12) | (third << 6) | fourth;

    bytes[offset] = (chunk >> 16) & 0xff;
    offset += 1;
    if (thirdChar !== "=") {
      bytes[offset] = (chunk >> 8) & 0xff;
      offset += 1;
    }
    if (fourthChar !== "=") {
      bytes[offset] = chunk & 0xff;
      offset += 1;
    }
  }

  return bytes;
}

function normalizeSearchConfig(
  value: SuperobjectiveStorageSearchConfig | undefined,
  appId?: string,
  space?: string,
): SuperobjectiveStorageSpaceConfig["search"] {
  if (value == null) {
    return undefined;
  }

  const candidate =
    typeof value === "string"
      ? {
          enabled: true,
          instance: value,
        }
      : {
          ...(value.enabled != null ? { enabled: value.enabled } : {}),
          ...(value.instance != null ? { instance: value.instance } : {}),
        };

  if (candidate.enabled === false) {
    return {
      enabled: false,
      ...(candidate.instance != null ? { instance: candidate.instance } : {}),
    };
  }

  const instance =
    candidate.instance ??
    (appId != null && space != null
      ? `so-${sanitizeName(appId)}-${sanitizeName(space)}`
      : undefined);

  return {
    enabled: true,
    ...(instance != null ? { instance } : {}),
  };
}

function normalizeSpaceConfig(
  value: SuperobjectiveStorageSpaceConfig | undefined,
  appId?: string,
  space?: string,
): SuperobjectiveStorageSpaceConfig {
  const normalizedSearch = normalizeSearchConfig(value?.search, appId, space);
  return normalizedSearch == null ? {} : { search: normalizedSearch };
}

function resolvedSearchConfig(
  config: SuperobjectiveStorageSpaceConfig,
  appId?: string,
  space?: string,
): Exclude<SuperobjectiveStorageSpaceConfig["search"], string> | undefined {
  const normalized = normalizeSearchConfig(config.search, appId, space);
  if (normalized == null || typeof normalized === "string") {
    return undefined;
  }
  return normalized;
}

function normalizeStorageConfig(
  appId: string,
  value: Record<string, SuperobjectiveStorageSpaceConfig> | undefined,
): Record<string, SuperobjectiveStorageSpaceConfig> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([space, config]) => [
      space,
      normalizeSpaceConfig(config, appId, space),
    ]),
  );
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

function bodyToStored(value: SuperobjectiveStoragePutInput["body"]): StoredBody {
  if (typeof value === "string") {
    return {
      kind: "text",
      value,
    };
  }

  if (value instanceof Uint8Array) {
    return {
      kind: "bytes",
      value: encodeBase64(value),
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      kind: "bytes",
      value: encodeBase64(new Uint8Array(value)),
    };
  }

  return {
    kind: "json",
    value,
  };
}

function storedToBody(value: StoredBody): SuperobjectiveStorageObject["body"] {
  if (value.kind === "text") {
    return value.value;
  }
  if (value.kind === "json") {
    return value.value;
  }
  return decodeBase64(value.value);
}

function matchesMetadata(
  actual: Record<string, JsonValue>,
  expected: Record<string, JsonValue> | undefined,
): boolean {
  if (expected == null) {
    return true;
  }

  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

function buildSnippet(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return undefined;
  }
  const start = Math.max(0, index - 32);
  const end = Math.min(text.length, index + query.length + 32);
  return text.slice(start, end).trim();
}

class MemoryBucket implements R2BucketLike {
  private readonly store: Map<string, string>;

  constructor(name: string) {
    let store = memoryBuckets.get(name);
    if (store == null) {
      store = new Map<string, string>();
      memoryBuckets.set(name, store);
    }
    this.store = store;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
  ): Promise<void> {
    if (typeof value === "string") {
      this.store.set(key, value);
      return;
    }

    if (value instanceof ArrayBuffer) {
      this.store.set(key, JSON.stringify({ base64: encodeBase64(new Uint8Array(value)) }));
      return;
    }

    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.store.set(key, JSON.stringify({ base64: encodeBase64(bytes) }));
      return;
    }

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      this.store.set(key, await value.text());
      return;
    }

    throw new Error("MemoryBucket only supports string and buffer-like values.");
  }

  async get(key: string): Promise<unknown> {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }

    return {
      text: async () => value,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }> {
    const prefix = options?.prefix ?? "";
    return {
      objects: Array.from(this.store.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
    };
  }
}

function resolveBucket(env: CloudflareEnvLike, options?: CloudflareHostOptions): R2BucketLike {
  const binding = options?.bucketBinding ?? "SO_ARTIFACTS";
  const bucket = asR2Bucket(env[binding]);
  if (bucket != null) {
    return bucket;
  }
  return new MemoryBucket(binding);
}

function resolveSearchNamespace(
  env: CloudflareEnvLike,
  options?: CloudflareHostOptions,
): AISearchNamespaceLike | null {
  const binding = options?.aiSearchBinding ?? "AI_SEARCH";
  const candidate = env[binding];
  if (
    candidate != null &&
    typeof candidate === "object" &&
    "get" in candidate &&
    typeof candidate.get === "function"
  ) {
    return candidate as AISearchNamespaceLike;
  }
  return null;
}

async function readJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  const value = await bucket.get(key);
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "function"
  ) {
    const text = await value.text();
    return JSON.parse(text) as T;
  }

  return value as T;
}

async function writeJson(bucket: R2BucketLike, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value));
}

async function listKeys(bucket: R2BucketLike, prefix: string): Promise<string[]> {
  return listR2Keys(bucket, prefix);
}

function manifestKey(appId: string): string {
  return `${APP_PREFIX}/${encodePathSegment(appId)}/manifest.json`;
}

function appPrefix(appId: string): string {
  return `${APP_PREFIX}/${encodePathSegment(appId)}/`;
}

function storageMetaKey(appId: string, space: string, objectId: string): string {
  return `${appPrefix(appId)}storage-meta/${encodePathSegment(space)}/${encodePathSegment(objectId)}.json`;
}

function storageMetaPrefix(appId: string, space: string): string {
  return `${appPrefix(appId)}storage-meta/${encodePathSegment(space)}/`;
}

function objectBodyKey(appId: string, space: string, objectId: string): string {
  return `${appPrefix(appId)}storage/${encodePathSegment(space)}/bodies/${encodePathSegment(objectId)}.json`;
}

function stateKey(appId: string, namespace: string, key: string): string {
  return `${appPrefix(appId)}state/${encodePathSegment(namespace)}/${encodePathSegment(key)}.json`;
}

function statePrefix(appId: string, namespace?: string): string {
  if (namespace == null) {
    return `${appPrefix(appId)}state/`;
  }
  return `${appPrefix(appId)}state/${encodePathSegment(namespace)}/`;
}

function traceKey(appId: string, traceId: string): string {
  return `${appPrefix(appId)}traces/${encodePathSegment(traceId)}.json`;
}

function tracePrefix(appId: string): string {
  return `${appPrefix(appId)}traces/`;
}

async function readBody(
  bucket: R2BucketLike,
  appId: string,
  space: string,
  objectId: string,
): Promise<StoredBody | null> {
  return readJson<StoredBody>(bucket, objectBodyKey(appId, space, objectId));
}

async function writeBody(
  bucket: R2BucketLike,
  appId: string,
  space: string,
  objectId: string,
  body: StoredBody,
): Promise<void> {
  await writeJson(bucket, objectBodyKey(appId, space, objectId), body);
}

async function deleteBody(
  bucket: R2BucketLike,
  appId: string,
  space: string,
  objectId: string,
): Promise<void> {
  await bucket.delete(objectBodyKey(appId, space, objectId));
}

class BucketAppStateBackend implements AppStateBackend {
  constructor(private readonly bucket: R2BucketLike) {}

  async bootstrapApp(options: SuperobjectiveCreateOptions): Promise<AppManifest> {
    const existing = await this.getManifest(options.id);
    const declaredStorage = normalizeStorageConfig(options.id, options.storage);

    if (existing == null) {
      const manifest: AppManifest = {
        id: options.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        storage: declaredStorage,
      };
      await writeJson(this.bucket, manifestKey(options.id), manifest);
      return manifest;
    }

    const nextStorage = {
      ...existing.storage,
    };

    for (const [name, config] of Object.entries(declaredStorage)) {
      const current = nextStorage[name];
      if (current == null) {
        nextStorage[name] = config;
        continue;
      }

      if (stableStringify(current) !== stableStringify(config)) {
        throw new Error(
          `Storage space "${name}" for app "${options.id}" already exists with a different configuration.`,
        );
      }
    }

    const manifest: AppManifest = {
      ...existing,
      storage: nextStorage,
      updatedAt: nowIso(),
    };
    await writeJson(this.bucket, manifestKey(options.id), manifest);
    return manifest;
  }

  async getManifest(appId: string): Promise<AppManifest | null> {
    return readJson<AppManifest>(this.bucket, manifestKey(appId));
  }

  async destroyApp(appId: string): Promise<void> {
    const keys = await listKeys(this.bucket, appPrefix(appId));
    await Promise.all(keys.map((key) => this.bucket.delete(key)));
    await this.bucket.delete(manifestKey(appId));
  }

  async putStorageObject(appId: string, space: string, value: StoredObjectMeta): Promise<void> {
    await writeJson(this.bucket, storageMetaKey(appId, space, value.id), value);
  }

  async getStorageObject(
    appId: string,
    space: string,
    objectId: string,
  ): Promise<StoredObjectMeta | null> {
    return readJson<StoredObjectMeta>(this.bucket, storageMetaKey(appId, space, objectId));
  }

  async listStorageObjects(
    appId: string,
    space: string,
    args?: {
      kind?: string;
      limit?: number;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<StoredObjectMeta[]> {
    const keys = await listKeys(this.bucket, storageMetaPrefix(appId, space));
    const values = await Promise.all(
      keys.map((key) => readJson<StoredObjectMeta>(this.bucket, key)),
    );
    const filtered = values
      .filter((value): value is StoredObjectMeta => value != null)
      .filter((value) => {
        if (args?.kind != null && value.kind !== args.kind) {
          return false;
        }
        return matchesMetadata(value.metadata, args?.metadata);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return args?.limit != null ? filtered.slice(0, args.limit) : filtered;
  }

  async getStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
  ): Promise<StateEntry<T> | null> {
    return readJson<StateEntry<T>>(this.bucket, stateKey(appId, namespace, key));
  }

  async putStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
    value: T,
    expectedVersion: number | null,
  ): Promise<{ ok: boolean; version: number }> {
    const current = await this.getStateEntry<T>(appId, namespace, key);
    const currentVersion = current?.version ?? 0;
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      return {
        ok: false,
        version: currentVersion,
      };
    }
    const nextVersion = currentVersion + 1;
    await writeJson(this.bucket, stateKey(appId, namespace, key), {
      value,
      version: nextVersion,
    });
    return {
      ok: true,
      version: nextVersion,
    };
  }

  async deleteStateEntry(appId: string, namespace: string, key: string): Promise<void> {
    await this.bucket.delete(stateKey(appId, namespace, key));
  }

  async listStateEntries<T extends JsonValue>(args: {
    appId: string;
    namespace?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>> {
    const prefix = statePrefix(args.appId, args.namespace);
    const keys = await listKeys(this.bucket, prefix);
    const values = await Promise.all(keys.map((key) => readJson<StateEntry<T>>(this.bucket, key)));
    const items: Array<{ key: string; value: T }> = [];
    keys.forEach((key, index) => {
      const value = values[index];
      if (value == null) {
        return;
      }
      const relative = key.slice(prefix.length).replace(/\.json$/, "");
      items.push({
        key: decodePathSegment(relative.split("/").pop() ?? relative),
        value: value.value,
      });
    });
    return args.limit != null ? items.slice(0, args.limit) : items;
  }

  async startTrace(
    appId: string,
    input: {
      traceId?: string;
      targetKind: string;
      targetId: string;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<{ traceId: string }> {
    const traceId = input.traceId ?? createId("trace");
    const record: SuperobjectiveStateTraceRecord = {
      traceId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
      startedAt: nowIso(),
      events: [],
    };
    await writeJson(this.bucket, traceKey(appId, traceId), record);
    return { traceId };
  }

  async appendTrace(
    appId: string,
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): Promise<void> {
    const current = await this.getTrace(appId, traceId);
    if (current == null) {
      throw new Error(`Trace "${traceId}" was not found.`);
    }
    current.events.push({
      ts: event.ts ?? nowIso(),
      type: event.type,
      payload: event.payload,
    });
    await writeJson(this.bucket, traceKey(appId, traceId), current);
  }

  async finishTrace(
    appId: string,
    traceId: string,
    summary?: Record<string, JsonValue>,
  ): Promise<void> {
    const current = await this.getTrace(appId, traceId);
    if (current == null) {
      throw new Error(`Trace "${traceId}" was not found.`);
    }
    current.endedAt = nowIso();
    if (summary != null) {
      current.summary = summary;
    }
    await writeJson(this.bucket, traceKey(appId, traceId), current);
  }

  async getTrace(appId: string, traceId: string): Promise<SuperobjectiveStateTraceRecord | null> {
    return readJson<SuperobjectiveStateTraceRecord>(this.bucket, traceKey(appId, traceId));
  }

  async listTraces(args: {
    appId: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<SuperobjectiveStateTraceRecord[]> {
    const keys = await listKeys(this.bucket, tracePrefix(args.appId));
    const values = await Promise.all(
      keys.map((key) => readJson<SuperobjectiveStateTraceRecord>(this.bucket, key)),
    );
    const traces = values
      .filter((value): value is SuperobjectiveStateTraceRecord => value != null)
      .filter((value) => {
        if (args.targetKind != null && value.targetKind !== args.targetKind) {
          return false;
        }
        if (args.targetId != null && value.targetId !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return args.limit != null ? traces.slice(0, args.limit) : traces;
  }
}

type AppStateAgentRpc = {
  bootstrap(options: SuperobjectiveCreateOptions): Promise<AppManifest> | AppManifest;
  getManifest(): Promise<AppManifest | null> | AppManifest | null;
  putStorageObject(space: string, value: StoredObjectMeta): Promise<void> | void;
  getStorageObject(
    space: string,
    objectId: string,
  ): Promise<StoredObjectMeta | null> | StoredObjectMeta | null;
  listStorageObjects(space: string): Promise<StoredObjectMeta[]> | StoredObjectMeta[];
  getStateEntry(namespace: string, key: string): Promise<StateEntry | null> | StateEntry | null;
  putStateEntry(
    namespace: string,
    key: string,
    value: JsonValue,
    expectedVersion: number | null,
  ): Promise<{ ok: boolean; version: number }> | { ok: boolean; version: number };
  deleteStateEntry(namespace: string, key: string): Promise<void> | void;
  listStateEntries(
    namespace?: string,
  ): Promise<Array<{ key: string; value: JsonValue }>> | Array<{ key: string; value: JsonValue }>;
  startTrace(input: {
    traceId?: string;
    targetKind: string;
    targetId: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<{ traceId: string }> | { traceId: string };
  appendTrace(
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): Promise<void> | void;
  finishTrace(traceId: string, summary?: Record<string, JsonValue>): Promise<void> | void;
  getTrace(
    traceId: string,
  ): Promise<SuperobjectiveStateTraceRecord | null> | SuperobjectiveStateTraceRecord | null;
  listTraces(): Promise<SuperobjectiveStateTraceRecord[]> | SuperobjectiveStateTraceRecord[];
  destroyAppState(): Promise<void> | void;
};

async function getAppStateStub(
  env: CloudflareEnvLike,
  binding: string,
  appId: string,
): Promise<AppStateAgentRpc> {
  const namespace = env[binding];
  if (namespace == null) {
    throw new Error(`Cloudflare env binding "${binding}" is not available.`);
  }
  const mod = await import("agents");
  return (await mod.getAgentByName(namespace as never, appId)) as unknown as AppStateAgentRpc;
}

class AgentAppStateBackend implements AppStateBackend {
  constructor(
    private readonly env: CloudflareEnvLike,
    private readonly binding: string,
  ) {}

  private async stub(appId: string) {
    return getAppStateStub(this.env, this.binding, appId);
  }

  async bootstrapApp(options: SuperobjectiveCreateOptions): Promise<AppManifest> {
    const stub = await this.stub(options.id);
    return stub.bootstrap(options);
  }

  async getManifest(appId: string): Promise<AppManifest | null> {
    const stub = await this.stub(appId);
    return stub.getManifest();
  }

  async destroyApp(appId: string): Promise<void> {
    const stub = await this.stub(appId);
    await stub.destroyAppState();
  }

  async putStorageObject(appId: string, space: string, value: StoredObjectMeta): Promise<void> {
    const stub = await this.stub(appId);
    await stub.putStorageObject(space, value);
  }

  async getStorageObject(
    appId: string,
    space: string,
    objectId: string,
  ): Promise<StoredObjectMeta | null> {
    const stub = await this.stub(appId);
    return stub.getStorageObject(space, objectId);
  }

  async listStorageObjects(
    appId: string,
    space: string,
    args?: {
      kind?: string;
      limit?: number;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<StoredObjectMeta[]> {
    const stub = await this.stub(appId);
    const values = await stub.listStorageObjects(space);
    const filtered = values.filter((value) => {
      if (args?.kind != null && value.kind !== args.kind) {
        return false;
      }
      return matchesMetadata(value.metadata, args?.metadata);
    });
    return args?.limit != null ? filtered.slice(0, args.limit) : filtered;
  }

  async getStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
  ): Promise<StateEntry<T> | null> {
    const stub = await this.stub(appId);
    return (await stub.getStateEntry(namespace, key)) as StateEntry<T> | null;
  }

  async putStateEntry<T extends JsonValue>(
    appId: string,
    namespace: string,
    key: string,
    value: T,
    expectedVersion: number | null,
  ): Promise<{ ok: boolean; version: number }> {
    const stub = await this.stub(appId);
    return stub.putStateEntry(namespace, key, value, expectedVersion);
  }

  async deleteStateEntry(appId: string, namespace: string, key: string): Promise<void> {
    const stub = await this.stub(appId);
    await stub.deleteStateEntry(namespace, key);
  }

  async listStateEntries<T extends JsonValue>(args: {
    appId: string;
    namespace?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>> {
    const stub = await this.stub(args.appId);
    const values = (await stub.listStateEntries(args.namespace)) as Array<{
      key: string;
      value: T;
    }>;
    return args.limit != null ? values.slice(0, args.limit) : values;
  }

  async startTrace(
    appId: string,
    input: {
      traceId?: string;
      targetKind: string;
      targetId: string;
      metadata?: Record<string, JsonValue>;
    },
  ): Promise<{ traceId: string }> {
    const stub = await this.stub(appId);
    return stub.startTrace(input);
  }

  async appendTrace(
    appId: string,
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): Promise<void> {
    const stub = await this.stub(appId);
    await stub.appendTrace(traceId, event);
  }

  async finishTrace(
    appId: string,
    traceId: string,
    summary?: Record<string, JsonValue>,
  ): Promise<void> {
    const stub = await this.stub(appId);
    await stub.finishTrace(traceId, summary);
  }

  async getTrace(appId: string, traceId: string): Promise<SuperobjectiveStateTraceRecord | null> {
    const stub = await this.stub(appId);
    return stub.getTrace(traceId);
  }

  async listTraces(args: {
    appId: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<SuperobjectiveStateTraceRecord[]> {
    const stub = await this.stub(args.appId);
    const traces = await stub.listTraces();
    const filtered = traces.filter((value) => {
      if (args.targetKind != null && value.targetKind !== args.targetKind) {
        return false;
      }
      if (args.targetId != null && value.targetId !== args.targetId) {
        return false;
      }
      return true;
    });
    return args.limit != null ? filtered.slice(0, args.limit) : filtered;
  }
}

function resolveStateBackend(
  env: CloudflareEnvLike,
  bucket: R2BucketLike,
  options?: CloudflareHostOptions,
): AppStateBackend {
  const binding = options?.stateBinding ?? "SO_APP_STATE";
  if (env[binding] != null) {
    return new AgentAppStateBackend(env, binding);
  }
  return new BucketAppStateBackend(bucket);
}

async function ensureSearchInstance(
  namespace: AISearchNamespaceLike | null,
  appId: string,
  space: string,
  config: SuperobjectiveStorageSpaceConfig,
): Promise<SuperobjectiveStorageSpaceConfig> {
  const normalized = normalizeSpaceConfig(config, appId, space);
  const search = resolvedSearchConfig(normalized, appId, space);
  if (namespace == null || search?.enabled !== true) {
    return normalized;
  }

  const instanceName = search.instance;
  if (instanceName == null) {
    return normalized;
  }

  const instance = namespace.get(instanceName);
  try {
    await instance.info();
  } catch {
    await namespace.create({
      id: instanceName,
      description: `Superobjective ${appId} ${space}`,
      custom_metadata: [
        {
          field_name: "object_id",
          data_type: "text",
        },
        {
          field_name: "kind",
          data_type: "text",
        },
      ],
    });
  }

  return normalized;
}

async function prepareStorageConfig(
  searchNamespace: AISearchNamespaceLike | null,
  appId: string,
  storage: Record<string, SuperobjectiveStorageSpaceConfig> | undefined,
): Promise<Record<string, SuperobjectiveStorageSpaceConfig>> {
  const entries = await Promise.all(
    Object.entries(storage ?? {}).map(async ([space, config]) => [
      space,
      await ensureSearchInstance(searchNamespace, appId, space, config),
    ]),
  );
  return Object.fromEntries(entries);
}

function resolveSearchContent(
  body: SuperobjectiveStoragePutInput["body"],
  searchableText: string | undefined,
): string | Uint8Array {
  if (searchableText != null && searchableText.trim().length > 0) {
    return searchableText;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  return JSON.stringify(body);
}

async function syncSearchIndex(args: {
  namespace: AISearchNamespaceLike | null;
  config: SuperobjectiveStorageSpaceConfig;
  objectId: string;
  kind: string;
  previousSearchItemId?: string;
  content: string | Uint8Array;
}): Promise<string | undefined> {
  const search = resolvedSearchConfig(args.config);
  if (args.namespace == null || search?.enabled !== true) {
    return undefined;
  }
  const instanceName = search.instance;
  if (instanceName == null) {
    return undefined;
  }
  const instance = args.namespace.get(instanceName);
  if (args.previousSearchItemId != null) {
    try {
      await instance.items.delete(args.previousSearchItemId);
    } catch {
      // Ignore stale search items during overwrite.
    }
  }
  const item =
    typeof instance.items.upload === "function"
      ? await instance.items.upload(`${args.objectId}.txt`, args.content, {
          metadata: {
            object_id: args.objectId,
            kind: args.kind,
          },
        })
      : await instance.items.uploadAndPoll(`${args.objectId}.txt`, args.content, {
          metadata: {
            object_id: args.objectId,
            kind: args.kind,
          },
        });
  return item.id;
}

function extractSearchResults(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  }
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      return extractSearchResults(record.data);
    }
    if (Array.isArray(record.results)) {
      return extractSearchResults(record.results);
    }
    if (Array.isArray(record.matches)) {
      return extractSearchResults(record.matches);
    }
    if (Array.isArray(record.response)) {
      return extractSearchResults(record.response);
    }
  }
  return [];
}

function extractSearchHit(result: Record<string, unknown>): {
  objectId: string | null;
  score: number;
  snippet?: string;
} | null {
  const candidates: Array<Record<string, unknown>> = [result];
  for (const key of ["metadata", "attributes", "source", "document"]) {
    const nested = result[key];
    if (nested != null && typeof nested === "object") {
      candidates.push(nested as Record<string, unknown>);
    }
  }

  let objectId: string | null = null;
  for (const candidate of candidates) {
    const direct = candidate.object_id;
    if (typeof direct === "string") {
      objectId = direct;
      break;
    }
    if (
      candidate.metadata != null &&
      typeof candidate.metadata === "object" &&
      typeof (candidate.metadata as Record<string, unknown>).object_id === "string"
    ) {
      objectId = (candidate.metadata as Record<string, unknown>).object_id as string;
      break;
    }
  }

  if (objectId == null) {
    return null;
  }

  const score =
    typeof result.score === "number"
      ? result.score
      : typeof result.relevance === "number"
        ? result.relevance
        : 1;

  const snippet =
    typeof result.content === "string"
      ? buildSnippet(result.content, result.content.slice(0, 24))
      : typeof result.text === "string"
        ? buildSnippet(result.text, result.text.slice(0, 24))
        : undefined;

  return {
    objectId,
    score,
    ...(snippet != null ? { snippet } : {}),
  };
}

async function searchWithAI(
  namespace: AISearchNamespaceLike,
  config: SuperobjectiveStorageSpaceConfig,
  query: string,
  limit: number,
): Promise<SuperobjectiveStorageSearchHit[]> {
  const search = resolvedSearchConfig(config);
  const instanceName = search?.instance;
  if (instanceName == null) {
    return [];
  }

  const response = await namespace.get(instanceName).search({
    query,
    max_num_results: Math.max(limit, 10),
  });
  const results = extractSearchResults(response)
    .map(extractSearchHit)
    .filter((value): value is NonNullable<typeof value> => value != null)
    .filter((value): value is typeof value & { objectId: string } => value.objectId != null)
    .map((value) => ({
      id: value.objectId,
      score: value.score,
      ...(value.snippet != null ? { snippet: value.snippet } : {}),
    }));

  return results.slice(0, limit);
}

async function deleteSearchInstance(
  namespace: AISearchNamespaceLike | null,
  config: SuperobjectiveStorageSpaceConfig,
): Promise<void> {
  const search = resolvedSearchConfig(config);
  const instanceName = search?.instance;
  if (namespace == null || search?.enabled !== true || instanceName == null) {
    return;
  }
  try {
    await namespace.delete(instanceName);
  } catch {
    // Ignore already-deleted or missing instances.
  }
}

function buildApp(args: {
  bucket: R2BucketLike;
  stateBackend: AppStateBackend;
  manifest: AppManifest;
  destroyApp: (appId: string) => Promise<void>;
  searchNamespace: AISearchNamespaceLike | null;
}) {
  const { bucket, stateBackend, manifest, destroyApp, searchNamespace } = args;
  const appId = manifest.id;

  const storage = Object.fromEntries(
    Object.entries(manifest.storage).map(([spaceName, config]) => {
      const normalizedConfig = normalizeSpaceConfig(config, appId, spaceName);
      const space = {
        config: normalizedConfig,
        async put(input: SuperobjectiveStoragePutInput): Promise<SuperobjectiveStorageObjectRef> {
          const objectId = input.id ?? createId(spaceName);
          return this.upsert(objectId, {
            body: input.body,
            ...(input.kind != null ? { kind: input.kind } : {}),
            ...(input.contentType != null ? { contentType: input.contentType } : {}),
            ...(input.metadata != null ? { metadata: input.metadata } : {}),
            ...(input.indexForSearch != null ? { indexForSearch: input.indexForSearch } : {}),
            ...(input.searchableText != null ? { searchableText: input.searchableText } : {}),
          });
        },
        async upsert(
          id: string,
          input: Omit<SuperobjectiveStoragePutInput, "id">,
        ): Promise<SuperobjectiveStorageObjectRef> {
          const existing = await stateBackend.getStorageObject(appId, spaceName, id);
          const timestamp = nowIso();
          const body = bodyToStored(input.body);
          await writeBody(bucket, appId, spaceName, id, body);
          const searchItemId =
            input.indexForSearch === true ||
            resolvedSearchConfig(normalizedConfig, appId, spaceName)?.enabled === true
              ? await syncSearchIndex({
                  namespace: searchNamespace,
                  config: normalizedConfig,
                  objectId: id,
                  kind: input.kind ?? existing?.kind ?? "document",
                  ...(existing?.searchItemId != null
                    ? { previousSearchItemId: existing.searchItemId }
                    : {}),
                  content: resolveSearchContent(input.body, input.searchableText),
                })
              : existing?.searchItemId;

          const next: StoredObjectMeta = {
            id,
            space: spaceName,
            kind: input.kind ?? existing?.kind ?? "document",
            ...(input.contentType != null
              ? { contentType: input.contentType }
              : existing?.contentType != null
                ? { contentType: existing.contentType }
                : {}),
            metadata: input.metadata ?? existing?.metadata ?? {},
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
            ...(input.searchableText != null
              ? { searchableText: input.searchableText }
              : existing?.searchableText != null
                ? { searchableText: existing.searchableText }
                : {}),
            ...(searchItemId != null ? { searchItemId } : {}),
          };

          await stateBackend.putStorageObject(appId, spaceName, next);
          return next;
        },
        async get(id: string): Promise<SuperobjectiveStorageObject | null> {
          const meta = await stateBackend.getStorageObject(appId, spaceName, id);
          if (meta == null) {
            return null;
          }
          const body = await readBody(bucket, appId, spaceName, id);
          if (body == null) {
            return null;
          }
          return {
            ...meta,
            body: storedToBody(body),
          };
        },
        async list(args?: {
          kind?: string;
          limit?: number;
          metadata?: Record<string, JsonValue>;
        }): Promise<SuperobjectiveStorageObjectRef[]> {
          return stateBackend.listStorageObjects(appId, spaceName, args);
        },
        async search(args: {
          query: string;
          limit?: number;
          metadata?: Record<string, JsonValue>;
        }): Promise<SuperobjectiveStorageSearchHit[]> {
          if (resolvedSearchConfig(normalizedConfig, appId, spaceName)?.enabled !== true) {
            throw new Error(`Storage space "${spaceName}" does not have search enabled.`);
          }

          const limit = args.limit ?? 10;

          if (searchNamespace != null) {
            const results = await searchWithAI(
              searchNamespace,
              normalizedConfig,
              args.query,
              limit * 4,
            );
            const filtered: SuperobjectiveStorageSearchHit[] = [];
            for (const result of results) {
              const meta = await stateBackend.getStorageObject(appId, spaceName, result.id);
              if (meta == null || !matchesMetadata(meta.metadata, args.metadata)) {
                continue;
              }
              filtered.push(result);
              if (filtered.length >= limit) {
                break;
              }
            }
            if (filtered.length > 0) {
              return filtered;
            }
          }

          const values = await stateBackend.listStorageObjects(appId, spaceName);
          return values
            .filter((value) => matchesMetadata(value.metadata, args.metadata))
            .map((value) => {
              const text = value.searchableText ?? "";
              const lower = text.toLowerCase();
              const query = args.query.trim().toLowerCase();
              if (!lower.includes(query)) {
                return null;
              }
              const occurrences = lower.split(query).length - 1;
              return {
                id: value.id,
                score: 1 + occurrences,
                ...(buildSnippet(text, args.query) != null
                  ? { snippet: buildSnippet(text, args.query) }
                  : {}),
              };
            })
            .filter((value): value is SuperobjectiveStorageSearchHit => value != null)
            .sort((left, right) => right.score - left.score)
            .slice(0, limit);
        },
      };
      return [spaceName, space];
    }),
  );

  const state = {
    async get<T extends JsonValue>(namespace: string, key: string): Promise<T | null> {
      const entry = await stateBackend.getStateEntry<T>(appId, namespace, key);
      return entry?.value ?? null;
    },
    async put<T extends JsonValue>(namespace: string, key: string, value: T): Promise<void> {
      while (true) {
        const current = await stateBackend.getStateEntry<T>(appId, namespace, key);
        const result = await stateBackend.putStateEntry(
          appId,
          namespace,
          key,
          value,
          current?.version ?? null,
        );
        if (result.ok) {
          return;
        }
      }
    },
    async upsert<T extends JsonValue>(
      namespace: string,
      key: string,
      updater: T | ((current: T | null) => T),
    ): Promise<T> {
      while (true) {
        const current = await stateBackend.getStateEntry<T>(appId, namespace, key);
        const next =
          typeof updater === "function"
            ? (updater as (value: T | null) => T)(current?.value ?? null)
            : updater;
        const result = await stateBackend.putStateEntry(
          appId,
          namespace,
          key,
          next,
          current?.version ?? null,
        );
        if (result.ok) {
          return next;
        }
      }
    },
    async delete(namespace: string, key: string): Promise<void> {
      await stateBackend.deleteStateEntry(appId, namespace, key);
    },
    async list<T extends JsonValue>(args?: {
      namespace?: string;
      limit?: number;
    }): Promise<Array<{ key: string; value: T }>> {
      return stateBackend.listStateEntries<T>({
        appId,
        ...(args?.namespace != null ? { namespace: args.namespace } : {}),
        ...(args?.limit != null ? { limit: args.limit } : {}),
      });
    },
    async startTrace(input: {
      traceId?: string;
      targetKind: string;
      targetId: string;
      metadata?: Record<string, JsonValue>;
    }): Promise<{ traceId: string }> {
      return stateBackend.startTrace(appId, input);
    },
    async appendTrace(
      traceId: string,
      event: {
        ts?: string;
        type: string;
        payload: Record<string, JsonValue>;
      },
    ): Promise<void> {
      await stateBackend.appendTrace(appId, traceId, event);
    },
    async finishTrace(traceId: string, summary?: Record<string, JsonValue>): Promise<void> {
      await stateBackend.finishTrace(appId, traceId, summary);
    },
    async getTrace(traceId: string): Promise<SuperobjectiveStateTraceRecord | null> {
      return stateBackend.getTrace(appId, traceId);
    },
    async listTraces(args?: {
      targetKind?: string;
      targetId?: string;
      limit?: number;
    }): Promise<SuperobjectiveStateTraceRecord[]> {
      return stateBackend.listTraces({
        appId,
        ...(args?.targetKind != null ? { targetKind: args.targetKind } : {}),
        ...(args?.targetId != null ? { targetId: args.targetId } : {}),
        ...(args?.limit != null ? { limit: args.limit } : {}),
      });
    },
  };

  return {
    id: manifest.id,
    storage,
    state,
    destroy() {
      return destroyApp(appId);
    },
  } satisfies SuperobjectiveApp;
}

export function createCloudflareHost(
  env: CloudflareEnvLike,
  options?: CloudflareHostOptions,
): SuperobjectiveHostAdapter {
  const bucket = resolveBucket(env, options);
  const searchNamespace = resolveSearchNamespace(env, options);
  const stateBackend = resolveStateBackend(env, bucket, options);

  async function createApp(options: SuperobjectiveCreateOptions): Promise<SuperobjectiveApp> {
    const preparedStorage = await prepareStorageConfig(
      searchNamespace,
      options.id,
      options.storage,
    );
    const manifest = await stateBackend.bootstrapApp({
      ...options,
      storage: preparedStorage,
    });
    return buildApp({
      bucket,
      stateBackend,
      manifest,
      destroyApp,
      searchNamespace,
    });
  }

  async function getApp(options: { id: string }): Promise<SuperobjectiveApp> {
    const manifest = await stateBackend.getManifest(options.id);
    if (manifest == null) {
      throw new Error(`Superobjective app "${options.id}" was not found.`);
    }
    return buildApp({
      bucket,
      stateBackend,
      manifest,
      destroyApp,
      searchNamespace,
    });
  }

  async function destroyApp(options: { id: string } | string): Promise<void> {
    const appId = typeof options === "string" ? options : options.id;
    const manifest = await stateBackend.getManifest(appId);
    if (manifest != null) {
      for (const [space, config] of Object.entries(manifest.storage)) {
        const objects = await stateBackend.listStorageObjects(appId, space);
        await Promise.all(objects.map((object) => deleteBody(bucket, appId, space, object.id)));
        await deleteSearchInstance(searchNamespace, config);
      }
    }
    try {
      await stateBackend.destroyApp(appId);
    } catch (error) {
      if (error instanceof Error && error.message === "destroyed") {
        return;
      }
      throw error;
    }
  }

  return {
    kind: "cloudflare",
    createApp,
    getApp,
    destroyApp,
  };
}
