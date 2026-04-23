import {
  buildToolDefinition,
  getOutputSchema,
  getTargetId,
  nowIso,
  serializeError,
  stableStringify,
  validateWithSchema,
} from "@superobjective/hosting";
import type {
  RLMExecuteStepRequest,
  RLMExecuteStepResult,
  RLMHistoryEntry,
  RLMPreparedContext,
  RLMQueryProvider,
  RLMResource,
  RLMRuntime,
  RLMSessionCheckpoint,
  RLMSession,
  Tool,
} from "superobjective";

import { createCorpusProvider, mergeCorpusProviders, prepareCorpusContext } from "./corpora";
import { compileRlmStep, type CompiledRlmStep } from "./rlm-step";
import type {
  CloudflareEnvLike,
  CorpusDescriptorLike,
  CorpusProviderLike,
  CorpusRuntimeHandleLike,
  CorpusWorkspaceLike,
  RuntimeContextLike,
  ToolLike,
} from "./types";

type RlmCorpusInput =
  | CorpusProviderLike<CloudflareEnvLike>
  | Iterable<CorpusDescriptorLike>
  | Map<string, CorpusDescriptorLike>;

type Executor = {
  execute(
    code: string,
    providers:
      | Array<{
          name: string;
          fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
          positionalArgs?: boolean;
        }>
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<{
    result: unknown;
    error?: string;
    logs?: string[];
  }>;
};

type ResolvedProvider = {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
};

type DynamicWorkerExecutorCtor = new (options: {
  loader: unknown;
  timeout?: number;
  globalOutbound?: unknown;
  modules?: Record<string, string>;
}) => Executor;

export type CloudflareRlmRuntimeOptions = {
  executor?: Executor;
  env?: CloudflareEnvLike;
  runtime?: RuntimeContextLike;
  hostedSessionManager?: CloudflareHostedRlmSessionManager;
  corpora?: RlmCorpusInput;
  corpusIds?: string[] | ((input: Record<string, unknown>) => string[]);
  pathsByCorpus?:
    | Record<string, string[]>
    | ((input: Record<string, unknown>) => Record<string, string[]> | undefined);
  destinationPrefix?: string;
  includeSearchInfo?: boolean;
  workspace?: CorpusWorkspaceLike;
  loaderBinding?: string;
  timeoutMs?: number;
  globalOutbound?: unknown;
  modules?: Record<string, string>;
  inlineStringChars?: number;
  previewChars?: number;
};

export type CloudflareHostedRlmSessionHandle = {
  init(args: {
    runId: string;
    moduleId: string;
    preparedContext: RLMPreparedContext;
    inlineInputs: Record<string, unknown>;
    textResources: Record<string, string>;
    corpusIds: string[];
    tools: Array<{
      name: string;
      description?: string;
    }>;
  }): Promise<void>;
  describe(): Promise<{
    trackedNames: string[];
  }>;
  step(args: {
    compiled: CompiledRlmStep;
    request: Pick<RLMExecuteStepRequest, "code" | "maxOutputChars" | "maxQueryCalls" | "queryCallsUsed">;
  }): Promise<RLMExecuteStepResult>;
  checkpoint(checkpoint: RLMSessionCheckpoint): Promise<void>;
  resume(): Promise<RLMSessionCheckpoint | null>;
  close(): Promise<void>;
};

export type CloudflareHostedRlmSessionManager = {
  openSession(args: {
    runId: string;
    moduleId: string;
    env?: CloudflareEnvLike;
    runtime?: RuntimeContextLike;
    provider?: CorpusProviderLike<CloudflareEnvLike>;
    tools: Tool<any, any>[];
    options: CloudflareRlmRuntimeOptions;
  }): Promise<CloudflareHostedRlmSessionHandle>;
  deleteSession?(runId: string): Promise<void>;
};

type LoadedTextResource = {
  path: string;
  storage: "prepared" | "corpus";
  text: string;
  totalChars: number;
  preview: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "resource";
}

function sanitizeToolName(name: string): string {
  const sanitized = name
    .replace(/[-.\s]+/g, "_")
    .replace(/[^a-zA-Z0-9_$]/g, "")
    .replace(/^[0-9]/, "_$&");
  return sanitized.length > 0 ? sanitized : "tool";
}

function isValidJsIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function truncatePreview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(maxChars - 1, 1))}…`;
}

function chunkContextSummary(label: string, items: string[]): string {
  if (items.length === 0) {
    return `${label}: none`;
  }
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function summarizeVariablesInfo(args: {
  inlineInputs: Record<string, unknown>;
  resources: RLMResource[];
  corpora: Array<{ id: string }>;
}): string {
  const lines = [
    "The REPL exposes an `inputs` object containing inline input values.",
    "Use `inputs.<field>` or `await getInput('<field>')` to read inline inputs. Inline inputs are not injected as direct top-level variables, so your code may safely declare local bindings with the same names.",
    ...Object.keys(args.inlineInputs)
      .sort((left, right) => left.localeCompare(right))
      .filter((key) => isValidJsIdentifier(key))
      .map((key) => {
      const value = args.inlineInputs[key];
      const valueType =
        value == null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
      return `Inline input \`${key}\` is available under inputs[${JSON.stringify(key)}] (${valueType}).`;
    }),
    ...args.resources.map(
      (resource) =>
        `Prepared resource \`${resource.name}\` is not injected as a variable. Access it through ${resource.path} using listResources/readText/searchText.`,
    ),
    ...args.corpora.map(
      (corpus) =>
        `Configured corpus \`${corpus.id}\` is available through listCorpusFiles/readCorpusFile/searchCorpus under /corpora/${encodeURIComponent(corpus.id)}/.`,
    ),
  ];

  return lines.join("\n");
}

