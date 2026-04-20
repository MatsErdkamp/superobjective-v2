import type {
  CallableTargetLike,
  HostedRouteContextLike,
  HostedRouteDispatchOptions,
  HostedRoutePrefix,
  McpSurfaceLike,
  RunTraceLike,
  ToolCallTraceLike,
  ToolExecutionContextLike,
  ToolLike,
} from "./types";
import {
  buildToolDefinition,
  createRouteTrace,
  getInputSchema,
  getOutputSchema,
  getTargetId,
  getTargetKind,
  isRecord,
  listMcpTools,
  maybeInspectPrompt,
  nowIso,
  resolveText,
  serializeError,
  validateWithSchema,
} from "./project";

type RouteTarget<TEnv> =
  | CallableTargetLike<unknown, unknown, TEnv>
  | ToolLike<unknown, unknown, TEnv>;

function toProjectTarget<TEnv>(target: RouteTarget<TEnv>): CallableTargetLike | ToolLike {
  return target as CallableTargetLike | ToolLike;
}

function toProjectMcp<TEnv>(mcp: McpSurfaceLike<TEnv>): McpSurfaceLike {
  return mcp as McpSurfaceLike;
}

export async function parseRequestInput(request: Request): Promise<unknown> {
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

export function jsonResponse(status: number, body: unknown, warnings: string[]): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });

  if (warnings.length > 0) {
    headers.set("x-superobjective-warning-count", String(warnings.length));
    headers.set("x-superobjective-warnings", warnings.join(" | "));
  }

  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers,
  });
}

export function notFound(message: string, warnings: string[]): Response {
  return jsonResponse(
    404,
    {
      ok: false,
      error: message,
    },
    warnings,
  );
}

export function badRequest(message: string, warnings: string[]): Response {
  return jsonResponse(
    400,
    {
      ok: false,
      error: message,
    },
    warnings,
  );
}

async function invokeTarget<TEnv>(
  target: RouteTarget<TEnv>,
  input: unknown,
  routeContext: HostedRouteContextLike<TEnv>,
  trace: RunTraceLike,
  sessionId?: string,
): Promise<unknown> {
  const projectTarget = toProjectTarget(target);
  const inputSchema = getInputSchema(projectTarget);
  const validatedInput = validateWithSchema(inputSchema, input);
  const targetId = getTargetId(projectTarget);
  const componentKind = getTargetKind(projectTarget);

  const component: RunTraceLike["components"][number] = {
    componentId: targetId,
    componentKind:
      componentKind === "tool" ? "tool" : componentKind === "program" ? "program" : "predict",
    startedAt: nowIso(),
    input: validatedInput,
    stdout: "",
  };

  if (typeof target === "function") {
    const prompt = await maybeInspectPrompt(projectTarget as CallableTargetLike, validatedInput);
    if (prompt != null) {
      component.prompt = prompt;
    }
  }

  trace.components.push(component);

  try {
    let output: unknown;
    if ("execute" in target) {
      const toolLog: string[] = [];
      const toolStartedAt = nowIso();
      const toolContext: ToolExecutionContextLike<TEnv> = {
        runtime: routeContext.runtime,
        env: routeContext.env,
        request: routeContext.request,
        sessionId,
        trace,
        log(message: string): void {
          toolLog.push(message);
        },
      };

      const startedAt = Date.now();
      output = await target.execute(validatedInput, toolContext);
      const toolCall: ToolCallTraceLike = {
        toolName: targetId,
        input: validatedInput,
        output,
        startedAt: toolStartedAt,
        endedAt: nowIso(),
        latencyMs: Date.now() - startedAt,
      };
      if (toolLog.length > 0) {
        toolCall.metadata = {
          logs: toolLog,
        };
      }
      trace.toolCalls.push(toolCall);
    } else {
      output = await target(validatedInput, {
        runtime: routeContext.runtime,
        env: routeContext.env,
        request: routeContext.request,
        executionContext: routeContext.executionContext,
      });
    }

    const outputSchema = getOutputSchema(projectTarget);
    const validatedOutput = validateWithSchema(outputSchema, output);
    component.output = validatedOutput;
    component.endedAt = nowIso();
    return validatedOutput;
  } catch (error) {
    component.error = serializeError(error);
    component.endedAt = nowIso();
    throw error;
  }
}

