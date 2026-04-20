import type {
  ArtifactStoreLike,
  BlobStoreLike,
  CloudflareEnvLike,
  CompiledArtifactLike,
  R2BucketLike,
  RunTraceLike,
  TraceStoreLike,
} from "./types";

type TraceNamespace = {
  traces: Map<string, RunTraceLike>;
};

type ArtifactNamespace = {
  artifacts: Map<string, CompiledArtifactLike>;
  active: Map<string, string>;
};

type BlobNamespace = {
  blobs: Map<string, unknown>;
};

const traceNamespaces = new Map<string, TraceNamespace>();
const artifactNamespaces = new Map<string, ArtifactNamespace>();
const blobNamespaces = new Map<string, BlobNamespace>();

function getTraceNamespace(namespace: string): TraceNamespace {
  let store = traceNamespaces.get(namespace);
  if (store == null) {
    store = {
      traces: new Map<string, RunTraceLike>(),
    };
    traceNamespaces.set(namespace, store);
  }
  return store;
}

function getArtifactNamespace(namespace: string): ArtifactNamespace {
  let store = artifactNamespaces.get(namespace);
  if (store == null) {
    store = {
      artifacts: new Map<string, CompiledArtifactLike>(),
      active: new Map<string, string>(),
    };
    artifactNamespaces.set(namespace, store);
  }
  return store;
}