function pathMatchForCorpus(path: string): { corpusId: string; relativePath: string } | null {
  const match = /^\/corpora\/([^/]+)\/(.+)$/.exec(path);
  if (match == null) {
    return null;
  }
  return {
    corpusId: decodeURIComponent(match[1]!),
    relativePath: match[2]!,
  };
}

function readTextSlice(
  text: string,
  options: {
    startChar?: number;
    maxChars?: number;
  },
  fallbackMaxChars: number,
) {
  const startChar = Math.max(0, Math.min(text.length, options.startChar ?? 0));
  const maxChars = Math.max(1, Math.min(options.maxChars ?? fallbackMaxChars, fallbackMaxChars));
  const endChar = Math.min(text.length, startChar + maxChars);

  return {
    startChar,
    endChar,
    totalChars: text.length,
    truncated: endChar < text.length,
    text: text.slice(startChar, endChar),
  };
}

function searchWithinText(
  path: string,
  text: string,
  query: string,
  options: {
    caseSensitive?: boolean;
    maxResults?: number;
    contextChars?: number;
  },
) {
  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const maxResults = Math.max(1, options.maxResults ?? 5);
  const contextChars = Math.max(0, options.contextChars ?? 80);
  const matches: Array<{
    path: string;
    startChar: number;
    endChar: number;
    match: string;
    snippet: string;
  }> = [];

  if (needle.length === 0) {
    return {
      path,
      query,
      matches,
      truncated: false,
    };
  }

  let cursor = 0;
  while (matches.length < maxResults) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      break;
    }

    const startChar = index;
    const endChar = index + needle.length;
    const snippetStart = Math.max(0, startChar - contextChars);
    const snippetEnd = Math.min(text.length, endChar + contextChars);
    matches.push({
      path,
      startChar,
      endChar,
      match: text.slice(startChar, endChar),
      snippet: text.slice(snippetStart, snippetEnd),
    });
    cursor = endChar;
  }

  return {
    path,
    query,
    matches,
    truncated: false,
  };
}

function summarizeAvailableTools(args: {
  customTools: Array<{ name: string; description?: string }>;
  corpusIds: string[];
}): string {
  const builtin = [
    "SUBMIT(output): finalize the typed result.",
    "print(...args): write concrete observations to the step log.",
    "getManifest(): inspect the prepared context manifest.",
    "listResources(): list prepared non-inline resources.",
    "getInput(key?): inspect prepared inline input values.",
    "query(prompt, options?): semantic helper query via the configured query provider.",
    "llm_query(prompt, options?): alias for query(prompt, options).",
    "queryBatch(prompts, options?): batched semantic helper queries.",
    "llm_query_batched(prompts, options?): alias for queryBatch(prompts, options).",
    "getTextInfo(path): inspect a prepared or corpus-backed text resource.",
    "readText(path, options?): read a bounded slice from a prepared or corpus-backed text resource.",
    "searchText(path, query, options?): lexical search inside a prepared or corpus-backed text resource.",
    "readMatchWindow(path, match, options?): read a bounded window around a lexical match.",
    "listCorpusFiles(corpusId, prefix?): list logical files in a configured corpus.",
    "readCorpusFile(corpusId, path): read a full corpus text file.",
    "searchCorpus(corpusId, args): run AI Search over a configured corpus.",
  ];

  const sections = [
    chunkContextSummary("Builtins", builtin),
    chunkContextSummary(
      "Configured corpora",
      args.corpusIds.map((corpusId) => `${corpusId} (logical root /corpora/${encodeURIComponent(corpusId)}/...)`),
    ),
    chunkContextSummary(
      "Custom tools",
      args.customTools.map((tool) =>
        tool.description != null && tool.description.length > 0 ? `${tool.name}: ${tool.description}` : tool.name,
      ),
    ),
    "Session state may persist across steps in the current run. Reuse top-level variables when they already exist, but rely on `inputs`, `getInput`, and resource paths when you need to rehydrate state after a failure or recovery.",
  ];

  return sections.join("\n\n");
}

