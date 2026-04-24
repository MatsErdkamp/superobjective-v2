import { createWorkersAI } from "workers-ai-provider";
import { tool as createTool, type LanguageModel, type ToolSet, type UIMessage } from "ai";
import type { RLMExecuteStepResult, RLMSessionCheckpoint } from "superobjective";
import { z } from "zod";
import {
  badRequest,
  buildToolDefinition,
  createRouteTrace,
  dispatchHostedRequest,
  getInputSchema,
  getOutputSchema,
  getTargetId,
  getTargetKind,
  isRecord,
  jsonResponse,
  normalizeProject,
  notFound,
  nowIso,
  parseRequestInput,
  resolveText,
  serializeError,
  stableStringify,
  validateWithSchema,
} from "@superobjective/hosting";
import {
  executeKernelTarget,
  handleKernelRequest,
  MemoryKernelPersistence,
  type KernelStoredRlmRun,
  type KernelStoredRlmStep,
  type KernelStoredCorpus,
  type KernelPersistence,
} from "./kernel";
import { bindProjectCorporaRuntime } from "./corpora";
import { buildRlmFacetWorkerSource } from "./rlm-facet-source";
import { buildHostedRlmStepWorkerSource } from "./rlm-hosted-step";
import { createAiSdkBridge, bindRuntimeEnv } from "./runtime";
import { getPathSegments } from "./request";
import type { CloudflareHostedRlmSessionManager } from "./rlm";
import type {
  AgentLike,
  ArtifactTargetKindLike,
  CallableTargetLike,
  CloudflareEnvLike,
  CloudflareWorkerLike,
  CreateCloudflareWorkerOptions,
  ExecutionContextLike,
  NormalizedProjectLike,
  RuntimeContextLike,
  RunTraceLike,
  ToolLike,
  ToolCallTraceLike,
} from "./types";

type AgentBaseLike = new (...args: any[]) => {};
type ThinkBaseLike = new (...args: any[]) => {};
type McpAgentBaseLike = new (...args: any[]) => {};
type McpServerCtorLike = new (info: { name: string; version: string }) => {};
type DurableHostStubLike = {
  fetch(request: Request): Promise<Response>;
};
type DurableHostNamespaceLike = {
  getByName(name: string): DurableHostStubLike;
};

type AgentNamespaceResolverLike = <
  TNamespace extends DurableHostNamespaceLike = DurableHostNamespaceLike,
>(
  namespace: TNamespace,
  name: string,
  options?: {
    jurisdiction?: string;
    locationHint?: string;
    props?: Record<string, unknown>;
  },
) => Promise<DurableHostStubLike>;

const isCloudflareAgentRuntime =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";

const agentsModule = isCloudflareAgentRuntime ? await import("agents") : null;
const cloudflareWorkersModule = isCloudflareAgentRuntime ? await import("cloudflare:workers") : null;
const thinkModule = isCloudflareAgentRuntime ? await import("@cloudflare/think") : null;
const mcpModule = isCloudflareAgentRuntime ? await import("agents/mcp") : null;
const mcpSdkModule = isCloudflareAgentRuntime
  ? await import("@modelcontextprotocol/sdk/server/mcp.js")
  : null;

const AgentBase = (agentsModule?.Agent ??
  class {
    constructor(..._args: any[]) {}
  }) as AgentBaseLike;

const ThinkBase = (thinkModule?.Think ??
  class {
    constructor(..._args: any[]) {}
  }) as ThinkBaseLike;

const McpAgentBase = (mcpModule?.McpAgent ??
  class {
    constructor(..._args: any[]) {}
  }) as McpAgentBaseLike;

const McpServerBase = (mcpSdkModule?.McpServer ??
  class {
    constructor(_info: { name: string; version: string }) {}
  }) as McpServerCtorLike;

const WorkerEntrypointBase = (cloudflareWorkersModule?.WorkerEntrypoint ??
  class {
    constructor(..._args: any[]) {}
  }) as AgentBaseLike;

const getAgentByName =
  agentsModule != null &&
  "getAgentByName" in agentsModule &&
  typeof agentsModule.getAgentByName === "function"
    ? (agentsModule.getAgentByName as unknown as AgentNamespaceResolverLike)
    : null;

type RegisteredWorker = {
  options: CreateCloudflareWorkerOptions;
  project: NormalizedProjectLike;
  warnings: string[];
};

type RouteDispatchOptions = {
  request: Request;
  env?: CloudflareEnvLike | undefined;
  executionContext?: ExecutionContextLike | undefined;
  registration: RegisteredWorker;
  hostPrefix?: "agents" | "rpc" | "mcp";
};

type HostedRouteTarget =
  | CallableTargetLike<unknown, unknown>
  | ToolLike<unknown, unknown>;

type HostingProjectTargetLike = Parameters<typeof buildToolDefinition>[0];

type ThinkTurnSaveResult = {
  requestId: string;
  status: "completed" | "skipped";
};

type ThinkHostLike = {
  name?: string;
  sessionAffinity?: string;
  waitUntilStable(options?: { timeout?: number }): Promise<boolean>;
  saveMessages(messages: UIMessage[]): Promise<ThinkTurnSaveResult>;
  getMessages(): UIMessage[];
};

function toHostingProjectTarget(target: HostedRouteTarget): HostingProjectTargetLike {
  return target as unknown as HostingProjectTargetLike;
}

type ActiveAgentTurn = {
  agentName: string;
  sessionId: string;
  routeTrace: RunTraceLike;
  routeContext: {
    runtime: RuntimeContextLike;
    env: CloudflareEnvLike;
    request: Request;
    warnings: string[];
  };
  userInput: unknown;
  assistantMessage?: UIMessage;
  assistantText?: string;
  responseData?: unknown;
  responseTraceId?: string;
  error?: unknown;
};

let activeWorkerRegistration: RegisteredWorker | null = null;
let localKernelPersistence: MemoryKernelPersistence | null = null;
const activeRlmHostedSessions = new Map<
  string,
  {
    moduleId: string;
    target: HostedRouteTarget;
    runtime: RuntimeContextLike | undefined;
    env: CloudflareEnvLike | undefined;
    provider: ReturnType<typeof bindProjectCorporaRuntime>["corpora"] | undefined;
    tools: ToolLike<unknown, unknown>[];
  }
>();

const HOST_NAME_SEPARATOR = "::";

function collectDevelopmentWarnings(options: CreateCloudflareWorkerOptions): string[] {
  const warnings: string[] = [];
  const development = options.cloudflare?.development;
  if (development == null) {
    return warnings;
  }

  if (development.mode === "local-remote-bindings") {
    warnings.push(
      "Cloudflare development mode uses remote bindings; requests may hit billable remote services.",
    );
  }

  if (development.mode === "remote-preview") {
    warnings.push(
      "Cloudflare development mode is remote-preview; latency and state behavior may differ from local Durable Objects.",
    );
  }

  for (const [binding, mode] of Object.entries(development.bindings ?? {})) {
    if (mode === "remote") {
      warnings.push(`Binding "${binding}" is configured as remote.`);
    }
  }

  if (development.durableObjects === "remote") {
    warnings.push("Durable Objects are configured as remote.");
  }

  if (development.workflows === "remote") {
    warnings.push("Workflows are configured as remote.");
  }

  return warnings;
}

function logWarnings(runtime: RuntimeContextLike | undefined, warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }

  const logger = runtime?.logger;
  for (const warning of warnings) {
    logger?.warn?.(`[superobjective/cloudflare] ${warning}`);
  }
}

async function dispatchRequest({
  request,
  env,
  executionContext,
  registration,
  hostPrefix,
}: RouteDispatchOptions): Promise<Response> {
  const runtime = bindRuntimeEnv(
    {
      ...registration.options.runtime,
      structuredGeneration:
        registration.options.runtime?.structuredGeneration ?? createAiSdkBridge(),
    },
    env,
  );
  return dispatchHostedRequest({
    request,
    env,
    executionContext,
    runtime,
    project: registration.project,
    warnings: registration.warnings,
    ...(hostPrefix != null ? { hostPrefix } : {}),
  });
}

function registerWorker(options: CreateCloudflareWorkerOptions): RegisteredWorker {
  const registration: RegisteredWorker = {
    options,
    project: normalizeProject(options.project),
    warnings: collectDevelopmentWarnings(options),
  };

  activeWorkerRegistration = registration;
  localKernelPersistence = new MemoryKernelPersistence("default");
  logWarnings(options.runtime, registration.warnings);
  return registration;
}

function requireActiveRegistration(): RegisteredWorker {
  if (activeWorkerRegistration == null) {
    throw new Error(
      "No Superobjective Cloudflare worker has been registered yet. Call createCloudflareWorker() in this module before using host classes.",
    );
  }
  return activeWorkerRegistration;
}

function requireLocalKernelPersistence(): MemoryKernelPersistence {
  if (localKernelPersistence == null) {
    localKernelPersistence = new MemoryKernelPersistence("default");
  }
  return localKernelPersistence;
}

function findRlmProgram(project: NormalizedProjectLike, moduleId: string): HostedRouteTarget | null {
  for (const program of project.programs.values()) {
    if (
      getTargetId(program as unknown as HostingProjectTargetLike) === moduleId &&
      getTargetKind(program as unknown as HostingProjectTargetLike) === "rlm"
    ) {
      return program as HostedRouteTarget;
    }
  }
  return null;
}

