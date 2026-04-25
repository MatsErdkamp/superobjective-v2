export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type StreamEventEnvelope<
  TType extends string = string,
  TPayload extends JsonValue = JsonValue,
> = {
  streamId: string;
  sequence: number;
  eventId: string;
  type: TType;
  payload: TPayload;
  createdAt: string;
  idempotencyKey?: string;
  metadata?: Record<string, JsonValue>;
};

export type StreamAppendInput<
  TType extends string = string,
  TPayload extends JsonValue = JsonValue,
> = {
  streamId: string;
  type: TType;
  payload: TPayload;
  eventId?: string;
  idempotencyKey?: string;
  createdAt?: string;
  expectedVersion?: number;
  metadata?: Record<string, JsonValue>;
};

export type StreamReducedState<TState extends JsonValue = JsonValue> = {
  streamId: string;
  version: number;
  state: TState;
  updatedAt: string;
};

export type StreamReducer<
  TState extends JsonValue = JsonValue,
  TEvent extends StreamEventEnvelope = StreamEventEnvelope,
> = (state: TState | null, event: TEvent) => TState;

export type StreamHistoryQuery = {
  streamId: string;
  after?: number;
  limit?: number;
};

export type StreamAppendResult<
  TState extends JsonValue = JsonValue,
  TEvent extends StreamEventEnvelope = StreamEventEnvelope,
> = {
  event: TEvent;
  state: StreamReducedState<TState>;
  idempotent: boolean;
};

export type StreamClientContract<
  TState extends JsonValue = JsonValue,
  TEvent extends StreamEventEnvelope = StreamEventEnvelope,
  TAppend extends StreamAppendInput = StreamAppendInput,
> = {
  append(input: TAppend): Promise<StreamAppendResult<TState, TEvent>>;
  getState(streamId: string): Promise<StreamReducedState<TState> | null>;
  getHistory(query: StreamHistoryQuery): Promise<TEvent[]>;
  streamHistory?(query: StreamHistoryQuery): AsyncIterable<TEvent>;
};

export function reduceStreamEvents<
  TState extends JsonValue,
  TEvent extends StreamEventEnvelope = StreamEventEnvelope,
>(
  initialState: TState | null,
  events: Iterable<TEvent>,
  reducer: StreamReducer<TState, TEvent>,
): StreamReducedState<TState> | null {
  let state = initialState;
  let lastEvent: TEvent | null = null;

  for (const event of events) {
    state = reducer(state, event);
    lastEvent = event;
  }

  if (lastEvent == null || state == null) {
    return null;
  }

  return {
    streamId: lastEvent.streamId,
    version: lastEvent.sequence,
    state,
    updatedAt: lastEvent.createdAt,
  };
}

export async function* parseNdjsonStream<TEvent extends StreamEventEnvelope = StreamEventEnvelope>(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<TEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield JSON.parse(line) as TEvent;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = `${buffer}${decoder.decode()}`.trim();
    if (tail.length > 0) {
      yield JSON.parse(tail) as TEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createHttpStreamClient<
  TState extends JsonValue = JsonValue,
  TEvent extends StreamEventEnvelope = StreamEventEnvelope,
>(options: {
  baseUrl: string | URL;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}): StreamClientContract<TState, TEvent> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = new URL(options.baseUrl);

  function requestInit(init: RequestInit = {}): RequestInit {
    if (options.headers == null && init.headers == null) {
      return init;
    }

    const headers = new Headers(options.headers);
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    return {
      ...init,
      headers,
    };
  }

  function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): URL {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`Stream request failed with ${response.status} ${response.statusText}.`);
    }
    return (await response.json()) as T;
  }

  return {
    async append(input) {
      const response = await fetchImpl(
        buildUrl("/events"),
        requestInit({
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        }),
      );
      return readJson<StreamAppendResult<TState, TEvent>>(response);
    },
    async getState(streamId) {
      const response = await fetchImpl(buildUrl("/state", { streamId }), requestInit());
      if (response.status === 404) {
        return null;
      }
      const body = await readJson<{ state: StreamReducedState<TState> | null }>(response);
      return body.state;
    },
    async getHistory(query) {
      const response = await fetchImpl(buildUrl("/events", query), requestInit());
      const body = await readJson<{ events: TEvent[] }>(response);
      return body.events;
    },
    async *streamHistory(query) {
      const response = await fetchImpl(
        buildUrl("/stream", query),
        requestInit({
          headers: {
            accept: "application/x-ndjson",
          },
        }),
      );
      if (!response.ok || response.body == null) {
        throw new Error(`Stream request failed with ${response.status} ${response.statusText}.`);
      }
      yield* parseNdjsonStream<TEvent>(response.body);
    },
  };
}