function buildReplayProgram(
  previousCells: string[],
  currentCode: string,
  toolNames: string[],
): string {
  const toolAliases = toolNames.map((name) => {
    const identifier = sanitizeToolName(name);
    return `const ${identifier} = async (args = {}) => tools.${identifier}(args);`;
  });

  return [
    "async () => {",
    "  let __submitted;",
    "  const SUBMIT = async (value) => { __submitted = value; return value; };",
    "  const print = (...args) => console.log(...args);",
    "  const getManifest = async () => rlm.getManifest({});",
    "  const listResources = async () => rlm.listResources({});",
    "  const getInput = async (key) => rlm.getInput(key == null ? {} : { key });",
    "  const inputs = await rlm.getInput({});",
    "  const query = async (prompt, options) => rlm.query({ prompt, options });",
    "  const llm_query = async (prompt, options) => rlm.query({ prompt, options });",
    "  const queryBatch = async (prompts, options) => rlm.queryBatch({ prompts, options });",
    "  const llm_query_batched = async (prompts, options) => rlm.queryBatch({ prompts, options });",
    "  const getTextInfo = async (path) => rlm.getTextInfo({ path });",
    "  const readText = async (path, options = {}) => rlm.readText({ path, ...(options ?? {}) });",
    "  const searchText = async (path, query, options = {}) => rlm.searchText({ path, query, ...(options ?? {}) });",
    "  const readMatchWindow = async (path, match, options = {}) => rlm.readMatchWindow({ path, match, ...(options ?? {}) });",
    "  const listCorpusFiles = async (corpusId, prefix) => rlm.listCorpusFiles(prefix == null ? { corpusId } : { corpusId, prefix });",
    "  const readCorpusFile = async (corpusId, path) => rlm.readCorpusFile({ corpusId, path });",
    "  const searchCorpus = async (corpusId, args = {}) => rlm.searchCorpus({ corpusId, ...(args ?? {}) });",
    ...toolAliases.map((line) => `  ${line}`),
    "",
    "  await rlm.__setPhase({ phase: 'replay' });",
    ...previousCells.flatMap((cell) => [`  ${cell}`, "  __submitted = undefined;", ""]),
    "  await rlm.__setPhase({ phase: 'current' });",
    `  ${currentCode}`,
    "",
    "  return { submitted: __submitted };",
    "}",
  ].join("\n");
}

function resolveCorpusProvider(args: {
  runtime?: RuntimeContextLike;
  env?: CloudflareEnvLike;
  corpora?: RlmCorpusInput;
}): CorpusProviderLike<CloudflareEnvLike> | undefined {
  const configured =
    args.corpora == null
      ? undefined
      : typeof (args.corpora as { resolve?: unknown }).resolve === "function"
        ? (args.corpora as CorpusProviderLike<CloudflareEnvLike>)
        : createCorpusProvider({
            corpora: args.corpora as Iterable<CorpusDescriptorLike> | Map<string, CorpusDescriptorLike>,
            ...(args.env ? { env: args.env } : {}),
          });

  return mergeCorpusProviders(configured, args.runtime?.corpora);
}

type PreparedSessionBundle = {
  preparedContext: RLMPreparedContext;
  inlineInputs: Record<string, unknown>;
  textResources: Record<string, string>;
  corpusIds: string[];
};