async function getLatestNestedTraceId<TEnv>(
  routeContext: HostedRouteContextLike<TEnv>,
  target: RouteTarget<TEnv>,
): Promise<string | undefined> {
  const traceStore = routeContext.runtime.traceStore;
  if (traceStore?.listTraces == null) {
    return undefined;
  }

  const projectTarget = toProjectTarget(target);
  const targetKind = getTargetKind(projectTarget);
  if (targetKind === "tool") {
    return undefined;
  }

  const traces = await traceStore.listTraces({
    targetKind,
    targetId: getTargetId(projectTarget),
    limit: 1,
  });

  return traces[0]?.runId;
}

async function resolveResponseTraceId<TEnv>(
  routeContext: HostedRouteContextLike<TEnv>,
  target: RouteTarget<TEnv>,
  previousNestedTraceId: string | undefined,
  fallbackTraceId: string,
): Promise<string> {
  const latestNestedTraceId = await getLatestNestedTraceId(routeContext, target);
  if (latestNestedTraceId != null && latestNestedTraceId !== previousNestedTraceId) {
    return latestNestedTraceId;
  }

  return fallbackTraceId;
}

async function persistTrace<TEnv>(
  routeContext: HostedRouteContextLike<TEnv>,
  trace: RunTraceLike,
): Promise<void> {
  trace.endedAt = nowIso();
  if (routeContext.runtime.traceStore != null) {
    await routeContext.runtime.traceStore.saveTrace(trace);
  }
}

async function handleRpcRequest<TEnv>(
  rpcName: string,
  handlerName: string,
  routeContext: HostedRouteContextLike<TEnv>,
  rpc: HostedRouteDispatchOptions<TEnv>["project"]["rpc"] extends Map<string, infer TRpc>
    ? TRpc
    : never,
): Promise<Response> {
  const handler = rpc.handlers[handlerName];
  if (handler == null) {
    return notFound(
      `RPC handler "${handlerName}" was not found in surface "${rpcName}".`,
      routeContext.warnings,
    );
  }

  const input = await parseRequestInput(routeContext.request);
  const trace = createRouteTrace(`${rpcName}.${handlerName}`, "rpc", input, {
    route: "rpc",
    rpcName,
    handlerName,
  });

  try {
    const previousNestedTraceId = await getLatestNestedTraceId(routeContext, handler);
    const output = await invokeTarget(handler, input, routeContext, trace);
    trace.output = output;
    await persistTrace(routeContext, trace);
    const responseTraceId = await resolveResponseTraceId(
      routeContext,
      handler,
      previousNestedTraceId,
      trace.runId,
    );
    return jsonResponse(
      200,
      {
        ok: true,
        rpc: rpcName,
        handler: handlerName,
        data: output,
        traceId: responseTraceId,
      },
      routeContext.warnings,
    );
  } catch (error) {
    trace.error = serializeError(error);
    await persistTrace(routeContext, trace);
    return jsonResponse(
      500,
      {
        ok: false,
        error: trace.error.message,
        traceId: trace.runId,
      },
      routeContext.warnings,
    );
  }
}