function getBlobNamespace(namespace: string): BlobNamespace {
  let store = blobNamespaces.get(namespace);
  if (store == null) {
    store = {
      blobs: new Map<string, unknown>(),
    };
    blobNamespaces.set(namespace, store);
  }
  return store;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeActiveKey(targetKind: string, targetId: string): string {
  return `${targetKind}:${targetId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonString<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function readBucketJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  const value = await bucket.get(key);
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return parseJsonString<T>(value);
  }

  if (isRecord(value) && "text" in value && typeof value.text === "function") {
    const text = await value.text();
    return parseJsonString<T>(text);
  }

  return value as T;
}

async function listBucketKeys(bucket: R2BucketLike, prefix: string): Promise<string[]> {
  const response = bucket.list == null ? [] : await bucket.list({ prefix });

  if (Array.isArray(response)) {
    return response.map((item) => (typeof item === "string" ? item : item.key));
  }

  return (response.objects ?? []).map((item) => item.key);
}

export class InMemorySqliteTraceStore implements TraceStoreLike {
  readonly namespace: string;
  private readonly store: TraceNamespace;

  constructor(namespace = "default") {
    this.namespace = namespace;
    this.store = getTraceNamespace(namespace);
  }

  async saveTrace(trace: RunTraceLike): Promise<void> {
    this.store.traces.set(trace.runId, cloneValue(trace));
  }

  async loadTrace(runId: string): Promise<RunTraceLike | null> {
    const trace = this.store.traces.get(runId);
    return trace == null ? null : cloneValue(trace);
  }

  async listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]> {
    const traces = Array.from(this.store.traces.values())
      .filter((trace) => {
        if (args?.targetKind != null && trace.targetKind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && trace.targetId !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    const limited = args?.limit != null ? traces.slice(0, args.limit) : traces.slice();
    return cloneValue(limited);
  }
}

type R2TraceStoreOptions = {
  namespace?: string;
  env?: CloudflareEnvLike;
  binding?: string;
  fallbackStore?: TraceStoreLike;
};

export class R2BackedTraceStore implements TraceStoreLike {
  readonly namespace: string;
  readonly binding: string;
  private readonly env: CloudflareEnvLike | undefined;
  private readonly fallbackStore: TraceStoreLike;

  constructor(options?: R2TraceStoreOptions) {
    this.namespace = options?.namespace ?? "default";
    this.binding = options?.binding ?? "SO_ARTIFACTS";
    this.env = options?.env;
    this.fallbackStore = options?.fallbackStore ?? new InMemorySqliteTraceStore(this.namespace);
  }

  withEnv(env: CloudflareEnvLike): R2BackedTraceStore {
    return new R2BackedTraceStore({
      namespace: this.namespace,
      binding: this.binding,
      env,
      fallbackStore: this.fallbackStore,
    });
  }

  private resolveBucket(): R2BucketLike | null {
    const candidate = this.env?.[this.binding];
    if (
      candidate != null &&
      typeof candidate === "object" &&
      "put" in candidate &&
      typeof candidate.put === "function" &&
      "get" in candidate &&
      typeof candidate.get === "function"
    ) {
      return candidate as R2BucketLike;
    }
    return null;
  }

  private traceKey(runId: string): string {
    return `${this.namespace}/traces/${runId}.json`;
  }

  async saveTrace(trace: RunTraceLike): Promise<void> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      await this.fallbackStore.saveTrace(trace);
      return;
    }

    await bucket.put(this.traceKey(trace.runId), JSON.stringify(trace));
  }

  async loadTrace(runId: string): Promise<RunTraceLike | null> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.loadTrace(runId);
    }

    return readBucketJson<RunTraceLike>(bucket, this.traceKey(runId));
  }

  async listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.listTraces?.(args) ?? Promise.resolve([]);
    }

    const keys = await listBucketKeys(bucket, `${this.namespace}/traces/`);
    const traces = await Promise.all(keys.map((key) => readBucketJson<RunTraceLike>(bucket, key)));

    const filtered = traces
      .filter((trace): trace is RunTraceLike => trace != null)
      .filter((trace: RunTraceLike) => {
        if (args?.targetKind != null && trace.targetKind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && trace.targetId !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left: RunTraceLike, right: RunTraceLike) =>
        right.startedAt.localeCompare(left.startedAt),
      );

    return args?.limit != null ? filtered.slice(0, args.limit) : filtered;
  }
}

export class InMemorySqliteArtifactStore implements ArtifactStoreLike {
  readonly namespace: string;
  private readonly store: ArtifactNamespace;

  constructor(namespace = "default") {
    this.namespace = namespace;
    this.store = getArtifactNamespace(namespace);
  }

  async saveArtifact(artifact: CompiledArtifactLike): Promise<void> {
    this.store.artifacts.set(artifact.id, cloneValue(artifact));
  }

  async loadArtifact(id: string): Promise<CompiledArtifactLike | null> {
    const artifact = this.store.artifacts.get(id);
    return artifact == null ? null : cloneValue(artifact);
  }

  async listArtifacts(args?: {
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<CompiledArtifactLike[]> {
    const artifacts = Array.from(this.store.artifacts.values())
      .filter((artifact) => {
        if (args?.targetKind != null && artifact.target.kind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && artifact.target.id !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const limited = args?.limit != null ? artifacts.slice(0, args.limit) : artifacts.slice();
    return cloneValue(limited);
  }

  async loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<CompiledArtifactLike | null> {
    const artifactId = this.store.active.get(makeActiveKey(args.targetKind, args.targetId));
    if (artifactId == null) {
      return null;
    }
    const artifact = this.store.artifacts.get(artifactId);
    return artifact == null ? null : cloneValue(artifact);
  }

  async setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void> {
    this.store.active.set(makeActiveKey(args.targetKind, args.targetId), args.artifactId);
  }
}

type R2ArtifactStoreOptions = {
  namespace?: string;
  env?: CloudflareEnvLike;
  binding?: string;
  fallbackStore?: ArtifactStoreLike;
};

export class R2BackedArtifactStore implements ArtifactStoreLike {
  readonly namespace: string;
  readonly binding: string;
  private readonly env: CloudflareEnvLike | undefined;
  private readonly fallbackStore: ArtifactStoreLike;

  constructor(options?: R2ArtifactStoreOptions) {
    this.namespace = options?.namespace ?? "default";
    this.binding = options?.binding ?? "SO_ARTIFACTS";
    this.env = options?.env;
    this.fallbackStore = options?.fallbackStore ?? new InMemorySqliteArtifactStore(this.namespace);
  }

  withEnv(env: CloudflareEnvLike): R2BackedArtifactStore {
    return new R2BackedArtifactStore({
      namespace: this.namespace,
      binding: this.binding,
      env,
      fallbackStore: this.fallbackStore,
    });
  }

  private resolveBucket(): R2BucketLike | null {
    const candidate = this.env?.[this.binding];
    if (
      candidate != null &&
      typeof candidate === "object" &&
      "put" in candidate &&
      typeof candidate.put === "function" &&
      "get" in candidate &&
      typeof candidate.get === "function"
    ) {
      return candidate as R2BucketLike;
    }
    return null;
  }

  private artifactKey(artifactId: string): string {
    return `${this.namespace}/artifacts/${artifactId}.json`;
  }

  private activeKey(targetKind: string, targetId: string): string {
    return `${this.namespace}/active/${targetKind}/${encodeURIComponent(targetId)}.json`;
  }

  async saveArtifact(artifact: CompiledArtifactLike): Promise<void> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      await this.fallbackStore.saveArtifact(artifact);
      return;
    }

    await bucket.put(this.artifactKey(artifact.id), JSON.stringify(artifact));
  }

  async loadArtifact(id: string): Promise<CompiledArtifactLike | null> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.loadArtifact(id);
    }

    return readBucketJson<CompiledArtifactLike>(bucket, this.artifactKey(id));
  }

  async listArtifacts(args?: {
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<CompiledArtifactLike[]> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.listArtifacts?.(args) ?? Promise.resolve([]);
    }

    const keys = await listBucketKeys(bucket, `${this.namespace}/artifacts/`);
    const artifacts = await Promise.all(
      keys.map((key) => readBucketJson<CompiledArtifactLike>(bucket, key)),
    );

    const filtered = artifacts
      .filter((artifact): artifact is CompiledArtifactLike => artifact != null)
      .filter((artifact: CompiledArtifactLike) => {
        if (args?.targetKind != null && artifact.target.kind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && artifact.target.id !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left: CompiledArtifactLike, right: CompiledArtifactLike) =>
        right.createdAt.localeCompare(left.createdAt),
      );

    return args?.limit != null ? filtered.slice(0, args.limit) : filtered;
  }

  async loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<CompiledArtifactLike | null> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      return this.fallbackStore.loadActiveArtifact(args);
    }

    const value = await readBucketJson<{ artifactId: string } | string>(
      bucket,
      this.activeKey(args.targetKind, args.targetId),
    );
    const artifactId =
      typeof value === "string"
        ? value
        : value != null && typeof value.artifactId === "string"
          ? value.artifactId
          : null;

    if (artifactId == null) {
      return null;
    }

    return this.loadArtifact(artifactId);
  }

  async setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void> {
    const bucket = this.resolveBucket();
    if (bucket == null) {
      await this.fallbackStore.setActiveArtifact(args);
      return;
    }

    await bucket.put(
      this.activeKey(args.targetKind, args.targetId),
      JSON.stringify({
        artifactId: args.artifactId,
      }),
    );
  }
}

export class InMemoryR2BlobStore implements BlobStoreLike {
  readonly namespace: string;
  private readonly store: BlobNamespace;

  constructor(namespace = "default") {
    this.namespace = namespace;
    this.store = getBlobNamespace(namespace);
  }

  async put(key: string, value: unknown): Promise<string> {
    this.store.blobs.set(key, cloneValue(value));
    return key;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.blobs.get(key);
    return value == null ? null : (cloneValue(value) as T);
  }

  async delete(key: string): Promise<void> {
    this.store.blobs.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return Array.from(this.store.blobs.keys()).filter((key) => key.startsWith(prefix));
  }
}

export function createSqliteTraceStore(namespace?: string): TraceStoreLike {
  return new R2BackedTraceStore(
    namespace == null
      ? undefined
      : {
          namespace,
        },
  );
}

export function createSqliteArtifactStore(namespace?: string): ArtifactStoreLike {
  return new R2BackedArtifactStore(
    namespace == null
      ? undefined
      : {
          namespace,
        },
  );
}

export function createR2BlobStore(namespace?: string): BlobStoreLike {
  return new InMemoryR2BlobStore(namespace);
}
