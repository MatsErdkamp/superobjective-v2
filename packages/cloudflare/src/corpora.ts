import { tool as defineTool, text as defineText } from "superobjective";
import { z } from "zod";

import type {
  AISearchInstanceLike,
  AISearchNamespaceLike,
  CloudflareEnvLike,
  CorpusDescriptorLike,
  CorpusFileHandleLike,
  CorpusProviderLike,
  CorpusRuntimeHandleLike,
  CorpusSearchChunkLike,
  CorpusSearchHandleLike,
  CorpusSearchResultLike,
  CorpusWorkspaceLike,
  ModelMessageLike,
  NormalizedProjectLike,
  R2BucketLike,
  RuntimeContextLike,
  ToolLike,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingCorpusError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /corpus/i.test(error.message) &&
    /(not found|unknown|missing)/i.test(error.message)
  );
}

function normalizePrefix(value: string | undefined): string {
  return (value ?? "").replace(/^\/+|\/+$/g, "");
}

function joinKey(prefix: string, path: string): string {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedPath = path.replace(/^\/+/, "");
  return normalizedPrefix.length === 0 ? normalizedPath : `${normalizedPrefix}/${normalizedPath}`;
}

function stripPrefix(value: string, prefix: string): string {
  const normalizedPrefix = normalizePrefix(prefix);
  if (normalizedPrefix.length === 0) {
    return value.replace(/^\/+/, "");
  }

  const expectedPrefix = `${normalizedPrefix}/`;
  if (value === normalizedPrefix) {
    return "";
  }
  if (value.startsWith(expectedPrefix)) {
    return value.slice(expectedPrefix.length);
  }
  return value;
}

function pathDirname(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

function isLikelyTextPath(path: string): boolean {
  return /\.(txt|md|json|jsonl|ndjson|csv|tsv|xml|yaml|yml|html|js|mjs|cjs|ts|mts|cts|jsx|tsx|py|sql)$/i.test(
    path,
  );
}

function messageToSearchText(message: ModelMessageLike): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return JSON.stringify(message.content);
}

function deriveSearchQuery(query: string | undefined, messages: ModelMessageLike[] | undefined): string {
  const normalized = query?.trim();
  if (normalized != null && normalized.length > 0) {
    return normalized;
  }

  const fromMessages = (messages ?? [])
    .map(messageToSearchText)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
  if (fromMessages.length > 0) {
    return fromMessages;
  }

  throw new Error("AI Search requires a query string or non-empty messages.");
}

function getUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toReadableText(value: unknown): Promise<string> | string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return new TextDecoder().decode(getUint8Array(value));
  }
  if (isRecord(value) && typeof value.text === "function") {
    return value.text() as Promise<string>;
  }
  if (isRecord(value) && typeof value.arrayBuffer === "function") {
    return (value.arrayBuffer() as Promise<ArrayBuffer>).then((buffer) =>
      new TextDecoder().decode(new Uint8Array(buffer)),
    );
  }
  return JSON.stringify(value);
}

