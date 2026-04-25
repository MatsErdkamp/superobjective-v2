import type {
  JsonValue,
  StreamAppendInput,
  StreamAppendResult,
  StreamEventEnvelope,
  StreamHistoryQuery,
  StreamReducedState,
} from "@superobjective/streams";

type AgentBaseLike = new (...args: any[]) => {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
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
      throw new Error("StreamDurableObject is only available in the Cloudflare runtime.");
    }
  }) as AgentBaseLike;

type StoredEventRow = {
  stream_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  event_json: string;
  idempotency_key: string | null;
  created_at: string;
};

type StoredStateRow = {
  stream_id: string;
  version: number;
  state_json: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `evt_${crypto.randomUUID()}`;
  }
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function badRequest(message: string): Response {
  return jsonResponse(400, {
    ok: false,
    error: message,
  });
}

function parseLimit(value: string | null, fallback: number, maximum: number): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function parseSequence(value: string | null): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function eventFromRow(row: StoredEventRow): StreamEventEnvelope {
  const parsed = JSON.parse(row.event_json) as Omit<StreamEventEnvelope, "sequence"> & {
    sequence?: number;
  };
  return {
    ...parsed,
    streamId: row.stream_id,
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.event_type,
    createdAt: row.created_at,
    ...(row.idempotency_key != null ? { idempotencyKey: row.idempotency_key } : {}),
  };
}

function stateFromRow(row: StoredStateRow): StreamReducedState {
  return {
    streamId: row.stream_id,
    version: row.version,
    state: JSON.parse(row.state_json) as JsonValue,
    updatedAt: row.updated_at,
  };
}

function mergeReducedState(current: JsonValue | null, event: StreamEventEnvelope): JsonValue {
  if (
    isRecord(event.payload) &&
    "$state" in event.payload &&
    isJsonValue(event.payload.$state)
  ) {
    return event.payload.$state;
  }

  if (
    isRecord(event.payload) &&
    "$patch" in event.payload &&
    isRecord(event.payload.$patch) &&
    (current == null || isRecord(current))
  ) {
    return {
      ...(isRecord(current) ? current : {}),
      ...event.payload.$patch,
    };
  }

  return {
    lastEvent: event,
  } satisfies JsonValue;
}

export class StreamDurableObject extends AgentBase {
  initialState = {
    ready: true,
  };

  constructor(state: unknown, env: unknown) {
    super(state, env);
    this.initSchema();
  }

  async onRequest(request: Request): Promise<Response> {
    return this.fetch(request);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/streams\/[^/]+/, "") || url.pathname;