async function handleAgentRequest<TEnv>(
  agentName: string,
  sessionId: string,
  routeContext: HostedRouteContextLike<TEnv>,
  agent: HostedRouteDispatchOptions<TEnv>["project"]["agents"] extends Map<string, infer TAgent>
    ? TAgent
    : never,
): Promise<Response> {
  if (routeContext.request.method === "GET") {
    return jsonResponse(
      200,
      {
        ok: true,
        agent: agent.name,
        sessionId,
        system: resolveText(agent.system),
        tools: (agent.tools ?? []).map((tool) => {
          const { definition, jsonSchema } = buildToolDefinition(toProjectTarget(tool));
          return {
            name: definition.name,
            description: definition.description,
            inputJsonSchema: jsonSchema,
          };
        }),
      },
      routeContext.warnings,
    );
  }

  const payload = await parseRequestInput(routeContext.request);
  if (payload == null) {
    return badRequest(
      "Agent requests require a JSON body or ?input= query parameter.",
      routeContext.warnings,
    );
  }

  const trace = createRouteTrace(`${agent.name}:${sessionId}`, "agent", payload, {
    route: "agent",
    agent: agentName,
    sessionId,
  });

  try {
    if (isRecord(payload) && typeof payload.tool === "string") {
      const tool = (agent.tools ?? []).find(
        (candidate) => getTargetId(toProjectTarget(candidate)) === payload.tool,
      );
      if (tool == null) {
        return notFound(
          `Tool "${payload.tool}" was not found on agent "${agentName}".`,
          routeContext.warnings,
        );
      }
      const toolInput = "input" in payload ? payload.input : payload;
      const previousNestedTraceId = await getLatestNestedTraceId(routeContext, tool);
      const output = await invokeTarget(tool, toolInput, routeContext, trace, sessionId);
      trace.output = output;
      await persistTrace(routeContext, trace);
      const responseTraceId = await resolveResponseTraceId(
        routeContext,
        tool,
        previousNestedTraceId,
        trace.runId,
      );
      return jsonResponse(
        200,
        {
          ok: true,
          agent: agentName,
          sessionId,
          tool: payload.tool,
          data: output,
          traceId: responseTraceId,
        },
        routeContext.warnings,
      );
    }

    const agentInput = isRecord(payload) && "input" in payload ? payload.input : payload;
    const previousNestedTraceId = await getLatestNestedTraceId(routeContext, agent.chat);
    const output = await invokeTarget(agent.chat, agentInput, routeContext, trace, sessionId);
    trace.output = output;
    await persistTrace(routeContext, trace);
    const responseTraceId = await resolveResponseTraceId(
      routeContext,
      agent.chat,
      previousNestedTraceId,
      trace.runId,
    );
    return jsonResponse(
      200,
      {
        ok: true,
        agent: agentName,
        sessionId,
        data: output,
        traceId: responseTraceId,
      },
      routeContext.warnings,
    );
  } catch (error) {
    trace.error = serializeError(error);
    await persistTrace(routeContext, trace);
    return jsonResponse(
      500,
      {
        ok: false,
        error: trace.error.message,
        traceId: trace.runId,
      },
      routeContext.warnings,
    );
  }
}