function getFacetName(runId: string): string {
  return `rlm:${runId}`;
}

function createBoundRuntime(
  env: CloudflareEnvLike | undefined,
  registration: RegisteredWorker,
): RuntimeContextLike {
  const runtime = bindRuntimeEnv(
    {
      ...registration.options.runtime,
      structuredGeneration:
        registration.options.runtime?.structuredGeneration ?? createAiSdkBridge(),
    },
    env,
  );

  return bindProjectCorporaRuntime(runtime, registration.project, env);
}

async function dispatchKernelRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
  persistence: KernelPersistence,
  fiberRunner?: {
    runFiber<T>(
      name: string,
      fn: (fiber: { stash(value: unknown): void; snapshot?: unknown }) => Promise<T>,
    ): Promise<T>;
  },
  rlmSessionManager?: CloudflareHostedRlmSessionManager,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const registration = requireActiveRegistration();
  const runtime = createBoundRuntime(env, registration);
  const kernelRuntime = {
    ...runtime,
    traceStore: registration.options.runtime?.traceStore ?? persistence,
    artifactStore: registration.options.runtime?.artifactStore ?? persistence,
    ...(rlmSessionManager != null
      ? {
          __superobjectiveCloudflareInternal: {
            rlmSessionManager,
          },
        }
      : {}),
  } as RuntimeContextLike;
  return handleKernelRequest({
    request,
    runtime: kernelRuntime,
    project: registration.project,
    persistence,
    warnings: registration.warnings,
    ...(env ? { env } : {}),
    ...(fiberRunner != null ? { fiberRunner } : {}),
    ...(waitUntil != null ? { waitUntil } : {}),
  });
}

export class RlmRuntimeHost extends WorkerEntrypointBase {
  private get hostedEnv(): CloudflareEnvLike | undefined {
    return (this as { env?: CloudflareEnvLike }).env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const payload =
      request.method === "POST"
        ? await request
            .json()
            .catch(() => ({}))
        : {};

    try {
      switch (url.pathname) {
        case "/query":
          return Response.json({
            text: await this.query(payload as Parameters<typeof this.query>[0]),
          });
        case "/query-batch":
          return Response.json({
            texts: await this.queryBatch(payload as Parameters<typeof this.queryBatch>[0]),
          });
        case "/list-corpus-files":
          return Response.json(
            await this.listCorpusFiles(payload as Parameters<typeof this.listCorpusFiles>[0]),
          );
        case "/read-corpus-file":
          return Response.json(
            await this.readCorpusFile(payload as Parameters<typeof this.readCorpusFile>[0]),
          );
        case "/search-corpus":
          return Response.json(
            await this.searchCorpus(payload as Parameters<typeof this.searchCorpus>[0]),
          );
        case "/execute-tool":
          return Response.json({
            output: await this.executeTool(payload as Parameters<typeof this.executeTool>[0]),
          });
        default:
          return new Response(`RLM runtime host route "${url.pathname}" was not found.`, {
            status: 404,
          });
      }
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), {
        status: 500,
      });
    }
  }

  private resolveHostedSession(args: { runId: string; moduleId?: string }) {
    const existing = activeRlmHostedSessions.get(args.runId);
    if (existing != null) {
      return existing;
    }

    if (args.moduleId == null) {
      throw new Error(`Hosted RLM session "${args.runId}" was not found.`);
    }

    const registration = requireActiveRegistration();
    const target = findRlmProgram(registration.project, args.moduleId);
    if (target == null) {
      throw new Error(`RLM module "${args.moduleId}" was not found.`);
    }

    const runtime = createBoundRuntime(this.hostedEnv, registration);
    const session = {
      moduleId: args.moduleId,
      target,
      runtime,
      env: this.hostedEnv,
      provider: runtime.corpora,
      tools: (((target as unknown as { options?: { tools?: ToolLike<unknown, unknown>[] } }).options?.tools ??
        []) as ToolLike<unknown, unknown>[]),
    };
    activeRlmHostedSessions.set(args.runId, session);
    return session;
  }

  async query(args: {
    runId: string;
    moduleId?: string;
    prompt: string;
    options?: { metadata?: Record<string, unknown>; [key: string]: unknown };
  }): Promise<string> {
    const session = this.resolveHostedSession(args);
    const provider = (session.target as unknown as { options?: { queryProvider?: { query: Function } } }).options
      ?.queryProvider;
    if (provider == null || typeof provider.query !== "function") {
      throw new Error(`RLM module "${session.moduleId}" does not expose a query provider.`);
    }
    return provider.query(args.prompt, {
      ...(args.options ?? {}),
      metadata: {
        ...(isRecord(args.options?.metadata) ? args.options?.metadata : {}),
        ...(this.hostedEnv != null ? { env: this.hostedEnv } : {}),
      },
    });
  }

  async queryBatch(args: {
    runId: string;
    moduleId?: string;
    prompts: string[];
    options?: { metadata?: Record<string, unknown> };
  }): Promise<string[]> {
    const session = this.resolveHostedSession(args);
    const provider = (session.target as unknown as { options?: { queryProvider?: { batch: Function } } }).options
      ?.queryProvider;
    if (provider == null || typeof provider.batch !== "function") {
      throw new Error(`RLM module "${session.moduleId}" does not expose a query provider.`);
    }
    return provider.batch(args.prompts, {
      ...(args.options ?? {}),
      metadata: {
        ...(isRecord(args.options?.metadata) ? args.options?.metadata : {}),
        ...(this.hostedEnv != null ? { env: this.hostedEnv } : {}),
      },
    });
  }

  async listCorpusFiles(args: {
    runId: string;
    moduleId?: string;
    corpusId: string;
    prefix?: string;
  }): Promise<{ corpusId: string; files: string[] }> {
    const session = this.resolveHostedSession(args);
    const provider = session.provider;
    if (provider == null) {
      throw new Error(`Hosted RLM session "${args.runId}" does not expose corpora.`);
    }
    const corpus = await provider.resolve(args.corpusId);
    return {
      corpusId: args.corpusId,
      files: await corpus.files.list(args.prefix),
    };
  }

  async readCorpusFile(args: {
    runId: string;
    moduleId?: string;
    corpusId: string;
    path: string;
  }): Promise<{ corpusId: string; path: string; content: string }> {
    const session = this.resolveHostedSession(args);
    const provider = session.provider;
    if (provider == null) {
      throw new Error(`Hosted RLM session "${args.runId}" does not expose corpora.`);
    }
    const corpus = await provider.resolve(args.corpusId);
    return {
      corpusId: args.corpusId,
      path: args.path,
      content: await corpus.files.getText(args.path),
    };
  }

  async searchCorpus(args: {
    runId: string;
    moduleId?: string;
    corpusId: string;
    query?: string;
    messages?: unknown;
    filters?: Record<string, unknown>;
    maxResults?: number;
  }): Promise<unknown> {
    const session = this.resolveHostedSession(args);
    const provider = session.provider;
    if (provider == null) {
      throw new Error(`Hosted RLM session "${args.runId}" does not expose corpora.`);
    }
    const corpus = await provider.resolve(args.corpusId);
    if (corpus.search == null) {
      throw new Error(`Corpus "${args.corpusId}" does not expose AI Search.`);
    }
    return corpus.search.search({
      ...(args.query != null ? { query: args.query } : {}),
      ...(Array.isArray(args.messages) ? { messages: args.messages as any } : {}),
      ...(args.filters != null ? { filters: args.filters } : {}),
      ...(args.maxResults != null ? { maxResults: args.maxResults } : {}),
    });
  }

  async executeTool(args: {
    runId: string;
    moduleId?: string;
    toolName: string;
    input: unknown;
  }): Promise<unknown> {
    const session = this.resolveHostedSession(args);
    const tool = session.tools.find((candidate) => candidate.name === args.toolName);
    if (tool == null) {
      throw new Error(`RLM tool "${args.toolName}" was not found.`);
    }

    const output = await tool.execute(args.input, {
      runtime: session.runtime ?? ({} as RuntimeContextLike),
      ...(this.hostedEnv != null ? { env: this.hostedEnv } : {}),
      log() {},
    });

    const outputSchema = getOutputSchema(tool as unknown as HostingProjectTargetLike);
    return validateWithSchema(outputSchema, output);
  }
}