async function prepareSessionBundle(args: {
  runId: string;
  moduleId: string;
  input: Record<string, unknown>;
  provider?: CorpusProviderLike<CloudflareEnvLike>;
  options: CloudflareRlmRuntimeOptions;
  tools: Tool<any, any>[];
}): Promise<PreparedSessionBundle> {
  const contextRoot = `/context/${safePathSegment(args.runId)}`;
  const manifestPath = `${contextRoot}/_manifest.json`;
  const inlineInputs: Record<string, unknown> = {};
  const textResources = new Map<string, string>();
  const resources: RLMResource[] = [];
  const previewChars = args.options.previewChars ?? 240;
  const inlineStringChars = args.options.inlineStringChars ?? 512;
  const entries = [...Object.entries(args.input)].sort(([left], [right]) => left.localeCompare(right));

  for (const [name, value] of entries) {
    if (typeof value === "string") {
      if (value.length <= inlineStringChars) {
        inlineInputs[name] = value;
        continue;
      }

      const path = `${contextRoot}/${safePathSegment(name)}.txt`;
      textResources.set(path, value);
      resources.push({
        name,
        path,
        kind: "text",
        valueType: "string",
        size: value.length,
        preview: truncatePreview(value, previewChars),
      });
      continue;
    }

    if (value == null || typeof value === "number" || typeof value === "boolean") {
      inlineInputs[name] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((item) => isRecord(item))) {
      const content = value.map((entry) => stableStringify(entry)).join("\n");
      const path = `${contextRoot}/${safePathSegment(name)}.ndjson`;
      textResources.set(path, content);
      resources.push({
        name,
        path,
        kind: "ndjson",
        valueType: "array",
        size: value.length,
        preview: truncatePreview(content, previewChars),
      });
      continue;
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const size = value instanceof Uint8Array ? value.byteLength : value.byteLength;
      resources.push({
        name,
        path: `${contextRoot}/${safePathSegment(name)}.bin`,
        kind: "binary",
        valueType: value instanceof Uint8Array ? "Uint8Array" : "ArrayBuffer",
        size,
        preview: `${size} bytes`,
      });
      continue;
    }

    const content = stableStringify(value);
    const path = `${contextRoot}/${safePathSegment(name)}.json`;
    textResources.set(path, content);
    resources.push({
      name,
      path,
      kind: "json",
      valueType: Array.isArray(value) ? "array" : "object",
      size: content.length,
      preview: truncatePreview(content, previewChars),
    });
  }

  const corpusIds =
    typeof args.options.corpusIds === "function"
      ? args.options.corpusIds(args.input)
      : (args.options.corpusIds ?? []);
  const pathsByCorpus =
    typeof args.options.pathsByCorpus === "function"
      ? args.options.pathsByCorpus(args.input)
      : args.options.pathsByCorpus;

  let corpusManifest:
    | Awaited<ReturnType<typeof prepareCorpusContext>>
    | undefined;
  if (args.provider != null && corpusIds.length > 0) {
    corpusManifest = await prepareCorpusContext({
      provider: args.provider,
      corpusIds,
      ...(args.options.workspace != null ? { workspace: args.options.workspace } : {}),
      ...(pathsByCorpus != null ? { pathsByCorpus } : {}),
      ...(args.options.destinationPrefix != null
        ? { destinationPrefix: args.options.destinationPrefix }
        : {}),
      ...(args.options.includeSearchInfo === true ? { includeSearchInfo: true } : {}),
    });
  }

  const manifest = {
    runId: args.runId,
    moduleId: args.moduleId,
    contextRoot,
    inlineInputs,
    resources,
    corpora: corpusManifest?.manifest.corpora ?? [],
    preparedAt: nowIso(),
  };

  textResources.set(manifestPath, stableStringify(manifest));

  return {
    inlineInputs,
    textResources: Object.fromEntries(textResources),
    corpusIds,
    preparedContext: {
      contextRoot,
      manifestPath,
      resources,
      manifestSummary: [
        `Context root: ${contextRoot}`,
        chunkContextSummary(
          "Prepared resources",
          resources.map((resource) => `${resource.name} (${resource.path}, ${resource.kind})`),
        ),
        chunkContextSummary(
          "Configured corpora",
          (corpusManifest?.manifest.corpora ?? []).map(
            (corpus) => `${corpus.id} (logical root /corpora/${encodeURIComponent(corpus.id)})`,
          ),
        ),
      ].join("\n\n"),
      availableTools: summarizeAvailableTools({
        customTools: args.tools.map((tool) => {
          const { definition } = buildToolDefinition(tool as never);
          return definition.description != null
            ? {
                name: definition.name,
                description: definition.description,
              }
            : {
                name: definition.name,
              };
        }),
        corpusIds,
      }),
      variablesInfo: summarizeVariablesInfo({
        inlineInputs,
        resources,
        corpora: corpusManifest?.manifest.corpora ?? [],
      }),
      manifest,
    },
  };
}

function resolveHostedSessionManager(
  options: CloudflareRlmRuntimeOptions,
  runtime: RuntimeContextLike | undefined,
): CloudflareHostedRlmSessionManager | undefined {
  if (options.hostedSessionManager != null) {
    return options.hostedSessionManager;
  }

  const internal =
    runtime != null &&
    typeof runtime === "object" &&
    "__superobjectiveCloudflareInternal" in runtime &&
    isRecord((runtime as { __superobjectiveCloudflareInternal?: unknown }).__superobjectiveCloudflareInternal)
      ? (runtime as {
          __superobjectiveCloudflareInternal: {
            rlmSessionManager?: CloudflareHostedRlmSessionManager;
          };
        }).__superobjectiveCloudflareInternal
      : undefined;

  return internal?.rlmSessionManager;
}