async function handleMcpRequest<TEnv>(
  mcpName: string,
  routeContext: HostedRouteContextLike<TEnv>,
  mcp: McpSurfaceLike<TEnv>,
): Promise<Response> {
  if (routeContext.request.method === "GET") {
    return jsonResponse(
      200,
      {
        ok: true,
        mcp: mcp.name,
        tools: listMcpTools(toProjectMcp(mcp)),
      },
      routeContext.warnings,
    );
  }

  const payload = await parseRequestInput(routeContext.request);
  const trace = createRouteTrace(mcp.name, "mcp", payload, { route: "mcp", mcp: mcpName });

  try {
    const method =
      isRecord(payload) && typeof payload.method === "string" ? payload.method : undefined;

    if (method === "tools/list") {
      const output = {
        tools: listMcpTools(toProjectMcp(mcp)),
      };
      trace.output = output;
      await persistTrace(routeContext, trace);
      return jsonResponse(
        200,
        {
          ok: true,
          result: output,
          traceId: trace.runId,
        },
        routeContext.warnings,
      );
    }

    const params = isRecord(payload) && isRecord(payload.params) ? payload.params : {};
    const toolName =
      typeof params.name === "string"
        ? params.name
        : isRecord(payload) && typeof payload.tool === "string"
          ? payload.tool
          : undefined;

    if (toolName == null) {
      return badRequest(
        'MCP calls require method "tools/list" or a tool name via params.name / tool.',
        routeContext.warnings,
      );
    }

    const tool = mcp.tools.find(
      (candidate) => getTargetId(toProjectTarget(candidate)) === toolName,
    );
    if (tool == null) {
      return notFound(
        `Tool "${toolName}" was not found in MCP surface "${mcpName}".`,
        routeContext.warnings,
      );
    }

    const toolInput =
      "arguments" in params
        ? params.arguments
        : isRecord(payload) && "input" in payload
          ? payload.input
          : params;

    const previousNestedTraceId = await getLatestNestedTraceId(routeContext, tool);
    const output = await invokeTarget(tool, toolInput, routeContext, trace);
    trace.output = output;
    await persistTrace(routeContext, trace);
    const responseTraceId = await resolveResponseTraceId(
      routeContext,
      tool,
      previousNestedTraceId,
      trace.runId,
    );
    return jsonResponse(
      200,
      {
        ok: true,
        result: output,
        traceId: responseTraceId,
      },
      routeContext.warnings,
    );
  } catch (error) {
    trace.error = serializeError(error);
    await persistTrace(routeContext, trace);
    return jsonResponse(
      500,
      {
        ok: false,
        error: trace.error.message,
        traceId: trace.runId,
      },
      routeContext.warnings,
    );
  }
}

function rewritePathForHost(pathname: string, prefix: HostedRoutePrefix): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === prefix) {
    return pathname;
  }
  return `/${prefix}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export async function dispatchHostedRequest<TEnv>({
  request,
  env,
  executionContext,
  runtime,
  project,
  warnings,
  hostPrefix,
}: HostedRouteDispatchOptions<TEnv>): Promise<Response> {
  const routeContext: HostedRouteContextLike<TEnv> = {
    runtime,
    env,
    request,
    executionContext,
    warnings,
  };

  const pathname = hostPrefix
    ? rewritePathForHost(new URL(request.url).pathname, hostPrefix)
    : new URL(request.url).pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return jsonResponse(
      200,
      {
        ok: true,
        agents: Array.from(project.agents.keys()),
        rpc: Array.from(project.rpc.keys()),
        mcp: Array.from(project.mcp.keys()),
        warnings,
      },
      warnings,
    );
  }

  const [surface, name, tail] = segments;

  if (surface === "rpc") {
    if (name == null || tail == null) {
      return badRequest('RPC requests must use "/rpc/:rpcName/:handlerName".', warnings);
    }
    const rpc = project.rpc.get(name);
    if (rpc == null) {
      return notFound(`RPC surface "${name}" was not found.`, warnings);
    }
    return handleRpcRequest(name, tail, routeContext, rpc);
  }

  if (surface === "agents") {
    if (name == null || tail == null) {
      return badRequest('Agent requests must use "/agents/:agentName/:sessionId".', warnings);
    }
    const agent = project.agents.get(name);
    if (agent == null) {
      return notFound(`Agent "${name}" was not found.`, warnings);
    }
    return handleAgentRequest(name, tail, routeContext, agent);
  }

  if (surface === "mcp") {
    if (name == null) {
      return badRequest('MCP requests must use "/mcp/:mcpName".', warnings);
    }
    const mcp = project.mcp.get(name);
    if (mcp == null) {
      return notFound(`MCP surface "${name}" was not found.`, warnings);
    }
    return handleMcpRequest(name, routeContext, mcp);
  }

  return notFound(`No route matched "${pathname}". Expected /agents, /rpc, or /mcp.`, warnings);
}
