import type { JsonValue } from "./types.js";

export type SuperobjectiveStorageSearchConfig =
  | string
  | {
      enabled?: boolean;
      instance?: string;
    };

export type SuperobjectiveStorageSpaceConfig = {
  search?: SuperobjectiveStorageSearchConfig;
};

export type SuperobjectiveCreateOptions = {
  id: string;
  storage?: Record<string, SuperobjectiveStorageSpaceConfig>;
};

export type SuperobjectiveGetOptions = {
  id: string;
};

export type SuperobjectiveDestroyOptions = {
  id: string;
};

export type SuperobjectiveStoragePutInput = {
  id?: string;
  kind?: string;
  body: JsonValue | string | Uint8Array | ArrayBuffer;
  contentType?: string;
  metadata?: Record<string, JsonValue>;
  indexForSearch?: boolean;
  searchableText?: string;
};

export type SuperobjectiveStorageObjectRef = {
  id: string;
  space: string;
  kind: string;
  contentType?: string;
  metadata: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
};

export type SuperobjectiveStorageObject = SuperobjectiveStorageObjectRef & {
  body: JsonValue | string | Uint8Array;
  searchableText?: string;
};

export type SuperobjectiveStorageSearchHit = {
  id: string;
  score: number;
  snippet?: string;
};

export type SuperobjectiveStorageSpace = {
  config: SuperobjectiveStorageSpaceConfig;
  put(input: SuperobjectiveStoragePutInput): Promise<SuperobjectiveStorageObjectRef>;
  upsert(
    id: string,
    input: Omit<SuperobjectiveStoragePutInput, "id">,
  ): Promise<SuperobjectiveStorageObjectRef>;
  get(id: string): Promise<SuperobjectiveStorageObject | null>;
  list(args?: {
    kind?: string;
    limit?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<SuperobjectiveStorageObjectRef[]>;
  search(args: {
    query: string;
    limit?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<SuperobjectiveStorageSearchHit[]>;
};

export type SuperobjectiveStateTraceRecord = {
  traceId: string;
  targetKind: string;
  targetId: string;
  metadata?: Record<string, JsonValue>;
  startedAt: string;
  endedAt?: string;
  summary?: Record<string, JsonValue>;
  events: Array<{
    ts: string;
    type: string;
    payload: Record<string, JsonValue>;
  }>;
};

export type SuperobjectiveState = {
  get<T extends JsonValue>(namespace: string, key: string): Promise<T | null>;
  put<T extends JsonValue>(namespace: string, key: string, value: T): Promise<void>;
  upsert<T extends JsonValue>(
    namespace: string,
    key: string,
    updater: T | ((current: T | null) => T),
  ): Promise<T>;
  delete(namespace: string, key: string): Promise<void>;
  list<T extends JsonValue>(args?: {
    namespace?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>>;
  startTrace(input: {
    traceId?: string;
    targetKind: string;
    targetId: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<{ traceId: string }>;
  appendTrace(
    traceId: string,
    event: {
      ts?: string;
      type: string;
      payload: Record<string, JsonValue>;
    },
  ): Promise<void>;
  finishTrace(traceId: string, summary?: Record<string, JsonValue>): Promise<void>;
  getTrace(traceId: string): Promise<SuperobjectiveStateTraceRecord | null>;
  listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<SuperobjectiveStateTraceRecord[]>;
};

export type SuperobjectiveApp = {
  id: string;
  storage: Record<string, SuperobjectiveStorageSpace>;
  state: SuperobjectiveState;
  destroy(): Promise<void>;
};

export type SuperobjectiveHostAdapter = {
  kind: string;
  createApp(options: SuperobjectiveCreateOptions): Promise<SuperobjectiveApp>;
  getApp(options: SuperobjectiveGetOptions): Promise<SuperobjectiveApp>;
  destroyApp(options: SuperobjectiveDestroyOptions): Promise<void>;
};

export type SuperobjectiveHost = {
  kind: string;
  create(options: SuperobjectiveCreateOptions): Promise<SuperobjectiveApp>;
  get(options: SuperobjectiveGetOptions): Promise<SuperobjectiveApp>;
  destroy(options: SuperobjectiveDestroyOptions): Promise<void>;
};

export function init(adapter: SuperobjectiveHostAdapter): SuperobjectiveHost {
  return {
    kind: adapter.kind,
    create(options) {
      return adapter.createApp(options);
    },
    get(options) {
      return adapter.getApp(options);
    },
    destroy(options) {
      return adapter.destroyApp(options);
    },
  };
}