async function toReadableBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return getUint8Array(value);
  }
  if (isRecord(value) && typeof value.arrayBuffer === "function") {
    const buffer = await (value.arrayBuffer() as Promise<ArrayBuffer>);
    return new Uint8Array(buffer);
  }
  if (isRecord(value) && typeof value.bytes === "function") {
    return (await value.bytes()) as Uint8Array;
  }
  if (isRecord(value) && typeof value.text === "function") {
    return new TextEncoder().encode(await (value.text() as Promise<string>));
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

async function normalizeSearchUploadContent(
  value: string | Uint8Array | ArrayBuffer | ReadableStream,
): Promise<string | Uint8Array | ArrayBuffer> {
  if (typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value;
  }

  const response = new Response(value);
  return new Uint8Array(await response.arrayBuffer());
}

async function listBucketKeys(bucket: R2BucketLike, prefix: string): Promise<string[]> {
  if (bucket.list == null) {
    return [];
  }
  const response = await bucket.list({
    prefix,
  });
  if (Array.isArray(response)) {
    return response.map((item) => (typeof item === "string" ? item : item.key));
  }
  return (response.objects ?? []).map((item) => item.key);
}

function resolveBucket(env: CloudflareEnvLike | undefined, binding: string): R2BucketLike {
  const candidate = env?.[binding];
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

  throw new Error(`R2 bucket binding "${binding}" was not found in the Cloudflare env.`);
}

function resolveSearchNamespace(
  env: CloudflareEnvLike | undefined,
  binding: string,
): AISearchNamespaceLike | null {
  const candidate = env?.[binding];
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

function extractSearchResults(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => isRecord(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["data", "results", "matches", "response", "items", "chunks"]) {
    if (Array.isArray(value[key])) {
      return extractSearchResults(value[key]);
    }
  }

  return [];
}

function extractChunkText(result: Record<string, unknown>): string {
  for (const key of ["text", "content", "snippet", "chunk", "body"]) {
    if (typeof result[key] === "string" && (result[key] as string).trim().length > 0) {
      return result[key] as string;
    }
  }

  if (isRecord(result.document)) {
    return extractChunkText(result.document as Record<string, unknown>);
  }

  return JSON.stringify(result);
}

function extractChunkMetadata(result: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["metadata", "attributes"]) {
    if (isRecord(result[key])) {
      return result[key] as Record<string, unknown>;
    }
  }
  return undefined;
}

function extractChunkKey(
  result: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  for (const key of ["path", "filename", "file", "key"]) {
    if (typeof result[key] === "string") {
      return result[key] as string;
    }
  }

  if (metadata != null) {
    for (const key of ["path", "filename", "file", "key", "object_id"]) {
      if (typeof metadata[key] === "string") {
        return metadata[key] as string;
      }
    }
  }

  if (typeof result.id === "string") {
    return result.id;
  }

  if (metadata != null && typeof metadata.id === "string") {
    return metadata.id as string;
  }

  return undefined;
}

function extractChunkScore(result: Record<string, unknown>): number | undefined {
  for (const key of ["score", "relevance", "distance"]) {
    if (typeof result[key] === "number") {
      return result[key] as number;
    }
  }
  return undefined;
}

function normalizeSearchResult(
  response: unknown,
  query: string,
): CorpusSearchResultLike {
  const chunks = extractSearchResults(response).map((result, index) => {
    const metadata = extractChunkMetadata(result);
    const key = extractChunkKey(result, metadata);
    const score = extractChunkScore(result);
    const chunk: CorpusSearchChunkLike = {
      id:
        typeof result.id === "string"
          ? result.id
          : key ?? `chunk_${index + 1}`,
      text: extractChunkText(result),
      ...(typeof result.type === "string" ? { type: result.type } : {}),
      ...(score != null ? { score } : {}),
      ...(key != null || metadata != null
        ? {
            item: {
              ...(key != null ? { key } : {}),
              ...(metadata != null ? { metadata } : {}),
            },
          }
        : {}),
      ...(metadata != null ? { metadata } : {}),
    };
    return chunk;
  });

  return {
    query,
    chunks,
    raw: response,
  };
}

function toCorpusArray(
  value:
    | Iterable<CorpusDescriptorLike>
    | Map<string, CorpusDescriptorLike>
    | NormalizedProjectLike
    | undefined,
): CorpusDescriptorLike[] {
  if (value == null) {
    return [];
  }
  if (value instanceof Map) {
    return [...value.values()];
  }
  if (Symbol.iterator in Object(value) && !("programs" in Object(value))) {
    return [...(value as Iterable<CorpusDescriptorLike>)];
  }
  return [...((value as NormalizedProjectLike).corpora?.values() ?? [])];
}

function buildCorpusMap(
  value:
    | Iterable<CorpusDescriptorLike>
    | Map<string, CorpusDescriptorLike>
    | NormalizedProjectLike
    | undefined,
): Map<string, CorpusDescriptorLike> {
  return new Map(
    toCorpusArray(value).map((entry) => [entry.id, entry] as const),
  );
}

function createCorpusFileHandle(
  corpus: CorpusDescriptorLike,
  env: CloudflareEnvLike | undefined,
): CorpusFileHandleLike {
  const bucket = resolveBucket(env, corpus.storage.bucketBinding);
  const storagePrefix = normalizePrefix(corpus.storage.prefix);

  return {
    async list(prefix) {
      const lookupPrefix = joinKey(storagePrefix, prefix ?? "");
      const keys = await listBucketKeys(bucket, lookupPrefix);
      return keys
        .map((key) => stripPrefix(key, storagePrefix))
        .filter((key) => key.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    async getText(path) {
      const key = joinKey(storagePrefix, path);
      const value = await bucket.get(key);
      if (value == null) {
        throw new Error(`Corpus file "${path}" was not found in corpus "${corpus.id}".`);
      }
      return toReadableText(value);
    },
    async getBytes(path) {
      const key = joinKey(storagePrefix, path);
      const value = await bucket.get(key);
      if (value == null) {
        throw new Error(`Corpus file "${path}" was not found in corpus "${corpus.id}".`);
      }
      return toReadableBytes(value);
    },
    async head(path) {
      const key = joinKey(storagePrefix, path);
      const value = await bucket.get(key);
      if (value == null) {
        return null;
      }

      if (typeof value === "string") {
        return {
          size: new TextEncoder().encode(value).byteLength,
        };
      }

      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return {
          size: getUint8Array(value).byteLength,
        };
      }

      if (isRecord(value)) {
        return {
          ...(typeof value.size === "number" ? { size: value.size } : {}),
          ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
          ...(isRecord(value.customMetadata)
            ? { metadata: value.customMetadata as Record<string, unknown> }
            : {}),
        };
      }

      return null;
    },
  };
}

function createCorpusSearchHandle(
  corpus: CorpusDescriptorLike,
  env: CloudflareEnvLike | undefined,
): CorpusSearchHandleLike | undefined {
  if (corpus.retrieval == null) {
    return undefined;
  }

  return {
    async search(args) {
      const namespace = resolveSearchNamespace(env, corpus.retrieval!.binding);
      if (namespace == null) {
        throw new Error(
          `AI Search binding "${corpus.retrieval!.binding}" was not found for corpus "${corpus.id}".`,
        );
      }

      const query = deriveSearchQuery(args.query, args.messages);
      const instance = namespace.get(corpus.retrieval!.instanceId);
      const response = await instance.search({
        query,
        ...(args.maxResults != null ? { max_num_results: Math.max(args.maxResults, 1) } : {}),
        ...(args.filters != null ? { filters: args.filters } : {}),
        ...(args.instanceIds != null ? { instance_ids: args.instanceIds } : {}),
      });
      return normalizeSearchResult(response, query);
    },
    async info() {
      const namespace = resolveSearchNamespace(env, corpus.retrieval!.binding);
      if (namespace == null) {
        return null;
      }
      return namespace.get(corpus.retrieval!.instanceId).info();
    },
    async upload(name, content, options) {
      const namespace = resolveSearchNamespace(env, corpus.retrieval!.binding);
      if (namespace == null) {
        throw new Error(
          `AI Search binding "${corpus.retrieval!.binding}" was not found for corpus "${corpus.id}".`,
        );
      }

      const instance = namespace.get(corpus.retrieval!.instanceId);
      const normalizedContent = await normalizeSearchUploadContent(content);
      const upload = options?.waitUntilIndexed === true ? undefined : instance.items.upload;
      if (typeof upload === "function") {
        return upload.call(instance.items, name, normalizedContent, {
          ...(options?.metadata != null ? { metadata: options.metadata } : {}),
        });
      }

      return instance.items.uploadAndPoll(name, normalizedContent, {
        ...(options?.metadata != null ? { metadata: options.metadata } : {}),
      });
    },
  };
}

export class CloudflareCorpusProvider implements CorpusProviderLike<CloudflareEnvLike> {
  private readonly corpora: Map<string, CorpusDescriptorLike>;
  private readonly env: CloudflareEnvLike | undefined;

  constructor(
    corpora:
      | Iterable<CorpusDescriptorLike>
      | Map<string, CorpusDescriptorLike>
      | NormalizedProjectLike,
    env?: CloudflareEnvLike,
  ) {
    this.corpora = buildCorpusMap(corpora);
    this.env = env;
  }

  withEnv(env: CloudflareEnvLike): CloudflareCorpusProvider {
    return new CloudflareCorpusProvider(this.corpora, env);
  }

  async resolve(corpusId: string): Promise<CorpusRuntimeHandleLike> {
    const corpus = this.corpora.get(corpusId);
    if (corpus == null) {
      throw new Error(`Corpus "${corpusId}" was not found.`);
    }

    const files = createCorpusFileHandle(corpus, this.env);
    const search = createCorpusSearchHandle(corpus, this.env);

    return {
      corpus,
      files,
      ...(search != null ? { search } : {}),
      materializeToWorkspace: async (args) => {
        const selectedPaths = [...new Set(args.paths ?? (await files.list()))];
        const destinationPrefix = normalizePrefix(args.destinationPrefix) || corpus.id;

        for (const path of selectedPaths) {
          const destinationPath = joinKey(destinationPrefix, path);
          const directory = pathDirname(destinationPath);
          if (directory.length > 0 && typeof args.workspace.mkdir === "function") {
            await args.workspace.mkdir(directory, {
              recursive: true,
            });
          }

          if (isLikelyTextPath(path)) {
            await args.workspace.writeText(destinationPath, await files.getText(path));
          } else {
            await args.workspace.writeBytes(destinationPath, await files.getBytes(path));
          }
        }

        return {
          corpusId: corpus.id,
          destinationPrefix,
          files: selectedPaths,
        };
      },
    };
  }

  async list(): Promise<CorpusDescriptorLike[]> {
    return [...this.corpora.values()];
  }
}

export function createCorpusProvider(args: {
  corpora:
    | Iterable<CorpusDescriptorLike>
    | Map<string, CorpusDescriptorLike>
    | NormalizedProjectLike;
  env?: CloudflareEnvLike;
}): CorpusProviderLike<CloudflareEnvLike> {
  return new CloudflareCorpusProvider(args.corpora, args.env);
}

export function createProjectCorpusProvider(
  project: NormalizedProjectLike,
  env?: CloudflareEnvLike,
): CorpusProviderLike<CloudflareEnvLike> {
  return new CloudflareCorpusProvider(project, env);
}

export function mergeCorpusProviders(
  ...providers: Array<CorpusProviderLike<CloudflareEnvLike> | undefined>
): CorpusProviderLike<CloudflareEnvLike> | undefined {
  const available = providers.filter(
    (provider): provider is CorpusProviderLike<CloudflareEnvLike> => provider != null,
  );
  if (available.length === 0) {
    return undefined;
  }
  if (available.length === 1) {
    return available[0];
  }

  return {
    withEnv(env) {
      const rebound = mergeCorpusProviders(
        ...available.map((provider) => provider.withEnv?.(env) ?? provider),
      );
      return rebound ?? available[0]!;
    },
    async resolve(corpusId) {
      let lastError: unknown;
      for (const provider of available) {
        try {
          return await provider.resolve(corpusId);
        } catch (error) {
          if (!isMissingCorpusError(error)) {
            throw error;
          }
          lastError = error;
        }
      }

      throw lastError ?? new Error(`Corpus "${corpusId}" was not found.`);
    },
    async list() {
      const merged = new Map<string, CorpusDescriptorLike>();
      for (const provider of available) {
        if (provider.list == null) {
          continue;
        }
        for (const corpus of await provider.list()) {
          if (!merged.has(corpus.id)) {
            merged.set(corpus.id, corpus);
          }
        }
      }
      return [...merged.values()];
    },
  };
}

export function bindProjectCorporaRuntime(
  runtime: RuntimeContextLike,
  project: NormalizedProjectLike,
  env?: CloudflareEnvLike,
): RuntimeContextLike {
  const projectProvider = createProjectCorpusProvider(project, env);
  const mergedProvider = mergeCorpusProviders(projectProvider, runtime.corpora);
  return mergedProvider == null
    ? runtime
    : {
        ...runtime,
        corpora: mergedProvider,
      };
}

export async function prepareCorpusContext(args: {
  provider: CorpusProviderLike<CloudflareEnvLike>;
  corpusIds: string[];
  workspace?: CorpusWorkspaceLike;
  pathsByCorpus?: Record<string, string[]>;
  destinationPrefix?: string;
  includeSearchInfo?: boolean;
}): Promise<{
  preparedAt: string;
  manifest: {
    corpusIds: string[];
    corpora: Array<{
      id: string;
      storage: CorpusDescriptorLike["storage"];
      retrieval?: CorpusDescriptorLike["retrieval"];
      metadata?: Record<string, unknown>;
      search?: {
        available: boolean;
        info?: unknown;
      };
      materialized?: {
        destinationPrefix: string;
        files: string[];
      };
    }>;
  };
}> {
  const corpora = await Promise.all(
    args.corpusIds.map(async (corpusId) => {
      const handle = await args.provider.resolve(corpusId);
      const searchInfo =
        args.includeSearchInfo === true && handle.search?.info != null
          ? await handle.search.info()
          : undefined;
      const materialized =
        args.workspace != null && handle.materializeToWorkspace != null
          ? await handle.materializeToWorkspace({
              workspace: args.workspace,
              ...(args.pathsByCorpus?.[corpusId] != null
                ? { paths: args.pathsByCorpus[corpusId] }
                : {}),
              ...(args.destinationPrefix != null
                ? { destinationPrefix: joinKey(args.destinationPrefix, corpusId) }
                : {}),
            })
          : undefined;

      return {
        id: handle.corpus.id,
        storage: handle.corpus.storage,
        ...(handle.corpus.retrieval != null ? { retrieval: handle.corpus.retrieval } : {}),
        ...(handle.corpus.metadata != null ? { metadata: handle.corpus.metadata } : {}),
        search: {
          available: handle.search != null,
          ...(searchInfo !== undefined ? { info: searchInfo } : {}),
        },
        ...(materialized != null
          ? {
              materialized: {
                destinationPrefix: materialized.destinationPrefix,
                files: materialized.files,
              },
            }
          : {}),
      };
    }),
  );

  return {
    preparedAt: new Date().toISOString(),
    manifest: {
      corpusIds: args.corpusIds,
      corpora,
    },
  };
}

function requireCorpusProvider(runtime: { corpora?: unknown }): CorpusProviderLike<CloudflareEnvLike> {
  if (
    runtime.corpora == null ||
    typeof runtime.corpora !== "object" ||
    !("resolve" in runtime.corpora) ||
    typeof (runtime.corpora as { resolve?: unknown }).resolve !== "function"
  ) {
    throw new Error("No corpus provider is configured on the runtime context.");
  }
  return runtime.corpora as CorpusProviderLike<CloudflareEnvLike>;
}

export function createListCorpusFilesTool(
  corpusId: string,
  options?: {
    name?: string;
    description?: string;
  },
): ToolLike<{ prefix?: string }, { corpusId: string; files: string[] }> {
  return defineTool({
    name: options?.name ?? `list_${corpusId}_files`,
    description: defineText({
      value:
        options?.description ?? `List files available in the "${corpusId}" corpus.`,
    }),
    input: z.object({
      prefix: z.string().optional(),
    }),
    output: z.object({
      corpusId: z.string(),
      files: z.array(z.string()),
    }),
    async execute(input, ctx) {
      const provider = requireCorpusProvider(ctx.runtime);
      const corpus = await provider.resolve(corpusId);
      return {
        corpusId,
        files: await corpus.files.list(input.prefix),
      };
    },
  }) as ToolLike<{ prefix?: string }, { corpusId: string; files: string[] }>;
}

export function createReadCorpusFileTool(
  corpusId: string,
  options?: {
    name?: string;
    description?: string;
  },
): ToolLike<{ path: string }, { corpusId: string; path: string; content: string }> {
  return defineTool({
    name: options?.name ?? `read_${corpusId}_file`,
    description: defineText({
      value:
        options?.description ?? `Read a text file from the "${corpusId}" corpus.`,
    }),
    input: z.object({
      path: z.string().min(1),
    }),
    output: z.object({
      corpusId: z.string(),
      path: z.string(),
      content: z.string(),
    }),
    async execute(input, ctx) {
      const provider = requireCorpusProvider(ctx.runtime);
      const corpus = await provider.resolve(corpusId);
      return {
        corpusId,
        path: input.path,
        content: await corpus.files.getText(input.path),
      };
    },
  }) as ToolLike<{ path: string }, { corpusId: string; path: string; content: string }>;
}

export function createSearchCorpusTool(
  corpusId: string,
  options?: {
    name?: string;
    description?: string;
  },
): ToolLike<
  {
    query?: string;
    messages?: ModelMessageLike[];
    filters?: Record<string, unknown>;
    maxResults?: number;
  },
  CorpusSearchResultLike
> {
  return defineTool({
    name: options?.name ?? `search_${corpusId}`,
    description: defineText({
      value:
        options?.description ?? `Search the "${corpusId}" corpus using AI Search.`,
    }),
    input: z.object({
      query: z.string().optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.any(),
            name: z.string().optional(),
            toolCallId: z.string().optional(),
          }),
        )
        .optional(),
      filters: z.record(z.string(), z.any()).optional(),
      maxResults: z.number().int().positive().optional(),
    }),
    output: z.object({
      query: z.string().optional(),
      chunks: z.array(
        z.object({
          id: z.string(),
          type: z.string().optional(),
          score: z.number().optional(),
          text: z.string(),
          item: z
            .object({
              key: z.string().optional(),
              timestamp: z.number().optional(),
              metadata: z.record(z.string(), z.any()).optional(),
            })
            .optional(),
          scoringDetails: z.record(z.string(), z.any()).optional(),
          metadata: z.record(z.string(), z.any()).optional(),
        }),
      ),
      raw: z.any().optional(),
    }),
    async execute(input, ctx) {
      const provider = requireCorpusProvider(ctx.runtime);
      const corpus = await provider.resolve(corpusId);
      if (corpus.search == null) {
        throw new Error(`Corpus "${corpusId}" does not have AI Search configured.`);
      }
      const messages = Array.isArray(input.messages)
        ? input.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(typeof message.name === "string" ? { name: message.name } : {}),
            ...(typeof message.toolCallId === "string"
              ? { toolCallId: message.toolCallId }
              : {}),
          }))
        : undefined;
      return corpus.search.search({
        ...(typeof input.query === "string" ? { query: input.query } : {}),
        ...(messages != null ? { messages } : {}),
        ...(input.filters != null ? { filters: input.filters } : {}),
        ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
      });
    },
  }) as ToolLike<
    {
      query?: string;
      messages?: ModelMessageLike[];
      filters?: Record<string, unknown>;
      maxResults?: number;
    },
    CorpusSearchResultLike
  >;
}