    try {
      if (request.method === "POST" && (pathname === "/events" || pathname === "/append")) {
        return jsonResponse(200, await this.appendFromRequest(request));
      }

      if (request.method === "GET" && (pathname === "/events" || pathname === "/history")) {
        const query = this.queryFromUrl(url);
        return jsonResponse(200, {
          ok: true,
          events: this.getHistory(query),
        });
      }

      if (request.method === "GET" && pathname === "/state") {
        const streamId = url.searchParams.get("streamId");
        if (streamId == null || streamId.length === 0) {
          return badRequest('State requests require a "streamId" query parameter.');
        }
        const state = this.getState(streamId);
        if (state == null) {
          return jsonResponse(404, {
            ok: false,
            error: `Stream state "${streamId}" was not found.`,
          });
        }
        return jsonResponse(200, {
          ok: true,
          state,
        });
      }

      if (request.method === "PUT" && pathname === "/state") {
        return jsonResponse(200, {
          ok: true,
          state: await this.putStateFromRequest(request),
        });
      }

      if (request.method === "GET" && pathname === "/stream") {
        return this.streamNdjson(this.queryFromUrl(url));
      }

      return jsonResponse(404, {
        ok: false,
        error: `Stream route "${url.pathname}" was not found.`,
      });
    } catch (error) {
      return jsonResponse(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  append(input: StreamAppendInput): StreamAppendResult {
    this.validateAppendInput(input);

    const existing = this.findIdempotentEvent(input.streamId, input.idempotencyKey);
    if (existing != null) {
      return {
        event: existing,
        state: this.getState(input.streamId) ?? this.rebuildState(input.streamId),
        idempotent: true,
      };
    }

    const currentVersion = this.getCurrentVersion(input.streamId);
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      throw new Error(
        `Stream "${input.streamId}" is at version ${currentVersion}, not expected version ${input.expectedVersion}.`,
      );
    }

    const event: StreamEventEnvelope = {
      streamId: input.streamId,
      sequence: currentVersion + 1,
      eventId: input.eventId ?? createEventId(),
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? nowIso(),
      ...(input.idempotencyKey != null ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    };

    void this.sql`INSERT INTO events (
      stream_id,
      sequence,
      event_id,
      event_type,
      event_json,
      idempotency_key,
      created_at
    ) VALUES (
      ${event.streamId},
      ${event.sequence},
      ${event.eventId},
      ${event.type},
      ${JSON.stringify(event)},
      ${event.idempotencyKey ?? null},
      ${event.createdAt}
    )`;

    const state = this.reduceEvent(event);
    return {
      event,
      state,
      idempotent: false,
    };
  }

  getHistory(query: StreamHistoryQuery): StreamEventEnvelope[] {
    const after = query.after ?? 0;
    const limit = Math.min(query.limit ?? 100, 1_000);
    const rows = this.sql<StoredEventRow>`
      SELECT stream_id, sequence, event_id, event_type, event_json, idempotency_key, created_at
      FROM events
      WHERE stream_id = ${query.streamId} AND sequence > ${after}
      ORDER BY sequence ASC
      LIMIT ${limit}
    `;
    return rows.map(eventFromRow);
  }

  getState(streamId: string): StreamReducedState | null {
    const rows = this.sql<StoredStateRow>`
      SELECT stream_id, version, state_json, updated_at
      FROM reduced_state
      WHERE stream_id = ${streamId}
      LIMIT 1
    `;
    return rows[0] == null ? null : stateFromRow(rows[0]);
  }

  putState(state: StreamReducedState): StreamReducedState {
    void this.sql`INSERT OR REPLACE INTO reduced_state (
      stream_id,
      version,
      state_json,
      updated_at
    ) VALUES (
      ${state.streamId},
      ${state.version},
      ${JSON.stringify(state.state)},
      ${state.updatedAt}
    )`;
    return state;
  }

  private initSchema(): void {
    void this.sql`CREATE TABLE IF NOT EXISTS events (
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence)
    )`;
    void this.sql`CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_key
      ON events (stream_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL`;
    void this.sql`CREATE TABLE IF NOT EXISTS reduced_state (
      stream_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
  }

  private async appendFromRequest(request: Request): Promise<StreamAppendResult> {
    const input = (await request.json()) as StreamAppendInput;
    return this.append(input);
  }

  private async putStateFromRequest(request: Request): Promise<StreamReducedState> {
    const body = (await request.json()) as Partial<StreamReducedState>;
    if (typeof body.streamId !== "string" || body.streamId.length === 0) {
      throw new Error('Reduced state writes require a non-empty "streamId".');
    }
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0) {
      throw new Error('Reduced state writes require a non-negative integer "version".');
    }
    if (!isJsonValue(body.state)) {
      throw new Error('Reduced state writes require JSON-compatible "state".');
    }
    return this.putState({
      streamId: body.streamId,
      version: body.version,
      state: body.state,
      updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : nowIso(),
    });
  }

  private queryFromUrl(url: URL): StreamHistoryQuery {
    const streamId = url.searchParams.get("streamId");
    if (streamId == null || streamId.length === 0) {
      throw new Error('History requests require a "streamId" query parameter.');
    }
    const after = parseSequence(url.searchParams.get("after"));
    return {
      streamId,
      limit: parseLimit(url.searchParams.get("limit"), 100, 1_000),
      ...(after != null ? { after } : {}),
    };
  }

  private validateAppendInput(input: StreamAppendInput): void {
    if (typeof input.streamId !== "string" || input.streamId.length === 0) {
      throw new Error('Stream append requires a non-empty "streamId".');
    }
    if (typeof input.type !== "string" || input.type.length === 0) {
      throw new Error('Stream append requires a non-empty event "type".');
    }
    if (!isJsonValue(input.payload)) {
      throw new Error('Stream append requires JSON-compatible "payload".');
    }
    if (input.metadata != null && !isJsonValue(input.metadata)) {
      throw new Error('Stream append metadata must be JSON-compatible.');
    }
  }

  private getCurrentVersion(streamId: string): number {
    return this.getState(streamId)?.version ?? 0;
  }

  private findIdempotentEvent(
    streamId: string,
    idempotencyKey: string | undefined,
  ): StreamEventEnvelope | null {
    if (idempotencyKey == null) {
      return null;
    }
    const rows = this.sql<StoredEventRow>`
      SELECT stream_id, sequence, event_id, event_type, event_json, idempotency_key, created_at
      FROM events
      WHERE stream_id = ${streamId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] == null ? null : eventFromRow(rows[0]);
  }

  private reduceEvent(event: StreamEventEnvelope): StreamReducedState {
    const current = this.getState(event.streamId);
    const nextState = mergeReducedState(current?.state ?? null, event);
    const state: StreamReducedState = {
      streamId: event.streamId,
      version: event.sequence,
      state: nextState,
      updatedAt: event.createdAt,
    };
    return this.putState(state);
  }

  private rebuildState(streamId: string): StreamReducedState {
    const events = this.getHistory({
      streamId,
      limit: 1_000,
    });
    let state: StreamReducedState | null = null;
    for (const event of events) {
      const previousState: JsonValue | null = state == null ? null : state.state;
      state = {
        streamId,
        version: event.sequence,
        state: mergeReducedState(previousState, event),
        updatedAt: event.createdAt,
      };
    }
    if (state == null) {
      state = {
        streamId,
        version: 0,
        state: null,
        updatedAt: nowIso(),
      };
    }
    return this.putState(state);
  }

  private streamNdjson(query: StreamHistoryQuery): Response {
    const encoder = new TextEncoder();
    const events = this.getHistory(query);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });
  }
}

export type {
  JsonValue,
  StreamAppendInput,
  StreamAppendResult,
  StreamEventEnvelope,
  StreamHistoryQuery,
  StreamReducedState,
} from "@superobjective/streams";
