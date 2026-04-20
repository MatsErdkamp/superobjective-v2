import type {
  JsonValue,
  SuperobjectiveCreateOptions,
  SuperobjectiveStateTraceRecord,
  SuperobjectiveStorageSpaceConfig,
} from "superobjective";

type AppManifest = {
  id: string;
  createdAt: string;
  updatedAt: string;
  storage: Record<string, SuperobjectiveStorageSpaceConfig>;
};

type StoredObjectMeta = {
  id: string;
  space: string;
  kind: string;
  contentType?: string;
  metadata: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  searchableText?: string;
  searchItemId?: string;
};

type StateEntry = {
  value: JsonValue;
  version: number;
};

type AgentEnv = Record<string, unknown>;
type AgentBaseLike = new (...args: any[]) => {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  destroy(): Promise<void>;
};

const agentsModule =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined"
    ? await import("agents")
    : null;

const AgentBase = (agentsModule?.Agent ??
  class {
    constructor(..._args: any[]) {}

    sql<T = Record<string, string | number | boolean | null>>(
      _strings: TemplateStringsArray,
      ..._values: (string | number | boolean | null)[]
    ): T[] {
      throw new Error("AppStateAgent is only available in the Cloudflare runtime.");
    }

    async destroy(): Promise<void> {
      return undefined;
    }
  }) as AgentBaseLike;