async function resolveExecutor(
  options: CloudflareRlmRuntimeOptions,
  env: CloudflareEnvLike | undefined,
): Promise<Executor> {
  if (options.executor != null) {
    return options.executor;
  }

  const binding = options.loaderBinding ?? "LOADER";
  const loader = env?.[binding];
  if (loader == null) {
    throw new Error(
      `Cloudflare RLM runtime requires either a custom executor or a Worker Loader binding "${binding}".`,
    );
  }

  const module = (await import("@cloudflare/codemode")) as {
    DynamicWorkerExecutor: DynamicWorkerExecutorCtor;
  };

  return new module.DynamicWorkerExecutor({
    loader,
    ...(options.timeoutMs != null ? { timeout: options.timeoutMs } : {}),
    ...(options.globalOutbound !== undefined ? { globalOutbound: options.globalOutbound } : {}),
    ...(options.modules != null ? { modules: options.modules } : {}),
  });
}

function asSingleArg<TArgs, TOutput>(fn: (args: TArgs) => Promise<TOutput>) {
  return async (...args: unknown[]): Promise<TOutput> => fn((args[0] ?? {}) as TArgs);
}

class HostedCloudflareRLMSession implements RLMSession {
  readonly sessionKind = "cloudflare-hosted-facet";
  private preparedContext: RLMPreparedContext | null = null;
  private inlineInputs: Record<string, unknown> = {};

  constructor(
    private readonly runId: string,
    private readonly moduleId: string,
    private readonly handle: CloudflareHostedRlmSessionHandle,
    private readonly provider: CorpusProviderLike<CloudflareEnvLike> | undefined,
    private readonly options: CloudflareRlmRuntimeOptions,
    private readonly tools: Tool<any, any>[],
  ) {}

  async prepareContext(input: Record<string, unknown>): Promise<RLMPreparedContext> {
    const bundle = await prepareSessionBundle({
      runId: this.runId,
      moduleId: this.moduleId,
      input,
      ...(this.provider != null ? { provider: this.provider } : {}),
      options: this.options,
      tools: this.tools,
    });

    this.preparedContext = bundle.preparedContext;
    this.inlineInputs = bundle.inlineInputs;
    await this.handle.init({
      runId: this.runId,
      moduleId: this.moduleId,
      preparedContext: bundle.preparedContext,
      inlineInputs: bundle.inlineInputs,
      textResources: bundle.textResources,
      corpusIds: bundle.corpusIds,
      tools: this.tools.map((tool) => {
        const { definition } = buildToolDefinition(tool as never);
        return definition.description != null
          ? {
              name: definition.name,
              description: definition.description,
            }
          : {
              name: definition.name,
            };
      }),
    });
    return bundle.preparedContext;
  }

  async executeStep(request: RLMExecuteStepRequest): Promise<RLMExecuteStepResult> {
    const metadata = await this.handle.describe();
    const compiled = compileRlmStep(request.code, metadata.trackedNames);
    return this.handle.step({
      compiled,
      request: {
        code: request.code,
        maxOutputChars: request.maxOutputChars,
        maxQueryCalls: request.maxQueryCalls,
        queryCallsUsed: request.queryCallsUsed,
      },
    });
  }

  async checkpoint(value: RLMSessionCheckpoint): Promise<void> {
    await this.handle.checkpoint(value);
  }

