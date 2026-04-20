import { createWorkersAI } from "workers-ai-provider";
import { tool as createTool, type LanguageModel, type ToolSet, type UIMessage } from "ai";
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
  resolveText,
  serializeError,
  stableStringify,
  validateWithSchema,
} from "@superobjective/hosting";
import { createAiSdkBridge, bindRuntimeEnv } from "./runtime";
import type {
  AgentLike,
  CallableTargetLike,
  CloudflareEnvLike,
  CloudflareWorkerLike,
  CreateCloudflareWorkerOptions,
  ExecutionContextLike,
  NormalizedProjectLike,
  ProjectLike,
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

const isCloudflareAgentRuntime =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";

const agentsModule = isCloudflareAgentRuntime ? await import("agents") : null;
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
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const [surface, name, tail] = segments;
  if (surface === "agents" && name != null && tail != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_THINK");
    if (namespace == null) {
      return null;
    }
    return namespace.getByName(encodeHostInstanceName(name, tail)).fetch(request);
  }

  if (surface === "rpc" && name != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_AGENT");
    if (namespace == null) {
      return null;
    }
    return namespace.getByName(encodeHostInstanceName(name)).fetch(request);
  }

  if (surface === "mcp" && name != null) {
    const namespace = resolveDurableHostNamespace(env, "SO_MCP");
    if (namespace == null) {
      return null;
    }
    return namespace.getByName(encodeHostInstanceName(name)).fetch(request);
  }

  return null;
}

async function dispatchHostRequest(
  request: Request,
  env: CloudflareEnvLike | undefined,
  hostPrefix: "agents" | "rpc" | "mcp",
): Promise<Response> {
  return dispatchRequest({
    request,
    env,
    registration: requireActiveRegistration(),
    hostPrefix,
  });
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
    return dispatchHostRequest(request, this.hostedEnv, "rpc");
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

    const payload = await this.parseRequestInput(request);
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
      binding: binding as Parameters<typeof createWorkersAI>[0]["binding"],
    });

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
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    if (segments[0] !== "agents" || segments[1] == null || segments[2] == null) {
      return null;
    }
    return {
      agentName: segments[1],
      sessionId: segments[2],
    };
  }

  private async parseRequestInput(request: Request): Promise<unknown> {
    if (request.method === "GET" || request.method === "HEAD") {
      const inputParam = new URL(request.url).searchParams.get("input");
      if (inputParam == null) {
        return undefined;
      }
      try {
        return JSON.parse(inputParam);
      } catch {
        return inputParam;
      }
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return request.json();
    }

    const text = await request.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
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
      const { output, responseTraceId } = await this.executeHostedTarget(
        tool,
        toolInput,
        routeContext,
        routeTrace,
        sessionId,
      );
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
    return dispatchHostRequest(request, this.hostedEnv, "mcp");
  }
}

/** @deprecated Prefer RpcHost. */
export class AgentHost extends RpcHost {}

/** @deprecated Prefer HostedAgentRouteHost. */
export class ThinkHost extends HostedAgentRouteHost {}

/** @deprecated Prefer HostedMcpRouteHost. */
export class McpHost extends HostedMcpRouteHost {}

export function __getActiveWorkerRegistration(): {
  project: ProjectLike;
  warnings: string[];
} | null {
  if (activeWorkerRegistration == null) {
    return null;
  }
  return {
    project: activeWorkerRegistration.options.project,
    warnings: activeWorkerRegistration.warnings.slice(),
  };
}

export function __stableStringify(value: unknown): string {
  return stableStringify(value);
}