function createId(prefix: string): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${value}`;
}

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

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }

  return value;
}

function normalizeSearchConfig(
  value: SuperobjectiveStorageSpaceConfig["search"],
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

function normalizeStorageConfig(
  appId: string,
  value: Record<string, SuperobjectiveStorageSpaceConfig> | undefined,
): Record<string, SuperobjectiveStorageSpaceConfig> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([space, config]) => {
      const normalizedSearch = normalizeSearchConfig(config.search, appId, space);
      return [space, normalizedSearch == null ? {} : { search: normalizedSearch }];
    }),
  );
}

export class AppStateAgent extends AgentBase {
  initialState = { ready: true };

  constructor(ctx: any, env: AgentEnv) {
    super(ctx, env);
    void this.sql`CREATE TABLE IF NOT EXISTS manifest (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      body TEXT NOT NULL
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS storage_objects (
      space TEXT NOT NULL,
      object_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (space, object_id)
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS state_entries (
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (namespace, entry_key)
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      body TEXT NOT NULL
    )`;
  }

  private readManifest(): AppManifest | null {
    const rows = this.sql<{ body: string }>`SELECT body FROM manifest WHERE singleton = 1 LIMIT 1`;
    const row = rows[0];
    return row == null ? null : (JSON.parse(row.body) as AppManifest);
  }

  bootstrap(options: SuperobjectiveCreateOptions): AppManifest {
    const existing = this.readManifest();
    const declaredStorage = normalizeStorageConfig(options.id, options.storage);
    if (existing == null) {
      const manifest: AppManifest = {
        id: options.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        storage: declaredStorage,
      };
      void this
        .sql`INSERT OR REPLACE INTO manifest (singleton, body) VALUES (1, ${JSON.stringify(manifest)})`;
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
    void this
      .sql`INSERT OR REPLACE INTO manifest (singleton, body) VALUES (1, ${JSON.stringify(manifest)})`;
    return manifest;
  }

  getManifest(): AppManifest | null {
    return this.readManifest();
  }

  putStorageObject(space: string, value: StoredObjectMeta): void {
    void this.sql`INSERT OR REPLACE INTO storage_objects (space, object_id, updated_at, body)
      VALUES (${space}, ${value.id}, ${value.updatedAt}, ${JSON.stringify(value)})`;
  }

  getStorageObject(space: string, objectId: string): StoredObjectMeta | null {
    const rows = this.sql<{ body: string }>`
      SELECT body FROM storage_objects WHERE space = ${space} AND object_id = ${objectId} LIMIT 1
    `;
    const row = rows[0];
    return row == null ? null : (JSON.parse(row.body) as StoredObjectMeta);
  }

  listStorageObjects(space: string): StoredObjectMeta[] {
    const rows = this.sql<{ body: string }>`
      SELECT body FROM storage_objects WHERE space = ${space} ORDER BY updated_at DESC
    `;
    return rows.map((row) => JSON.parse(row.body) as StoredObjectMeta);
  }

  getStateEntry(namespace: string, key: string): StateEntry | null {
    const rows = this.sql<{ body: string; version: number }>`
      SELECT body, version FROM state_entries WHERE namespace = ${namespace} AND entry_key = ${key} LIMIT 1
    `;
    const row = rows[0];
    return row == null
      ? null
      : {
          value: JSON.parse(row.body) as JsonValue,
          version: row.version,
        };
  }

  putStateEntry(
    namespace: string,
    key: string,
    value: JsonValue,
    expectedVersion: number | null,
  ): { ok: boolean; version: number } {
    const current = this.getStateEntry(namespace, key);
    const currentVersion = current?.version ?? 0;
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      return {
        ok: false,
        version: currentVersion,
      };
    }
    const nextVersion = currentVersion + 1;
    void this.sql`INSERT OR REPLACE INTO state_entries (namespace, entry_key, version, body)
      VALUES (${namespace}, ${key}, ${nextVersion}, ${JSON.stringify(value)})`;
    return {
      ok: true,
      version: nextVersion,
    };
  }

  deleteStateEntry(namespace: string, key: string): void {
    void this.sql`DELETE FROM state_entries WHERE namespace = ${namespace} AND entry_key = ${key}`;
  }

  listStateEntries(namespace?: string): Array<{ key: string; value: JsonValue }> {
    const rows =
      namespace == null
        ? this.sql<{ entry_key: string; body: string }>`
            SELECT entry_key, body FROM state_entries ORDER BY entry_key ASC
          `
        : this.sql<{ entry_key: string; body: string }>`
            SELECT entry_key, body FROM state_entries WHERE namespace = ${namespace} ORDER BY entry_key ASC
          `;
    return rows.map((row) => ({
      key: row.entry_key,
      value: JSON.parse(row.body) as JsonValue,
    }));
  }

  startTrace(input: {
    traceId?: string;
    targetKind: string;
    targetId: string;
    metadata?: Record<string, JsonValue>;
  }): { traceId: string } {
    const traceId = input.traceId ?? createId("trace");
    const record: SuperobjectiveStateTraceRecord = {
      traceId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
      startedAt: nowIso(),
      events: [],
    };
    void this.sql`INSERT OR REPLACE INTO traces (trace_id, target_kind, target_id, started_at, body)
      VALUES (${traceId}, ${record.targetKind}, ${record.targetId}, ${record.startedAt}, ${JSON.stringify(record)})`;
    return { traceId };
  }

  appendTrace(
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): void {
    const current = this.getTrace(traceId);
    if (current == null) {
      throw new Error(`Trace "${traceId}" was not found.`);
    }
    current.events.push({
      ts: event.ts ?? nowIso(),
      type: event.type,
      payload: event.payload,
    });
    void this.sql`UPDATE traces SET body = ${JSON.stringify(current)} WHERE trace_id = ${traceId}`;
  }

  finishTrace(traceId: string, summary?: Record<string, JsonValue>): void {
    const current = this.getTrace(traceId);
    if (current == null) {
      throw new Error(`Trace "${traceId}" was not found.`);
    }
    current.endedAt = nowIso();
    if (summary != null) {
      current.summary = summary;
    }
    void this.sql`UPDATE traces SET body = ${JSON.stringify(current)} WHERE trace_id = ${traceId}`;
  }

  getTrace(traceId: string): SuperobjectiveStateTraceRecord | null {
    const rows = this.sql<{ body: string }>`
      SELECT body FROM traces WHERE trace_id = ${traceId} LIMIT 1
    `;
    const row = rows[0];
    return row == null ? null : (JSON.parse(row.body) as SuperobjectiveStateTraceRecord);
  }

  listTraces(): SuperobjectiveStateTraceRecord[] {
    const rows = this.sql<{ body: string }>`
      SELECT body FROM traces ORDER BY started_at DESC
    `;
    return rows.map((row) => JSON.parse(row.body) as SuperobjectiveStateTraceRecord);
  }

  async destroyAppState(): Promise<void> {
    void this.sql`DELETE FROM traces`;
    void this.sql`DELETE FROM state_entries`;
    void this.sql`DELETE FROM storage_objects`;
    void this.sql`DELETE FROM manifest`;
    try {
      await this.destroy();
    } catch (error) {
      if (error instanceof Error && error.message === "destroyed") {
        return;
      }
      throw error;
    }
  }
}