  async resume(): Promise<RLMSessionCheckpoint | null> {
    const checkpoint = await this.handle.resume();
    if (checkpoint != null) {
      this.preparedContext = checkpoint.preparedContext;
      const manifest = checkpoint.preparedContext.manifest;
      if (
        isRecord(manifest) &&
        isRecord(manifest.inlineInputs)
      ) {
        this.inlineInputs = manifest.inlineInputs as Record<string, unknown>;
      }
    }
    return checkpoint;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

class ReplayCloudflareRLMSession implements RLMSession {
  readonly sessionKind = "cloudflare-replay";
  private readonly textResources = new Map<string, string>();
  private readonly corpusHandles = new Map<string, CorpusRuntimeHandleLike>();
  private readonly successfulCells: string[] = [];
  private preparedContext: RLMPreparedContext | null = null;
  private inlineInputs: Record<string, unknown> = {};

  constructor(
    private readonly runId: string,
    private readonly moduleId: string,
    private readonly executor: Executor,
    private readonly runtime: RuntimeContextLike | undefined,
    private readonly env: CloudflareEnvLike | undefined,
    private readonly provider: CorpusProviderLike<CloudflareEnvLike> | undefined,
    private readonly options: CloudflareRlmRuntimeOptions,
    private readonly tools: Tool<any, any>[],
  ) {}

  async prepareContext(input: Record<string, unknown>): Promise<RLMPreparedContext> {
    this.textResources.clear();
    this.corpusHandles.clear();
    this.successfulCells.length = 0;
    const bundle = await prepareSessionBundle({
      runId: this.runId,
      moduleId: this.moduleId,
      input,
      ...(this.provider != null ? { provider: this.provider } : {}),
      options: this.options,
      tools: this.tools,
    });
    this.inlineInputs = bundle.inlineInputs;
    for (const [path, text] of Object.entries(bundle.textResources)) {
      this.textResources.set(path, text);
    }
    for (const corpusId of bundle.corpusIds) {
      if (this.provider != null) {
        this.corpusHandles.set(corpusId, await this.provider.resolve(corpusId));
      }
    }
    this.preparedContext = bundle.preparedContext;
    return bundle.preparedContext;
  }

  async executeStep(request: RLMExecuteStepRequest): Promise<RLMExecuteStepResult> {
    const toolCalls: NonNullable<RLMExecuteStepResult["toolCalls"]> = [];
    const hostLogs: string[] = [];
    let queryCallsUsed = request.queryCallsUsed;
    let toolCallPhase: "replay" | "current" = "current";

    const withToolTrace = async <T>(
      toolName: string,
      input: unknown,
      execute: () => Promise<T>,
    ): Promise<T> => {
      const startedAt = nowIso();
      try {
        const output = await execute();
        if (toolCallPhase === "current") {
          toolCalls.push({
            toolName,
            input,
            output,
            source: "rlm",
            startedAt,
            endedAt: nowIso(),
          });
        }
        return output;
      } catch (error) {
        if (toolCallPhase === "current") {
          toolCalls.push({
            toolName,
            input,
            error: serializeError(error),
            source: "rlm",
            startedAt,
            endedAt: nowIso(),
          });
        }
        throw error;
      }
    };

    const readTextResource = async (path: string): Promise<LoadedTextResource> => {
      const prepared = this.preparedContext ?? request.context;
      if (path === prepared.manifestPath) {
        const text = this.textResources.get(path) ?? stableStringify(prepared.manifest ?? {});
        return {
          path,
          storage: "prepared",
          text,
          totalChars: text.length,
          preview: truncatePreview(text, this.options.previewChars ?? 240),
        };
      }

      const preparedText = this.textResources.get(path);
      if (preparedText != null) {
        return {
          path,
          storage: "prepared",
          text: preparedText,
          totalChars: preparedText.length,
          preview: truncatePreview(preparedText, this.options.previewChars ?? 240),
        };
      }

      const corpusMatch = pathMatchForCorpus(path);
      if (corpusMatch != null) {
        const corpus =
          this.corpusHandles.get(corpusMatch.corpusId) ??
          (this.provider != null ? await this.provider.resolve(corpusMatch.corpusId) : null);
        if (corpus == null) {
          throw new Error(`Corpus "${corpusMatch.corpusId}" was not prepared for this RLM session.`);
        }
        this.corpusHandles.set(corpusMatch.corpusId, corpus);
        const text = await corpus.files.getText(corpusMatch.relativePath);
        return {
          path,
          storage: "corpus",
          text,
          totalChars: text.length,
          preview: truncatePreview(text, this.options.previewChars ?? 240),
        };
      }

      throw new Error(`Unknown prepared text path "${path}".`);
    };

    const providers: ResolvedProvider[] = [
      {
        name: "rlm",
        positionalArgs: false,
        fns: {
          __setPhase: asSingleArg(async (args: { phase: "replay" | "current" }) => {
            toolCallPhase = args.phase;
            return {
              phase: toolCallPhase,
            };
          }),
          getManifest: async () => this.preparedContext?.manifest ?? request.context.manifest ?? null,
          listResources: async () => request.context.resources,
          getInput: asSingleArg(async (args: { key?: string }) =>
            args.key == null ? this.inlineInputs : this.inlineInputs[args.key]),
          query: asSingleArg(async (args: {
            prompt: string;
            options?: Parameters<RLMQueryProvider["query"]>[1];
          }) =>
            withToolTrace("rlm.query", args, async () => {
              if (request.queryProvider == null) {
                throw new Error("No RLM query provider is configured for this step.");
              }
              queryCallsUsed += 1;
              if (queryCallsUsed > request.maxQueryCalls) {
                throw new Error(`RLM query budget exceeded: ${queryCallsUsed} > ${request.maxQueryCalls}.`);
              }
              return request.queryProvider.query(args.prompt, {
                ...(args.options ?? {}),
                metadata: {
                  ...(args.options?.metadata ?? {}),
                  ...(this.env != null ? { env: this.env } : {}),
                },
              });
            })),
          queryBatch: asSingleArg(async (args: {
            prompts: string[];
            options?: Parameters<RLMQueryProvider["batch"]>[1];
          }) =>
            withToolTrace("rlm.queryBatch", args, async () => {
              if (request.queryProvider == null) {
                throw new Error("No RLM query provider is configured for this step.");
              }
              queryCallsUsed += args.prompts.length;
              if (queryCallsUsed > request.maxQueryCalls) {
                throw new Error(`RLM query budget exceeded: ${queryCallsUsed} > ${request.maxQueryCalls}.`);
              }
              return request.queryProvider.batch(args.prompts, {
                ...(args.options ?? {}),
                metadata: {
                  ...(args.options?.metadata ?? {}),
                  ...(this.env != null ? { env: this.env } : {}),
                },
              });
            })),
          getTextInfo: asSingleArg(async (args: { path: string }) =>
            withToolTrace("rlm.getTextInfo", args, async () => {
              const resource = await readTextResource(args.path);
              return {
                path: resource.path,
                storage: resource.storage,
                totalChars: resource.totalChars,
                preview: resource.preview,
              };
            })),
          readText: asSingleArg(async (args: { path: string; startChar?: number; maxChars?: number }) =>
            withToolTrace("rlm.readText", args, async () => {
              const resource = await readTextResource(args.path);
              return {
                path: resource.path,
                storage: resource.storage,
                ...readTextSlice(resource.text, args, request.maxOutputChars),
              };
            })),
          searchText: asSingleArg(async (args: {
            path: string;
            query: string;
            maxResults?: number;
            contextChars?: number;
            caseSensitive?: boolean;
          }) =>
            withToolTrace("rlm.searchText", args, async () => {
              const resource = await readTextResource(args.path);
              return {
                storage: resource.storage,
                ...searchWithinText(resource.path, resource.text, args.query, args),
              };
            })),
          readMatchWindow: asSingleArg(async (args: {
            path: string;
            match: {
              startChar: number;
              endChar: number;
            };
            beforeChars?: number;
            afterChars?: number;
            maxChars?: number;
          }) =>
            withToolTrace("rlm.readMatchWindow", args, async () => {
              const resource = await readTextResource(args.path);
              const beforeChars = Math.max(0, args.beforeChars ?? 80);
              const afterChars = Math.max(0, args.afterChars ?? 80);
              const startChar = Math.max(0, args.match.startChar - beforeChars);
              const defaultMaxChars = args.match.endChar - args.match.startChar + beforeChars + afterChars;
              const slice = readTextSlice(
                resource.text,
                {
                  startChar,
                  maxChars: args.maxChars ?? defaultMaxChars,
                },
                request.maxOutputChars,
              );
              return {
                path: resource.path,
                storage: resource.storage,
                ...slice,
              };
            })),
          listCorpusFiles: asSingleArg(async (args: { corpusId: string; prefix?: string }) =>
            withToolTrace("rlm.listCorpusFiles", args, async () => {
              const corpus =
                this.corpusHandles.get(args.corpusId) ??
                (this.provider != null ? await this.provider.resolve(args.corpusId) : null);
              if (corpus == null) {
                throw new Error(`Corpus "${args.corpusId}" was not prepared for this RLM session.`);
              }
              this.corpusHandles.set(args.corpusId, corpus);
              return {
                corpusId: args.corpusId,
                files: await corpus.files.list(args.prefix),
              };
            })),
          readCorpusFile: asSingleArg(async (args: { corpusId: string; path: string }) =>
            withToolTrace("rlm.readCorpusFile", args, async () => {
              const corpus =
                this.corpusHandles.get(args.corpusId) ??
                (this.provider != null ? await this.provider.resolve(args.corpusId) : null);
              if (corpus == null) {
                throw new Error(`Corpus "${args.corpusId}" was not prepared for this RLM session.`);
              }
              this.corpusHandles.set(args.corpusId, corpus);
              return {
                corpusId: args.corpusId,
                path: args.path,
                content: await corpus.files.getText(args.path),
              };
            })),
          searchCorpus: asSingleArg(async (args: {
            corpusId: string;
            query?: string;
            messages?: Parameters<NonNullable<CorpusRuntimeHandleLike["search"]>["search"]>[0]["messages"];
            filters?: Record<string, unknown>;
            maxResults?: number;
          }) =>
            withToolTrace("rlm.searchCorpus", args, async () => {
              const corpus =
                this.corpusHandles.get(args.corpusId) ??
                (this.provider != null ? await this.provider.resolve(args.corpusId) : null);
              if (corpus == null) {
                throw new Error(`Corpus "${args.corpusId}" was not prepared for this RLM session.`);
              }
              if (corpus.search == null) {
                throw new Error(`Corpus "${args.corpusId}" does not expose AI Search.`);
              }
              this.corpusHandles.set(args.corpusId, corpus);
              return corpus.search.search({
                ...(args.query != null ? { query: args.query } : {}),
                ...(args.messages != null ? { messages: args.messages } : {}),
                ...(args.filters != null ? { filters: args.filters } : {}),
                ...(args.maxResults != null ? { maxResults: args.maxResults } : {}),
              });
            })),
        },
      },
    ];

    const toolFns: Record<string, (args: unknown) => Promise<unknown>> = {};
    for (const tool of request.tools ?? this.tools) {
      const { definition } = buildToolDefinition(tool as never);
      const outputSchema = getOutputSchema(tool as never);
      const targetId = getTargetId(tool as never);
      toolFns[definition.name] = async (rawInput: unknown) =>
        withToolTrace(definition.name, rawInput, async () => {
          const output = await (tool as ToolLike<unknown, unknown>).execute(rawInput, {
            runtime: this.runtime ?? ({} as RuntimeContextLike),
            ...(this.env != null ? { env: this.env } : {}),
            log(message: string) {
              hostLogs.push(`[${definition.name}] ${message}`);
            },
          });
          const validated = validateWithSchema(outputSchema, output);
          hostLogs.push(`[${definition.name}] completed via ${targetId}`);
          return validated;
        });
    }

    if (Object.keys(toolFns).length > 0) {
      providers.push({
        name: "tools",
        positionalArgs: false,
        fns: toolFns,
      });
    }

    const result = await this.executor.execute(
      buildReplayProgram(
        this.successfulCells,
        request.code,
        Object.keys(toolFns),
      ),
      providers,
    );

    const logs = [...hostLogs, ...(result.logs ?? [])];
    if (result.error == null) {
      this.successfulCells.push(request.code);
    }

    const payload = isRecord(result.result) ? result.result : {};
    const embeddedError = typeof payload.error === "string" ? payload.error : undefined;
    const error = result.error ?? embeddedError;

    const stepResult: RLMExecuteStepResult = {
      queryCallsUsed,
    };
    if (logs.length > 0) {
      stepResult.logs = logs;
      stepResult.stdout = logs.join("\n");
    }
    if (payload.submitted !== undefined) {
      stepResult.submitted = payload.submitted;
    }
    if (toolCalls.length > 0) {
      stepResult.toolCalls = toolCalls as unknown as NonNullable<RLMExecuteStepResult["toolCalls"]>;
    }
    if (error != null) {
      stepResult.error = error;
    }
    return stepResult;
  }

  async close(): Promise<void> {}
}

export function createCloudflareRlmRuntime(options: CloudflareRlmRuntimeOptions = {}): RLMRuntime {
  return {
    async createSession(args): Promise<RLMSession> {
      const env = (args.env as CloudflareEnvLike | undefined) ?? options.env;
      const runtime = (args.runtime as RuntimeContextLike | undefined) ?? options.runtime;
      const provider = resolveCorpusProvider(
        options.corpora != null
          ? {
              ...(runtime != null ? { runtime } : {}),
              ...(env != null ? { env } : {}),
              corpora: options.corpora,
            }
          : {
              ...(runtime != null ? { runtime } : {}),
            ...(env != null ? { env } : {}),
          },
      );
      const tools = (args.tools ?? []) as Tool<any, any>[];
      const hostedManager = resolveHostedSessionManager(options, runtime);
      if (hostedManager != null) {
        const handle = await hostedManager.openSession({
          runId: args.runId,
          moduleId: args.moduleId,
          ...(env != null ? { env } : {}),
          ...(runtime != null ? { runtime } : {}),
          ...(provider != null ? { provider } : {}),
          tools,
          options,
        });
        return new HostedCloudflareRLMSession(
          args.runId,
          args.moduleId,
          handle,
          provider,
          options,
          tools,
        );
      }

      const executor = await resolveExecutor(options, env);

      return new ReplayCloudflareRLMSession(
        args.runId,
        args.moduleId,
        executor,
        runtime,
        env,
        provider,
        options,
        tools,
      );
    },
  };
}