function createFacetBackedRlmSessionManager(
  host: ModuleKernel,
): CloudflareHostedRlmSessionManager {
  return {
    async openSession(args) {
      const registration = requireActiveRegistration();
      const target = findRlmProgram(registration.project, args.moduleId);
      if (target == null) {
        throw new Error(`RLM module "${args.moduleId}" was not found.`);
      }

      activeRlmHostedSessions.set(args.runId, {
        moduleId: args.moduleId,
        target,
        runtime: args.runtime,
        env: args.env,
        provider: args.provider,
        tools: args.tools as ToolLike<unknown, unknown>[],
      });

      const stub = await host.getRlmFacetStub(args.runId);
      return {
        async init(payload) {
          await stub.init(payload);
        },
        describe() {
          return stub.describe();
        },
        async step(payload) {
          const sessionState = (await stub.exportState()) as Parameters<
            typeof buildHostedRlmStepWorkerSource
          >[0]["state"];
          const loader = host.getRlmLoader();
          if (loader == null) {
            throw new Error("Facet-backed RLM sessions require a LOADER binding.");
          }
          const runtimeHostBinding = host.getRlmRuntimeHostBinding(args.runId);
          const worker = (loader as {
            load(args: {
              compatibilityDate: string;
              mainModule: string;
              modules: Record<string, string>;
              globalOutbound: unknown;
            }): {
              getEntrypoint(name: string): {
                run(): Promise<RLMExecuteStepResult & { globals?: unknown }>;
              };
            };
          }).load({
            compatibilityDate: "2026-04-19",
            mainModule: "runner.js",
            modules: {
              "runner.js": buildHostedRlmStepWorkerSource({
                state: sessionState,
                step: payload,
              }),
            },
            globalOutbound: runtimeHostBinding,
          });
          const runner = worker.getEntrypoint("RlmStepRunner");
          const result = await runner.run();
          await stub.applyStepResult({
            compiled: payload.compiled,
            request: payload.request,
            result,
          });
          return result;
        },
        async checkpoint(payload) {
          await stub.checkpoint(payload);
        },
        resume() {
          return stub.resume() as Promise<RLMSessionCheckpoint | null>;
        },
        async close() {
          await stub.close();
        },
      };
    },
    async deleteSession(runId) {
      activeRlmHostedSessions.delete(runId);
      host.deleteRlmFacet(runId);
    },
  };
}

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions,
): CloudflareWorkerLike {
  const registration = registerWorker(options);
  return {
    async fetch(
      request: Request,
      env?: CloudflareEnvLike,
      executionContext?: ExecutionContextLike,
    ): Promise<Response> {
      const durableResponse = maybeDispatchToDurableHost(request, env);
      if (durableResponse != null) {
        return durableResponse;
      }

      const pathname = new URL(request.url).pathname;

      if (pathname.startsWith("/kernel/") || pathname === "/kernel") {
        return dispatchKernelRequest(request, env, requireLocalKernelPersistence());
      }

      if (pathname.startsWith("/rpc/")) {
        return dispatchRpcViaKernelRequest(request, env);
      }

      if (pathname.startsWith("/mcp/")) {
        return dispatchMcpViaKernelRequest(request, env);
      }

      return dispatchRequest({
        request,
        env,
        executionContext,
        registration,
      });
    },
  };
}

function encodeHostInstanceName(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(HOST_NAME_SEPARATOR);
}

function decodeHostInstanceName(name: string | undefined): string[] {
  if (name == null || name.length === 0) {
    return [];
  }
  return name.split(HOST_NAME_SEPARATOR).map((part) => decodeURIComponent(part));
}

function resolveDurableHostNamespace(
  env: CloudflareEnvLike | undefined,
  binding: string,
): DurableHostNamespaceLike | null {
  const candidate = env?.[binding];
  if (
    candidate != null &&
    typeof candidate === "object" &&
    "getByName" in candidate &&
    typeof candidate.getByName === "function"
  ) {
    return candidate as DurableHostNamespaceLike;
  }
  return null;
}

function maybeDispatchToDurableHost(
  request: Request,
  env: CloudflareEnvLike | undefined,
): Promise<Response> | null {
  const url = new URL(request.url);
  const segments = getPathSegments(url);
  if (segments.length < 2) {
    if (segments.length === 1 && segments[0] === "kernel") {
      const namespace = resolveDurableHostNamespace(env, "SO_KERNEL");
      if (namespace == null) {
        return null;
      }
      return forwardDurableHostRequest(namespace, "default", request);
    }
    return null;
  }

  if (segments[0] === "kernel") {
    const namespace = resolveDurableHostNamespace(env, "SO_KERNEL");
    if (namespace == null) {
      return null;
    }
    return forwardDurableHostRequest(namespace, "default", request);
  }

  const [surface, name, tail] = segments;
  if (surface === "agents" && name != null && tail != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_THINK");
    if (namespace == null) {
      return null;
    }
    return forwardDurableHostRequest(namespace, encodeHostInstanceName(name, tail), request);
  }

  if (surface === "rpc" && name != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_AGENT");
    if (namespace == null) {
      return null;
    }
    return forwardDurableHostRequest(namespace, encodeHostInstanceName(name), request);
  }

  if (surface === "mcp" && name != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_MCP");
    if (namespace == null) {
      return null;
    }
    return forwardDurableHostRequest(namespace, encodeHostInstanceName(name), request);
  }

  return null;
}

async function forwardDurableHostRequest(
  namespace: DurableHostNamespaceLike,
  name: string,
  request: Request,
): Promise<Response> {
  if (getAgentByName != null) {
    const host = await getAgentByName(namespace, name);
    return host.fetch(request);
  }

  return namespace.getByName(name).fetch(request);
}

async function forwardKernelHttpRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
  path: string,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const forwarded = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    ...(body != null ? { body } : {}),
  });

  return dispatchKernelRequest(forwarded, env, requireLocalKernelPersistence());
}

async function forwardKernelJsonRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
  path: string,
  payload: unknown,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;

  const forwarded = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return dispatchKernelRequest(forwarded, env, requireLocalKernelPersistence());
}

async function dispatchRpcViaKernelRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
): Promise<Response> {
  const registration = requireActiveRegistration();
  const warnings = registration.warnings;
  const runtime = createBoundRuntime(env, registration);
  const segments = getPathSegments(request);
  if (segments[0] !== "rpc" || segments[1] == null || segments[2] == null) {
    return badRequest('RPC requests must use "/rpc/:rpcName/:handlerName".', warnings);
  }

  const rpc = registration.project.rpc.get(segments[1]);
  if (rpc == null) {
    return notFound(`RPC surface "${segments[1]}" was not found.`, warnings);
  }

  const handler = rpc.handlers[segments[2]];
  if (handler == null) {
    return notFound(
      `RPC handler "${segments[2]}" was not found in surface "${segments[1]}".`,
      warnings,
    );
  }

  const input = await parseRequestInput(request.clone() as Request).catch(() => undefined);
  const routeTrace = createRouteTrace(`${segments[1]}.${segments[2]}`, "rpc", input, {
    route: "rpc",
    rpcName: segments[1],
    handlerName: segments[2],
  });

  const kernelResponse = await forwardKernelHttpRequest(
    request,
    env,
    `/kernel/run/${encodeURIComponent(getTargetId(handler as never))}`,
  );
  const payload = (await kernelResponse.json()) as Record<string, unknown>;

  if (kernelResponse.ok) {
    routeTrace.output = payload.output;
  } else {
    routeTrace.error = {
      name: "RpcError",
      message:
        typeof payload.error === "string" ? payload.error : `RPC handler "${segments[2]}" failed.`,
    };
  }
  routeTrace.endedAt = nowIso();
  if (runtime.traceStore != null) {
    await runtime.traceStore.saveTrace(routeTrace);
  }

  return jsonResponse(
    kernelResponse.status,
    kernelResponse.ok
      ? {
          ok: true,
          rpc: segments[1],
          handler: segments[2],
          data: payload.output,
          traceId: payload.traceId,
        }
      : {
          ok: false,
          error: payload.error,
          traceId: payload.traceId,
        },
    warnings,
  );
}

async function dispatchMcpViaKernelRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
): Promise<Response> {
  const registration = requireActiveRegistration();
  const warnings = registration.warnings;
  const segments = getPathSegments(request);
  if (segments[0] !== "mcp" || segments[1] == null) {
    return badRequest('MCP requests must use "/mcp/:mcpName".', warnings);
  }

  const mcp = registration.project.mcp.get(segments[1]);
  if (mcp == null) {
    return notFound(`MCP surface "${segments[1]}" was not found.`, warnings);
  }

  if (request.method === "GET") {
    return jsonResponse(
      200,
      {
        ok: true,
        mcp: segments[1],
        tools: mcp.tools.map((tool) => {
          const { definition, jsonSchema } = buildToolDefinition(tool as never);
          return {
            name: definition.name,
            description: definition.description,
            ...(jsonSchema != null ? { inputJsonSchema: jsonSchema } : {}),
          };
        }),
      },
      warnings,
    );
  }

  const payload = await request.clone().json().catch(() => ({}));
  const params = isRecord(payload) && isRecord(payload.params) ? payload.params : {};
  const toolName =
    typeof params.name === "string"
      ? params.name
      : isRecord(payload) && typeof payload.tool === "string"
        ? payload.tool
        : undefined;

  if (
    isRecord(payload) &&
    typeof payload.method === "string" &&
    payload.method === "tools/list"
  ) {
    return jsonResponse(
      200,
      {
        ok: true,
        result: {
          tools: mcp.tools.map((tool) => {
            const { definition, jsonSchema } = buildToolDefinition(tool as never);
            return {
              name: definition.name,
              description: definition.description,
              ...(jsonSchema != null ? { inputJsonSchema: jsonSchema } : {}),
            };
          }),
        },
      },
      warnings,
    );
  }

  if (toolName == null) {
    return badRequest(
      'MCP calls require method "tools/list" or a tool name via params.name / tool.',
      warnings,
    );
  }

  const tool = mcp.tools.find((candidate) => getTargetId(candidate as never) === toolName);
  if (tool == null) {
    return notFound(`Tool "${toolName}" was not found in MCP surface "${segments[1]}".`, warnings);
  }

  const toolInput =
    "arguments" in params
      ? params.arguments
      : isRecord(payload) && "input" in payload
        ? payload.input
        : params;

  const kernelResponse = await forwardKernelJsonRequest(
    request,
    env,
    `/kernel/tool/${encodeURIComponent(getTargetId(tool as never))}`,
    {
      input: toolInput,
    },
  );
  const kernelPayload = (await kernelResponse.json()) as Record<string, unknown>;
  return jsonResponse(
    kernelResponse.status,
    kernelResponse.ok
      ? {
          ok: true,
          result: kernelPayload.output,
          traceId: kernelPayload.traceId,
        }
      : {
          ok: false,
          error: kernelPayload.error,
          traceId: kernelPayload.traceId,
        },
    warnings,
  );
}

type SqlClientLike = {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
};

function kernelStateNamespace(sessionId: string | undefined): string {
  return sessionId == null || sessionId.length === 0 ? "__global__" : sessionId;
}

function readKernelPath(value: unknown, path: string | undefined): unknown {
  if (path == null || path.trim().length === 0) {
    return value;
  }

  let current: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

class SqliteKernelPersistence implements KernelPersistence {
  constructor(private readonly client: SqlClientLike) {
    this.initSchema();
  }

  private initSchema(): void {
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_traces (
      run_id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      trace_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_artifacts (
      artifact_id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_active_artifacts (
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (target_kind, target_id)
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_tool_results (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      trace_id TEXT,
      created_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_state_entries (
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      body_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, entry_key)
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_corpora (
      corpus_id TEXT PRIMARY KEY,
      corpus_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_rlm_runs (
      run_id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      trace_id TEXT NOT NULL,
      context_manifest_json TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    )`;
    void this.client.sql`CREATE TABLE IF NOT EXISTS so_rlm_steps (
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      reasoning TEXT,
      code TEXT NOT NULL,
      stdout TEXT,
      stderr TEXT,
      logs_json TEXT NOT NULL,
      tool_calls_json TEXT,
      submitted_json TEXT,
      submit_validation_error_json TEXT,
      error_json TEXT,
      query_calls_used INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (run_id, step_index)
    )`;
  }

  async saveTrace(trace: RunTraceLike): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_traces (
      run_id,
      target_kind,
      target_id,
      trace_json,
      created_at
    ) VALUES (
      ${trace.runId},
      ${trace.targetKind},
      ${trace.targetId},
      ${JSON.stringify(trace)},
      ${trace.startedAt}
    )`;
  }

  async loadTrace(runId: string): Promise<RunTraceLike | null> {
    const rows = this.client.sql<{ trace_json: string }>`SELECT trace_json FROM so_traces WHERE run_id = ${runId} LIMIT 1`;
    return rows[0] == null ? null : (JSON.parse(rows[0].trace_json) as RunTraceLike);
  }

  async listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]> {
    const rows = this.client.sql<{ trace_json: string }>`SELECT trace_json FROM so_traces ORDER BY created_at DESC`;
    const traces = rows
      .map((row) => JSON.parse(row.trace_json) as RunTraceLike)
      .filter((trace) => {
        if (args?.targetKind != null && trace.targetKind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && trace.targetId !== args.targetId) {
          return false;
        }
        return true;
      });
    return args?.limit != null ? traces.slice(0, args.limit) : traces;
  }

  async saveToolResult(value: {
    id: string;
    sessionId?: string;
    toolName: string;
    input: unknown;
    output?: unknown;
    traceId?: string;
    createdAt: string;
  }): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_tool_results (
      id,
      session_id,
      tool_name,
      input_json,
      output_json,
      trace_id,
      created_at
    ) VALUES (
      ${value.id},
      ${value.sessionId ?? null},
      ${value.toolName},
      ${JSON.stringify(value.input)},
      ${value.output === undefined ? null : JSON.stringify(value.output)},
      ${value.traceId ?? null},
      ${value.createdAt}
    )`;
  }

  async loadLatestToolResult(args: {
    sessionId?: string;
    toolName: string;
    resultId?: string;
  }): Promise<{
    id: string;
    sessionId?: string;
    toolName: string;
    input: unknown;
    output?: unknown;
    traceId?: string;
    createdAt: string;
  } | null> {
    const rows = this.client.sql<{
      id: string;
      session_id: string | null;
      tool_name: string;
      input_json: string;
      output_json: string | null;
      trace_id: string | null;
      created_at: string;
    }>`SELECT id, session_id, tool_name, input_json, output_json, trace_id, created_at
       FROM so_tool_results
       ORDER BY created_at DESC`;

    const match = rows.find((row) => {
      if (row.tool_name !== args.toolName) {
        return false;
      }
      if (args.resultId != null) {
        return row.id === args.resultId;
      }
      if (args.sessionId != null) {
        return row.session_id === args.sessionId;
      }
      return true;
    });

    if (match == null) {
      return null;
    }

    return {
      id: match.id,
      ...(match.session_id != null ? { sessionId: match.session_id } : {}),
      toolName: match.tool_name,
      input: JSON.parse(match.input_json),
      ...(match.output_json != null ? { output: JSON.parse(match.output_json) } : {}),
      ...(match.trace_id != null ? { traceId: match.trace_id } : {}),
      createdAt: match.created_at,
    };
  }

  async appendChatMessage(message: {
    id: string;
    sessionId: string;
    role: "system" | "user" | "assistant" | "tool";
    body: unknown;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }): Promise<void> {
    const payload =
      message.metadata == null
        ? message.body
        : {
            body: message.body,
            metadata: message.metadata,
          };
    void this.client.sql`INSERT OR REPLACE INTO so_chat_messages (
      id,
      session_id,
      role,
      body_json,
      created_at
    ) VALUES (
      ${message.id},
      ${message.sessionId},
      ${message.role},
      ${JSON.stringify(payload)},
      ${message.createdAt}
    )`;
  }

  async listChatMessages(args: {
    sessionId: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      sessionId: string;
      role: "system" | "user" | "assistant" | "tool";
      body: unknown;
      metadata?: Record<string, unknown>;
      createdAt: string;
    }>
  > {
    const rows = this.client.sql<{
      id: string;
      session_id: string;
      role: "system" | "user" | "assistant" | "tool";
      body_json: string;
      created_at: string;
    }>`SELECT id, session_id, role, body_json, created_at
       FROM so_chat_messages
       WHERE session_id = ${args.sessionId}
       ORDER BY created_at ASC`;

    const values = rows.map((row) => {
      const parsed = JSON.parse(row.body_json) as unknown;
      const body =
        isRecord(parsed) && "body" in parsed
          ? (parsed as { body: unknown }).body
          : parsed;
      const metadata =
        isRecord(parsed) && isRecord(parsed.metadata)
          ? (parsed.metadata as Record<string, unknown>)
          : undefined;

      return {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        body,
        ...(metadata != null ? { metadata } : {}),
        createdAt: row.created_at,
      };
    });
    return args.limit != null ? values.slice(-args.limit) : values;
  }

  async saveArtifact(
    artifact: NonNullable<
      Awaited<ReturnType<NonNullable<RuntimeContextLike["artifactStore"]>["loadArtifact"]>>
    >,
  ): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_artifacts (
      artifact_id,
      target_kind,
      target_id,
      artifact_json,
      created_at
    ) VALUES (
      ${artifact.id},
      ${artifact.target.kind},
      ${artifact.target.id},
      ${JSON.stringify(artifact)},
      ${artifact.createdAt}
    )`;
  }

  async loadArtifact(
    id: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeContextLike["artifactStore"]>["loadArtifact"]>>
  > {
    const rows = this.client.sql<{ artifact_json: string }>`
      SELECT artifact_json FROM so_artifacts WHERE artifact_id = ${id} LIMIT 1
    `;
    return rows[0] == null ? null : JSON.parse(rows[0].artifact_json);
  }

  async listArtifacts(args?: {
    targetKind?: ArtifactTargetKindLike;
    targetId?: string;
    limit?: number;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<NonNullable<RuntimeContextLike["artifactStore"]>["listArtifacts"]>>
    >
  > {
    const rows = this.client.sql<{ artifact_json: string }>`
      SELECT artifact_json FROM so_artifacts ORDER BY created_at DESC
    `;
    const artifacts = rows
      .map((row) => JSON.parse(row.artifact_json) as NonNullable<
        Awaited<ReturnType<NonNullable<RuntimeContextLike["artifactStore"]>["loadArtifact"]>>
      >)
      .filter((artifact) => {
        if (args?.targetKind != null && artifact.target.kind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && artifact.target.id !== args.targetId) {
          return false;
        }
        return true;
      });

    return args?.limit != null ? artifacts.slice(0, args.limit) : artifacts;
  }

  async loadActiveArtifact(args: {
    targetKind: ArtifactTargetKindLike;
    targetId: string;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<RuntimeContextLike["artifactStore"]>["loadActiveArtifact"]>
    >
  > {
    const rows = this.client.sql<{ artifact_id: string }>`
      SELECT artifact_id
      FROM so_active_artifacts
      WHERE target_kind = ${args.targetKind} AND target_id = ${args.targetId}
      LIMIT 1
    `;
    const artifactId = rows[0]?.artifact_id;
    return artifactId == null ? null : this.loadArtifact(artifactId);
  }

  async setActiveArtifact(args: {
    targetKind: ArtifactTargetKindLike;
    targetId: string;
    artifactId: string;
  }): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_active_artifacts (
      target_kind,
      target_id,
      artifact_id,
      updated_at
    ) VALUES (
      ${args.targetKind},
      ${args.targetId},
      ${args.artifactId},
      ${nowIso()}
    )`;
  }

  async loadState(args: { sessionId?: string; key: string; path?: string }): Promise<unknown> {
    const rows = this.client.sql<{ body_json: string }>`
      SELECT body_json
      FROM so_state_entries
      WHERE namespace = ${kernelStateNamespace(args.sessionId)} AND entry_key = ${args.key}
      LIMIT 1
    `;
    if (rows[0] == null) {
      return undefined;
    }
    return readKernelPath(JSON.parse(rows[0].body_json), args.path);
  }

  async saveState(args: { sessionId?: string; key: string; value: unknown }): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_state_entries (
      namespace,
      entry_key,
      body_json,
      updated_at
    ) VALUES (
      ${kernelStateNamespace(args.sessionId)},
      ${args.key},
      ${JSON.stringify(args.value)},
      ${nowIso()}
    )`;
  }

  async saveCorpus(value: KernelStoredCorpus): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_corpora (
      corpus_id,
      corpus_json,
      created_at,
      updated_at
    ) VALUES (
      ${value.corpus.id},
      ${JSON.stringify(value.corpus)},
      ${value.createdAt},
      ${value.updatedAt}
    )`;
  }

  async loadCorpus(corpusId: string): Promise<KernelStoredCorpus | null> {
    const rows = this.client.sql<{
      corpus_json: string;
      created_at: string;
      updated_at: string;
    }>`
      SELECT corpus_json, created_at, updated_at
      FROM so_corpora
      WHERE corpus_id = ${corpusId}
      LIMIT 1
    `;
    if (rows[0] == null) {
      return null;
    }
    return {
      corpus: JSON.parse(rows[0].corpus_json),
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    };
  }

  async listCorpora(): Promise<KernelStoredCorpus[]> {
    const rows = this.client.sql<{
      corpus_json: string;
      created_at: string;
      updated_at: string;
    }>`
      SELECT corpus_json, created_at, updated_at
      FROM so_corpora
      ORDER BY corpus_id ASC
    `;
    return rows.map((row) => ({
      corpus: JSON.parse(row.corpus_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveRlmRun(value: {
    runId: string;
    moduleId: string;
    sessionId?: string;
    status: "running" | "completed" | "failed";
    input: unknown;
    output?: unknown;
    error?: unknown;
    traceId: string;
    contextManifest?: unknown;
    startedAt: string;
    endedAt?: string;
    updatedAt: string;
  }): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_rlm_runs (
      run_id,
      module_id,
      session_id,
      status,
      input_json,
      output_json,
      error_json,
      trace_id,
      context_manifest_json,
      started_at,
      ended_at,
      updated_at
    ) VALUES (
      ${value.runId},
      ${value.moduleId},
      ${value.sessionId ?? null},
      ${value.status},
      ${JSON.stringify(value.input)},
      ${value.output === undefined ? null : JSON.stringify(value.output)},
      ${value.error === undefined ? null : JSON.stringify(value.error)},
      ${value.traceId},
      ${value.contextManifest === undefined ? null : JSON.stringify(value.contextManifest)},
      ${value.startedAt},
      ${value.endedAt ?? null},
      ${value.updatedAt}
    )`;
  }

  async loadRlmRun(runId: string): Promise<KernelStoredRlmRun | null> {
    const rows = this.client.sql<{
      run_id: string;
      module_id: string;
      session_id: string | null;
      status: "running" | "completed" | "failed";
      input_json: string;
      output_json: string | null;
      error_json: string | null;
      trace_id: string;
      context_manifest_json: string | null;
      started_at: string;
      ended_at: string | null;
      updated_at: string;
    }>`
      SELECT
        run_id,
        module_id,
        session_id,
        status,
        input_json,
        output_json,
        error_json,
        trace_id,
        context_manifest_json,
        started_at,
        ended_at,
        updated_at
      FROM so_rlm_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    if (rows[0] == null) {
      return null;
    }

    return {
      runId: rows[0].run_id,
      moduleId: rows[0].module_id,
      ...(rows[0].session_id != null ? { sessionId: rows[0].session_id } : {}),
      status: rows[0].status,
      input: JSON.parse(rows[0].input_json),
      ...(rows[0].output_json != null ? { output: JSON.parse(rows[0].output_json) } : {}),
      ...(rows[0].error_json != null ? { error: JSON.parse(rows[0].error_json) } : {}),
      traceId: rows[0].trace_id,
      ...(rows[0].context_manifest_json != null
        ? { contextManifest: JSON.parse(rows[0].context_manifest_json) }
        : {}),
      startedAt: rows[0].started_at,
      ...(rows[0].ended_at != null ? { endedAt: rows[0].ended_at } : {}),
      updatedAt: rows[0].updated_at,
    };
  }

  async saveRlmStep(value: KernelStoredRlmStep): Promise<void> {
    void this.client.sql`INSERT OR REPLACE INTO so_rlm_steps (
      run_id,
      step_index,
      reasoning,
      code,
      stdout,
      stderr,
      logs_json,
      tool_calls_json,
      submitted_json,
      submit_validation_error_json,
      error_json,
      query_calls_used,
      started_at,
      ended_at
    ) VALUES (
      ${value.runId},
      ${value.stepIndex},
      ${value.reasoning ?? null},
      ${value.code},
      ${value.stdout ?? null},
      ${value.stderr ?? null},
      ${JSON.stringify(value.logs)},
      ${value.toolCalls === undefined ? null : JSON.stringify(value.toolCalls)},
      ${value.submitted === undefined ? null : JSON.stringify(value.submitted)},
      ${value.submitValidationError === undefined ? null : JSON.stringify(value.submitValidationError)},
      ${value.error === undefined ? null : JSON.stringify(value.error)},
      ${value.queryCallsUsed ?? null},
      ${value.startedAt},
      ${value.endedAt ?? null}
    )`;
  }

  async listRlmSteps(runId: string): Promise<KernelStoredRlmStep[]> {
    const rows = this.client.sql<{
      run_id: string;
      step_index: number;
      reasoning: string | null;
      code: string;
      stdout: string | null;
      stderr: string | null;
      logs_json: string;
      tool_calls_json: string | null;
      submitted_json: string | null;
      submit_validation_error_json: string | null;
      error_json: string | null;
      query_calls_used: number | null;
      started_at: string;
      ended_at: string | null;
    }>`
      SELECT
        run_id,
        step_index,
        reasoning,
        code,
        stdout,
        stderr,
        logs_json,
        tool_calls_json,
        submitted_json,
        submit_validation_error_json,
        error_json,
        query_calls_used,
        started_at,
        ended_at
      FROM so_rlm_steps
      WHERE run_id = ${runId}
      ORDER BY step_index ASC
    `;

    return rows.map((row) => ({
      runId: row.run_id,
      stepIndex: row.step_index,
      ...(row.reasoning != null ? { reasoning: row.reasoning } : {}),
      code: row.code,
      ...(row.stdout != null ? { stdout: row.stdout } : {}),
      ...(row.stderr != null ? { stderr: row.stderr } : {}),
      logs: JSON.parse(row.logs_json),
      ...(row.tool_calls_json != null ? { toolCalls: JSON.parse(row.tool_calls_json) } : {}),
      ...(row.submitted_json != null ? { submitted: JSON.parse(row.submitted_json) } : {}),
      ...(row.submit_validation_error_json != null
        ? { submitValidationError: JSON.parse(row.submit_validation_error_json) }
        : {}),
      ...(row.error_json != null ? { error: JSON.parse(row.error_json) } : {}),
      ...(row.query_calls_used != null ? { queryCallsUsed: row.query_calls_used } : {}),
      startedAt: row.started_at,
      ...(row.ended_at != null ? { endedAt: row.ended_at } : {}),
    }));
  }
}

export class ModuleKernel extends AgentBase {
  initialState = {
    ready: true,
  };
  protected readonly hostedEnv: CloudflareEnvLike;
  private readonly persistence: SqliteKernelPersistence;
  private readonly hostedRlmSessionManager: CloudflareHostedRlmSessionManager;

  constructor(state: unknown, env: CloudflareEnvLike) {
    super(state, env);
    this.hostedEnv = env;
    this.persistence = new SqliteKernelPersistence(this as unknown as SqlClientLike);
    this.hostedRlmSessionManager = createFacetBackedRlmSessionManager(this);
  }

  async getRlmFacetStub(runId: string): Promise<{
    init(args: unknown): Promise<unknown>;
    describe(): Promise<{ trackedNames: string[] }>;
    exportState(): Promise<unknown>;
    applyStepResult(args: unknown): Promise<unknown>;
    checkpoint(value: unknown): Promise<void>;
    resume(): Promise<unknown>;
    close(): Promise<unknown>;
  }> {
    const self = this as unknown as {
      ctx?: {
        facets?: {
          get(
            name: string,
            getStartupOptions: () => Promise<{ class: unknown }> | { class: unknown },
          ): {
            init(args: unknown): Promise<unknown>;
            describe(): Promise<{ trackedNames: string[] }>;
            exportState(): Promise<unknown>;
            applyStepResult(args: unknown): Promise<unknown>;
            checkpoint(value: unknown): Promise<void>;
            resume(): Promise<unknown>;
            close(): Promise<unknown>;
          };
          delete(name: string): void;
        };
        exports?: Record<string, unknown>;
      };
    };
    if (self.ctx?.facets == null || this.hostedEnv.LOADER == null) {
      throw new Error("Facet-backed RLM sessions require Durable Object facets and a LOADER binding.");
    }

    return self.ctx.facets.get(getFacetName(runId), async () => {
      const worker = (this.hostedEnv.LOADER as {
        get(
          name: string,
          getCode: () => {
            compatibilityDate: string;
            mainModule: string;
            modules: Record<string, string>;
            env: Record<string, unknown>;
            globalOutbound: null;
          },
        ): {
          getDurableObjectClass(name: string): unknown;
        };
      }).get("superobjective_rlm_facet_v1", () => ({
        compatibilityDate: "2026-04-19",
        mainModule: "facet.js",
        modules: {
          "facet.js": buildRlmFacetWorkerSource(),
        },
        env: {},
        globalOutbound: null,
      }));

      return {
        class: worker.getDurableObjectClass("RlmSessionFacet"),
      };
    });
  }

  getRlmRuntimeHostBinding(runId: string): unknown {
    const self = this as unknown as {
      ctx?: {
        exports?: Record<string, unknown>;
      };
    };
    const hostBinding = self.ctx?.exports?.RlmRuntimeHost;
    if (hostBinding == null) {
      throw new Error("RLM runtime host binding is not available on this worker.");
    }
    return typeof hostBinding === "function"
      ? (hostBinding as (args?: { props?: Record<string, unknown> }) => unknown)({
          props: {
            facet: getFacetName(runId),
            runId,
          },
        })
      : hostBinding;
  }

  getRlmLoader() {
    return this.hostedEnv.LOADER;
  }

  deleteRlmFacet(runId: string): void {
    const self = this as unknown as {
      ctx?: {
        facets?: {
          delete(name: string): void;
        };
      };
    };
    self.ctx?.facets?.delete(getFacetName(runId));
  }

  async onRequest(request: Request): Promise<Response> {
    const fiberCapable = this as unknown as {
      runFiber?: <T>(
        name: string,
        fn: (fiber: { stash(value: unknown): void; snapshot?: unknown }) => Promise<T>,
      ) => Promise<T>;
    };
    return dispatchKernelRequest(
      request,
      this.hostedEnv,
      this.persistence,
      typeof fiberCapable.runFiber === "function"
        ? {
            runFiber: fiberCapable.runFiber.bind(this),
          }
        : undefined,
      this.hostedRlmSessionManager,
      typeof (this as unknown as { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } }).ctx?.waitUntil ===
        "function"
        ? (this as unknown as { ctx: { waitUntil: (promise: Promise<unknown>) => void } }).ctx.waitUntil.bind(
            (this as unknown as { ctx: { waitUntil: (promise: Promise<unknown>) => void } }).ctx,
          )
        : undefined,
    );
  }

  async onFiberRecovered(state: { name?: string; snapshot?: unknown }): Promise<void> {
    if (typeof state.name !== "string" || !state.name.startsWith("rlm:") || !isRecord(state.snapshot)) {
      return;
    }

    const snapshot = state.snapshot;
    if (snapshot.route !== "kernel.rlm" || typeof snapshot.moduleId !== "string") {
      return;
    }

    const registration = requireActiveRegistration();
    const target = findRlmProgram(registration.project, snapshot.moduleId);
    if (target == null) {
      return;
    }

    const payload = isRecord(snapshot.payload) ? snapshot.payload : {};
    const input = "input" in payload ? payload.input : payload;
    const runtime = createBoundRuntime(this.hostedEnv, registration);
    const resumedRuntime = {
      ...runtime,
      traceStore: registration.options.runtime?.traceStore ?? this.persistence,
      artifactStore: registration.options.runtime?.artifactStore ?? this.persistence,
      __superobjectiveCloudflareInternal: {
        rlmSessionManager: this.hostedRlmSessionManager,
      },
      ...(typeof snapshot.runId === "string"
        ? {
            __superobjectiveRlmResume: {
              runId: snapshot.runId,
            },
          }
        : {}),
    } as RuntimeContextLike;
    await executeKernelTarget({
      target,
      input,
      runtime: resumedRuntime,
      env: this.hostedEnv,
      ...(typeof snapshot.sessionId === "string" ? { sessionId: snapshot.sessionId } : {}),
      persistence: this.persistence,
      metadata: {
        route: "kernel.rlm.recovered",
        moduleId: snapshot.moduleId,
        recovered: true,
      },
    });
  }
}

export class RpcHost extends AgentBase {
  initialState = {
    ready: true,
  };
  protected readonly hostedEnv: CloudflareEnvLike;

  constructor(state: unknown, env: CloudflareEnvLike) {
    super(state, env);
    this.hostedEnv = env;
  }

  async onRequest(request: Request): Promise<Response> {
    return dispatchRpcViaKernelRequest(request, this.hostedEnv);
  }
}

export class HostedAgentRouteHost extends ThinkBase {
  initialState = {
    ready: true,
  };
  protected readonly hostedEnv: CloudflareEnvLike;
  protected activeTurn: ActiveAgentTurn | null = null;

  constructor(state: unknown, env: CloudflareEnvLike) {
    super(state, env);
    this.hostedEnv = env;
  }

  async onRequest(request: Request): Promise<Response> {
    const route = this.parseAgentRoute(request);
    if (route == null) {
      return badRequest(
        'Agent requests must use "/agents/:agentName/:sessionId".',
        this.getWarnings(),
      );
    }

    const agent = this.resolveProjectAgent(route.agentName);
    if (agent == null) {
      return notFound(`Agent "${route.agentName}" was not found.`, this.getWarnings());
    }

    if (request.method === "GET") {
      return jsonResponse(
        200,
        {
          ok: true,
          agent: agent.name,
          sessionId: route.sessionId,
          system: await this.resolveAgentSystemPrompt(agent, undefined),
          tools: this.describeAgentTools(agent),
        },
        this.getWarnings(),
      );
    }

    const payload = await parseRequestInput(request);
    if (payload == null) {
      return badRequest(
        "Agent requests require a JSON body or ?input= query parameter.",
        this.getWarnings(),
      );
    }

    if (isRecord(payload) && typeof payload.tool === "string") {
      return this.handleDirectToolCall(route.agentName, route.sessionId, request, agent, payload);
    }

    return this.handleThinkChatTurn(route.agentName, route.sessionId, request, agent, payload);
  }

  getModel(): LanguageModel {
    const runtime = this.getBoundRuntime();
    const configuredModel = runtime.model as Record<string, unknown> | string | undefined;

    if (configuredModel != null && typeof configuredModel === "object" && "languageModel" in configuredModel) {
      return configuredModel.languageModel as LanguageModel;
    }

    const modelId =
      typeof configuredModel === "string"
        ? configuredModel
        : typeof configuredModel?.model === "string"
          ? configuredModel.model
          : null;
    if (modelId == null) {
      throw new Error(
        "HostedAgentRouteHost requires runtime.model to be a Workers AI model id or a languageModel-capable handle.",
      );
    }

    const bindingName =
      typeof configuredModel === "object" && typeof configuredModel?.binding === "string"
        ? configuredModel.binding
        : "AI";
    const binding = this.hostedEnv[bindingName];
    if (binding == null) {
      throw new Error(`Workers AI binding "${bindingName}" was not found in the Cloudflare env.`);
    }

    const provider = createWorkersAI({
      binding,
    } as Parameters<typeof createWorkersAI>[0]);

    const settings: Record<string, unknown> = {
      sessionAffinity: this.getThinkHost().sessionAffinity ?? this.getInstanceName(),
    };

    if (typeof configuredModel === "object" && configuredModel?.gateway != null) {
      settings.gateway = configuredModel.gateway;
    }

    return provider(modelId, settings);
  }

  getTools(): ToolSet {
    const agent = this.resolveCurrentProjectAgent();
    if (agent == null) {
      return {};
    }

    const tools: ToolSet = {};
    const targets: HostedRouteTarget[] = [agent.chat, ...(agent.tools ?? [])];

    for (const target of targets) {
      const { definition } = buildToolDefinition(toHostingProjectTarget(target));
      const targetName = definition.name;
      const targetDescription =
        target === agent.chat
          ? definition.description ?? `Run the primary Superobjective agent flow for "${agent.name}".`
          : definition.description;

      tools[targetName] = createTool({
        description: targetDescription ?? targetName,
        inputSchema: definition.inputSchema ?? z.any(),
        execute: async (input: unknown) => {
          const activeTurn = this.activeTurn;
          if (activeTurn == null) {
            throw new Error("No active Think turn is available for Superobjective tool execution.");
          }

          const { output, responseTraceId } = await this.executeHostedTarget(
            target,
            input,
            activeTurn.routeContext,
            activeTurn.routeTrace,
            activeTurn.sessionId,
          );

          if (target === agent.chat) {
            activeTurn.responseData = output;
          }
          if (responseTraceId != null) {
            activeTurn.responseTraceId = responseTraceId;
          }

          return output;
        },
      });
    }

    return tools;
  }

  async beforeTurn(ctx: { system: string }): Promise<{ system: string }> {
    const agent = this.resolveCurrentProjectAgent();
    if (agent == null) {
      return {
        system: ctx.system,
      };
    }

    const system = await this.resolveAgentSystemPrompt(agent, this.activeTurn?.userInput);
    return {
      system,
    };
  }

  onStepFinish(ctx: Record<string, unknown>): void {
    if (this.activeTurn == null) {
      return;
    }

    const model = this.getModel() as Record<string, unknown>;
    const usage = isRecord(ctx.usage)
      ? {
          ...(typeof ctx.usage.inputTokens === "number"
            ? { inputTokens: ctx.usage.inputTokens }
            : {}),
          ...(typeof ctx.usage.outputTokens === "number"
            ? { outputTokens: ctx.usage.outputTokens }
            : {}),
          ...(typeof ctx.usage.totalTokens === "number"
            ? { totalTokens: ctx.usage.totalTokens }
            : {}),
        }
      : undefined;

    this.activeTurn.routeTrace.modelCalls.push({
      provider: typeof model.provider === "string" ? model.provider : "cloudflare-workers-ai",
      model: typeof model.modelId === "string" ? model.modelId : "unknown",
      messages: [],
      ...(usage != null && Object.keys(usage).length > 0 ? { tokenUsage: usage } : {}),
      ...(typeof ctx.finishReason === "string" ? { finishReason: ctx.finishReason } : {}),
      ...(isRecord(ctx.response) ? { rawResponse: ctx.response } : {}),
    });
  }

  onChatResponse(result: { message: UIMessage }): void {
    if (this.activeTurn == null) {
      return;
    }
    this.activeTurn.assistantMessage = result.message;
    this.activeTurn.assistantText = this.extractAssistantText(result.message);
  }

  onChatError(error: unknown): unknown {
    if (this.activeTurn != null) {
      this.activeTurn.error = error;
    }
    return error;
  }

  private getRegistration(): RegisteredWorker {
    return requireActiveRegistration();
  }

  private getWarnings(): string[] {
    return this.getRegistration().warnings;
  }

  private getBoundRuntime(): RuntimeContextLike {
    return bindRuntimeEnv(
      {
        ...this.getRegistration().options.runtime,
        structuredGeneration:
          this.getRegistration().options.runtime?.structuredGeneration ?? createAiSdkBridge(),
      },
      this.hostedEnv,
    );
  }

  private getThinkHost(): ThinkHostLike {
    return this as unknown as ThinkHostLike;
  }

  private getInstanceName(): string {
    return typeof (this as { name?: unknown }).name === "string"
      ? ((this as unknown as { name: string }).name as string)
      : "";
  }

  private resolveCurrentProjectAgent(): AgentLike | null {
    const [agentName] = decodeHostInstanceName(this.getInstanceName());
    return agentName != null ? this.resolveProjectAgent(agentName) : null;
  }

  private resolveProjectAgent(agentName: string): AgentLike | null {
    return this.getRegistration().project.agents.get(agentName) ?? null;
  }

  private parseAgentRoute(request: Request): { agentName: string; sessionId: string } | null {
    const segments = getPathSegments(request);
    if (segments[0] !== "agents" || segments[1] == null || segments[2] == null) {
      return null;
    }
    return {
      agentName: segments[1],
      sessionId: segments[2],
    };
  }

  private describeAgentTools(agent: AgentLike) {
    return [agent.chat, ...(agent.tools ?? [])].map((target) => {
      const { definition, jsonSchema } = buildToolDefinition(
        toHostingProjectTarget(target as HostedRouteTarget),
      );
      return {
        name: definition.name,
        description: definition.description,
        ...(jsonSchema != null ? { inputJsonSchema: jsonSchema } : {}),
      };
    });
  }

  private async handleDirectToolCall(
    agentName: string,
    sessionId: string,
    request: Request,
    agent: AgentLike,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    const tool = (agent.tools ?? []).find(
      (candidate: HostedRouteTarget) => getTargetId(candidate) === payload.tool,
    );
    if (tool == null) {
      return notFound(`Tool "${payload.tool}" was not found on agent "${agentName}".`, this.getWarnings());
    }

    const toolInput = "input" in payload ? payload.input : payload;
    const routeTrace = createRouteTrace(`${agent.name}:${sessionId}`, "agent", payload, {
      route: "agent",
      agent: agentName,
      sessionId,
    });
    const routeContext = {
      runtime: this.getBoundRuntime(),
      env: this.hostedEnv,
      request,
      warnings: this.getWarnings(),
    };

    try {
      const kernelResponse = await forwardKernelJsonRequest(
        request,
        this.hostedEnv,
        `/kernel/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(sessionId)}/message`,
        {
          tool: payload.tool,
          input: toolInput,
        },
      );
      const kernelPayload = (await kernelResponse.json()) as Record<string, unknown>;
      if (!kernelResponse.ok) {
        throw Object.assign(
          new Error(
            typeof kernelPayload.error === "string"
              ? kernelPayload.error
              : `Kernel execution failed for tool "${String(payload.tool)}".`,
          ),
          {
            traceId:
              typeof kernelPayload.traceId === "string" ? kernelPayload.traceId : routeTrace.runId,
          },
        );
      }

      const output = "output" in kernelPayload ? kernelPayload.output : kernelPayload.data;
      const responseTraceId =
        typeof kernelPayload.traceId === "string" ? kernelPayload.traceId : routeTrace.runId;
      routeTrace.output = output;
      await this.persistTrace(routeContext, routeTrace);
      return jsonResponse(
        200,
        {
          ok: true,
          agent: agentName,
          sessionId,
          tool: payload.tool,
          data: output,
          traceId: responseTraceId ?? routeTrace.runId,
        },
        this.getWarnings(),
      );
    } catch (error) {
      routeTrace.error = serializeError(error);
      await this.persistTrace(routeContext, routeTrace);
      return jsonResponse(
        500,
        {
          ok: false,
          error: routeTrace.error.message,
          traceId: routeTrace.runId,
        },
        this.getWarnings(),
      );
    }
  }

  private async handleThinkChatTurn(
    agentName: string,
    sessionId: string,
    request: Request,
    agent: AgentLike,
    payload: unknown,
  ): Promise<Response> {
    const routeTrace = createRouteTrace(`${agent.name}:${sessionId}`, "agent", payload, {
      route: "agent",
      agent: agentName,
      sessionId,
      host: "think",
    });
    const routeContext = {
      runtime: this.getBoundRuntime(),
      env: this.hostedEnv,
      request,
      warnings: this.getWarnings(),
    };

    const stable = await this.getThinkHost().waitUntilStable({ timeout: 30_000 });
    if (!stable) {
      return jsonResponse(
        409,
        {
          ok: false,
          error: `Agent "${agentName}" is still processing a prior turn for session "${sessionId}".`,
        },
        this.getWarnings(),
      );
    }

    this.activeTurn = {
      agentName,
      sessionId,
      routeTrace,
      routeContext,
      userInput: this.normalizeAgentInput(payload),
    };

    try {
      const saveResult = await this.getThinkHost().saveMessages([
        {
          id:
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
          role: "user",
          parts: [
            {
              type: "text",
              text: this.renderUserMessage(this.activeTurn.userInput),
            },
          ],
        },
      ]);

      const finalMessage =
        this.activeTurn.assistantMessage ??
        [...this.getThinkHost().getMessages()]
          .reverse()
          .find((message) => message.role === "assistant");
      const assistantText =
        this.activeTurn.assistantText ??
        (finalMessage != null ? this.extractAssistantText(finalMessage) : undefined);

      const responseData =
        this.normalizeAgentResponseData(this.activeTurn.responseData, assistantText) ??
        (assistantText != null ? { response: assistantText } : undefined);

      if (responseData !== undefined) {
        routeTrace.output = responseData;
      }
      if (this.activeTurn.error != null) {
        routeTrace.error = serializeError(this.activeTurn.error);
      }
      await this.persistTrace(routeContext, routeTrace);

      const traceId = this.activeTurn.responseTraceId ?? routeTrace.runId;
      if (this.activeTurn.error != null || saveResult.status === "skipped") {
        return jsonResponse(
          409,
          {
            ok: false,
            error:
              routeTrace.error?.message ??
              `Agent "${agentName}" skipped the Think turn for session "${sessionId}".`,
            traceId,
          },
          this.getWarnings(),
        );
      }

      return jsonResponse(
        200,
        {
          ok: true,
          agent: agentName,
          sessionId,
          data: responseData ?? { response: assistantText ?? "" },
          ...(assistantText != null ? { message: assistantText } : {}),
          traceId,
        },
        this.getWarnings(),
      );
    } catch (error) {
      routeTrace.error = serializeError(error);
      await this.persistTrace(routeContext, routeTrace);
      return jsonResponse(
        500,
        {
          ok: false,
          error: routeTrace.error.message,
          traceId: routeTrace.runId,
        },
        this.getWarnings(),
      );
    } finally {
      this.activeTurn = null;
    }
  }

  private normalizeAgentInput(payload: unknown): unknown {
    if (isRecord(payload) && "input" in payload) {
      return payload.input;
    }
    return payload;
  }

  private renderUserMessage(input: unknown): string {
    if (typeof input === "string") {
      return input;
    }

    if (isRecord(input)) {
      const subject = typeof input.subject === "string" ? input.subject.trim() : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (subject.length > 0 || body.length > 0) {
        return [`Subject: ${subject || "(none)"}`, body].filter(Boolean).join("\n\n");
      }
    }

    return stableStringify(input);
  }

  private async resolveAgentSystemPrompt(
    agent: AgentLike,
    userInput: unknown,
  ): Promise<string> {
    const runtime = this.getBoundRuntime();
    const activeArtifact =
      runtime.artifactStore == null
        ? null
        : await runtime.artifactStore.loadActiveArtifact({
            targetKind: "agent",
            targetId: agent.name,
          });
    const candidateSystem =
      activeArtifact?.textCandidate?.[`agent.${agent.name}.system`] ??
      (agent as { inspectTextCandidate?: () => Record<string, string> | undefined })
        .inspectTextCandidate?.()?.[`agent.${agent.name}.system`] ??
      resolveText(agent.system) ??
      "You are a Superobjective Cloudflare agent.";

    const chatTargetId = getTargetId(agent.chat);
    const structuredInput =
      userInput != null && userInput !== ""
        ? `\n\nCurrent request input (canonical structured form):\n${stableStringify(userInput)}`
        : "";

    return [
      candidateSystem,
      `You are executing the Superobjective agent "${agent.name}".`,
      `Use the server tool "${chatTargetId}" to run the canonical Superobjective chat flow for the current request.`,
      "Use any additional server tools only when they materially improve the answer.",
      'When a tool returns a user-facing field such as "response" or "customerReply", use that content as the basis for the final assistant reply.',
      "Do not fabricate tool results.",
    ].join("\n\n") + structuredInput;
  }

  private extractAssistantText(message: UIMessage): string {
    if (!Array.isArray((message as { parts?: unknown[] }).parts)) {
      return "";
    }
    return (message as { parts: Array<Record<string, unknown>> }).parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }

  private normalizeAgentResponseData(data: unknown, assistantText: string | undefined): unknown {
    if (data == null) {
      return assistantText != null ? { response: assistantText } : undefined;
    }
    if (isRecord(data)) {
      return data;
    }
    return {
      response: assistantText ?? String(data),
      result: data,
    };
  }

  private async executeHostedTarget(
    target: HostedRouteTarget,
    input: unknown,
    routeContext: ActiveAgentTurn["routeContext"],
    trace: RunTraceLike,
    sessionId?: string,
  ): Promise<{ output: unknown; responseTraceId?: string }> {
    const hostingTarget = toHostingProjectTarget(target);
    const inputSchema = getInputSchema(hostingTarget);
    const validatedInput = validateWithSchema(inputSchema, input);
    const targetId = getTargetId(hostingTarget);
    const targetKind = getTargetKind(hostingTarget);

    const component: RunTraceLike["components"][number] = {
      componentId: targetId,
      componentKind:
        targetKind === "tool" ? "tool" : targetKind === "program" ? "program" : "predict",
      startedAt: nowIso(),
      input: validatedInput,
      stdout: "",
    };
    trace.components.push(component);

    if (this.activeTurn != null) {
      const kernelPath =
        this.activeTurn.agentName != null
          ? `/kernel/agent/${encodeURIComponent(this.activeTurn.agentName)}/${encodeURIComponent(
              sessionId ?? this.activeTurn.sessionId,
            )}/message`
          : targetKind === "tool"
            ? `/kernel/tool/${encodeURIComponent(targetId)}`
            : `/kernel/run/${encodeURIComponent(targetId)}`;

      const kernelPayload =
        this.activeTurn.agentName != null
          ? "execute" in target
            ? { tool: targetId, input: validatedInput }
            : { input: validatedInput }
          : {
              ...(sessionId ? { sessionId } : {}),
              input: validatedInput,
            };

      const kernelResponse = await forwardKernelJsonRequest(
        routeContext.request,
        this.hostedEnv,
        kernelPath,
        kernelPayload,
      );
      const kernelResult = (await kernelResponse.json()) as Record<string, unknown>;
      if (!kernelResponse.ok) {
        throw Object.assign(
          new Error(
            typeof kernelResult.error === "string"
              ? kernelResult.error
              : `Kernel execution failed for "${targetId}".`,
          ),
          {
            traceId: typeof kernelResult.traceId === "string" ? kernelResult.traceId : trace.runId,
          },
        );
      }

      const output = "output" in kernelResult ? kernelResult.output : kernelResult.data;
      const outputSchema = getOutputSchema(hostingTarget);
      const validatedOutput = validateWithSchema(outputSchema, output);
      component.output = validatedOutput;
      component.endedAt = nowIso();

      return {
        output: validatedOutput,
        responseTraceId:
          typeof kernelResult.traceId === "string" ? kernelResult.traceId : trace.runId,
      };
    }

    const previousNestedTraceId =
      targetKind === "tool" ? undefined : await this.getLatestNestedTraceId(routeContext, target);

    try {
      let output: unknown;
      if ("execute" in target) {
        const toolStartedAt = nowIso();
        const toolStartedAtMs = Date.now();
        const logs: string[] = [];
        try {
          output = await target.execute(validatedInput as never, {
            runtime: routeContext.runtime,
            env: routeContext.env,
            request: routeContext.request,
            sessionId,
            trace,
            log(message: string) {
              logs.push(message);
            },
          });

          const toolCall: ToolCallTraceLike = {
            toolName: targetId,
            input: validatedInput,
            output,
            startedAt: toolStartedAt,
            endedAt: nowIso(),
            latencyMs: Date.now() - toolStartedAtMs,
            ...(logs.length > 0 ? { metadata: { logs } } : {}),
          };
          trace.toolCalls.push(toolCall);
        } catch (error) {
          trace.toolCalls.push({
            toolName: targetId,
            input: validatedInput,
            error: serializeError(error),
            startedAt: toolStartedAt,
            endedAt: nowIso(),
            latencyMs: Date.now() - toolStartedAtMs,
            ...(logs.length > 0 ? { metadata: { logs } } : {}),
          });
          throw error;
        }
      } else {
        if (typeof target.inspectPrompt === "function") {
          const inspected = await target.inspectPrompt(validatedInput, {
            runtime: routeContext.runtime,
          });
          if (isRecord(inspected)) {
            component.prompt = {
              adapterId:
                typeof inspected.adapterId === "string" ? inspected.adapterId : "unknown",
              adapterVersion:
                typeof inspected.adapterVersion === "string"
                  ? inspected.adapterVersion
                  : "unknown",
              messages: Array.isArray(inspected.messages) ? (inspected.messages as never) : [],
              ...(isRecord(inspected.output) && isRecord(inspected.output.jsonSchema)
                ? { outputJsonSchema: inspected.output.jsonSchema as Record<string, unknown> }
                : {}),
            };
          }
        }

        output = await target(validatedInput, {
          runtime: routeContext.runtime,
          env: routeContext.env,
          request: routeContext.request,
        });
      }

      const outputSchema = getOutputSchema(hostingTarget);
      const validatedOutput = validateWithSchema(outputSchema, output);
      component.output = validatedOutput;
      component.endedAt = nowIso();

      const latestTraceId =
        targetKind === "tool"
          ? trace.runId
          : await this.getLatestNestedTraceId(routeContext, target);

      return {
        output: validatedOutput,
        responseTraceId:
          targetKind !== "tool" &&
          latestTraceId != null &&
          latestTraceId !== previousNestedTraceId
            ? latestTraceId
            : trace.runId,
      };
    } catch (error) {
      component.error = serializeError(error);
      component.endedAt = nowIso();
      throw error;
    }
  }

  private async getLatestNestedTraceId(
    routeContext: ActiveAgentTurn["routeContext"],
    target: HostedRouteTarget,
  ): Promise<string | undefined> {
    const hostingTarget = toHostingProjectTarget(target);
    if (getTargetKind(hostingTarget) === "tool") {
      return undefined;
    }
    const traceStore = routeContext.runtime.traceStore;
    if (traceStore?.listTraces == null) {
      return undefined;
    }
    const traces = await traceStore.listTraces({
      targetKind: getTargetKind(hostingTarget),
      targetId: getTargetId(hostingTarget),
      limit: 1,
    });
    return traces[0]?.runId;
  }

  private async persistTrace(
    routeContext: ActiveAgentTurn["routeContext"],
    trace: RunTraceLike,
  ): Promise<void> {
    trace.endedAt = nowIso();
    if (routeContext.runtime.traceStore != null) {
      await routeContext.runtime.traceStore.saveTrace(trace);
    }
  }
}

export class HostedMcpRouteHost extends McpAgentBase {
  initialState = {
    ready: true,
  };
  protected readonly hostedEnv: CloudflareEnvLike;

  server = new McpServerBase({
    name: "superobjective-hosted-mcp",
    version: "0.1.0",
  });

  constructor(state: unknown, env: CloudflareEnvLike) {
    super(state, env);
    this.hostedEnv = env;
  }

  async init(): Promise<void> {}

  async onRequest(request: Request): Promise<Response> {
    return dispatchMcpViaKernelRequest(request, this.hostedEnv);
  }
}
