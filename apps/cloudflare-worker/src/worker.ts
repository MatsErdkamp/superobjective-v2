import {
  AgentHost,
  McpHost,
  ThinkHost,
  cloudflare,
  createCloudflareWorker,
  type CloudflareEnvLike,
  type CloudflareWorkerLike,
  type ProjectLike,
  type RunTraceLike,
} from "@superobjective/cloudflare";
import { AppStateAgent } from "@superobjective/cloudflare/state-agent";
import { superobjective } from "superobjective";

import { project } from "./project";

export const SUPEROBJECTIVE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const SUPEROBJECTIVE_NAMESPACE = "superobjective-cloudflare";

const traceStore = cloudflare.sqliteTraceStore(SUPEROBJECTIVE_NAMESPACE);
const artifactStore = cloudflare.sqliteArtifactStore(SUPEROBJECTIVE_NAMESPACE);
const blobStore = cloudflare.r2BlobStore({
  binding: "SO_ARTIFACTS",
});

function resolveTraceStore(env?: CloudflareEnvLike) {
  return env != null && "withEnv" in traceStore && typeof traceStore.withEnv === "function"
    ? traceStore.withEnv(env)
    : traceStore;
}

function resolveArtifactStore(env?: CloudflareEnvLike) {
  return env != null && "withEnv" in artifactStore && typeof artifactStore.withEnv === "function"
    ? artifactStore.withEnv(env)
    : artifactStore;
}

function resolveBlobStore(env?: CloudflareEnvLike) {
  return env != null && "withEnv" in blobStore && typeof blobStore.withEnv === "function"
    ? blobStore.withEnv(env)
    : blobStore;
}

export { AgentHost, ThinkHost, McpHost, AppStateAgent };

const runtimeWorker = createCloudflareWorker({
  project: project as ProjectLike,
  runtime: {
    model: cloudflare.workersAI(SUPEROBJECTIVE_MODEL),
    structuredGeneration: cloudflare.aiSdkBridge(),
    traceStore,
    artifactStore,
    blobStore,
  },
  cloudflare: {
    development: {
      mode: "local-remote-bindings",
      bindings: {
        AI: "remote",
        SO_ARTIFACTS: "remote",
      },
      durableObjects: "local",
      workflows: "local",
    },
  },
});

type GraphNode = {
  id: string;
  kind: string;
  label: string;
  group: string;
  details: Record<string, unknown>;
};

type GraphEdge = {
  from: string;
  to: string;
  relation: string;
};

type DashboardArtifact = {
  id: string;
  target: {
    kind: "predict" | "program" | "agent";
    id: string;
  };
  optimizer: {
    id: string;
  };
  textCandidate: Record<string, string>;
  eval: {
    metricName: string;
    trainScore?: number;
    valScore?: number;
  };
  frontier?: Array<unknown>;
  createdAt: string;
};

type JobState = {
  status: "running" | "completed";
  ordinal?: number;
  traceId?: string;
  category?: "billing" | "general";
  queue?: "billing" | "general";
};

type JobStatePatch = Pick<JobState, "status"> & Partial<Omit<JobState, "status">>;

function mergeJobState(current: JobState | null, patch: JobStatePatch): JobState {
  if (current == null) {
    const { status, ...rest } = patch;
    return {
      status,
      ...rest,
    };
  }

  return {
    ...current,
    ...patch,
  };
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

function buildAppHost(env: CloudflareEnvLike) {
  return superobjective.init(cloudflare(env));
}

function buildDefaultAppConfig() {
  return {
    storage: {
      receipts: {
        search: {
          enabled: true,
        },
      },
      emails: {
        search: {
          enabled: true,
        },
      },
    },
  } as const;
}

async function summarizeApp(app: Awaited<ReturnType<ReturnType<typeof buildAppHost>["get"]>>) {
  const [receipts, emails, jobs, traces] = await Promise.all([
    app.storage.receipts.list({ limit: 100 }),
    app.storage.emails.list({ limit: 100 }),
    app.state.list({ namespace: "jobs", limit: 100 }),
    app.state.listTraces({ limit: 100 }),
  ]);

  return {
    id: app.id,
    counts: {
      receipts: receipts.length,
      emails: emails.length,
      jobs: jobs.length,
      traces: traces.length,
    },
    receipts,
    emails,
    jobs,
    traces,
  };
}

async function exerciseLiveApp(
  app: Awaited<ReturnType<ReturnType<typeof buildAppHost>["get"]>>,
  _request: Request,
  _env: CloudflareEnvLike,
) {
  const jobs = [
    {
      jobId: "job_0",
      vendor: "Stripe",
      subject: "Refund request job_0",
      body: "Customer job_0 is asking about a duplicate charge from Stripe.",
    },
    {
      jobId: "job_1",
      vendor: "Adyen",
      subject: "Product question job_1",
      body: "Customer job_1 wants a status update about order processing from Adyen.",
    },
  ];

  for (const [index, job] of jobs.entries()) {
    await app.state.upsert<JobState>("jobs", job.jobId, (current) =>
      mergeJobState(current, {
        status: "running",
        ordinal: index,
      }),
    );

    const trace = await app.state.startTrace({
      targetKind: "agent",
      targetId: index % 2 === 0 ? "support" : "finance",
      metadata: {
        jobId: job.jobId,
      },
    });

    const category = /refund|charge|billing/i.test(`${job.subject} ${job.body}`)
      ? "billing"
      : "general";
    const queue = category;
    const response =
      queue === "billing"
        ? `We are reviewing the ${job.vendor} billing issue and will follow up shortly.`
        : `We are checking the ${job.vendor} request and will send an update shortly.`;

    await app.storage.receipts.upsert(`receipt:${job.jobId}`, {
      kind: "report",
      body: {
        vendor: job.vendor,
        category,
        queue,
        response,
      },
      contentType: "application/json",
      metadata: {
        jobId: job.jobId,
        vendor: job.vendor,
        category,
      },
      indexForSearch: true,
      searchableText: `${job.vendor} ${category} ${response}`,
    });

    await app.storage.emails.upsert(`email:${job.jobId}`, {
      kind: "email",
      body: {
        subject: job.subject,
        body: job.body,
        reply: response,
      },
      contentType: "application/json",
      metadata: {
        jobId: job.jobId,
        mailbox: "support",
        category,
      },
      indexForSearch: true,
      searchableText: `${job.subject} ${job.body} ${response}`,
    });

    await app.state.appendTrace(trace.traceId, {
      type: "live.exercise.completed",
      payload: {
        jobId: job.jobId,
        category,
        queue,
      },
    });

    await app.state.finishTrace(trace.traceId, {
      status: "ok",
    });

    await app.state.upsert<JobState>("jobs", job.jobId, (current) =>
      mergeJobState(current, {
        status: "completed",
        traceId: trace.traceId,
        category,
        queue,
      }),
    );
  }

  const searchResults = await app.storage.emails.search({
    query: "duplicate charge",
    limit: 10,
  });

  return {
    jobs,
    searchResults,
    summary: await summarizeApp(app),
  };
}

function getCallableId(value: unknown): string {
  if ((typeof value !== "object" && typeof value !== "function") || value == null) {
    return "unknown";
  }

  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }

  if ("name" in value && typeof value.name === "string") {
    return value.name;
  }

  if (
    "signature" in value &&
    typeof value.signature === "object" &&
    value.signature != null &&
    "name" in value.signature &&
    typeof value.signature.name === "string"
  ) {
    return value.signature.name;
  }

  return "unknown";
}

function getCallableKind(value: unknown): string {
  if ((typeof value !== "object" && typeof value !== "function") || value == null) {
    return "unknown";
  }

  if ("execute" in value && typeof value.execute === "function") {
    return "tool";
  }

  if ("kind" in value && typeof value.kind === "string") {
    return value.kind;
  }

  return "unknown";
}

function graphId(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function buildProjectGraph() {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const program of project.programs ?? []) {
    const callableId = getCallableId(program);
    nodes.push({
      id: graphId("program", callableId),
      kind: getCallableKind(program),
      label: callableId,
      group: "programs",
      details: {
        kind: getCallableKind(program),
      },
    });
  }

  for (const agent of project.agents ?? []) {
    const agentId = graphId("agent", agent.name);
    nodes.push({
      id: agentId,
      kind: "agent",
      label: agent.name,
      group: "agents",
      details: {
        toolCount: agent.tools?.length ?? 0,
      },
    });

    edges.push({
      from: agentId,
      to: graphId("program", getCallableId(agent.chat)),
      relation: "chat",
    });

    for (const tool of agent.tools ?? []) {
      edges.push({
        from: agentId,
        to: graphId("program", getCallableId(tool)),
        relation: "uses-tool",
      });
    }
  }

  for (const rpc of project.rpc ?? []) {
    const rpcId = graphId("rpc", rpc.name);
    nodes.push({
      id: rpcId,
      kind: "rpc",
      label: rpc.name,
      group: "rpc",
      details: {
        handlerCount: Object.keys(rpc.handlers).length,
      },
    });

    for (const [handlerName, handler] of Object.entries(rpc.handlers)) {
      edges.push({
        from: rpcId,
        to: graphId("program", getCallableId(handler)),
        relation: `handler:${handlerName}`,
      });
    }
  }

  for (const mcp of project.mcp ?? []) {
    const mcpId = graphId("mcp", mcp.name);
    nodes.push({
      id: mcpId,
      kind: "mcp",
      label: mcp.name,
      group: "mcp",
      details: {
        toolCount: mcp.tools.length,
      },
    });

    for (const tool of mcp.tools) {
      edges.push({
        from: mcpId,
        to: graphId("program", getCallableId(tool)),
        relation: "exposes-tool",
      });
    }
  }

  return {
    nodes,
    edges,
    counts: {
      agents: project.agents?.length ?? 0,
      programs: project.programs?.length ?? 0,
      rpc: project.rpc?.length ?? 0,
      mcp: project.mcp?.length ?? 0,
    },
  };
}

const projectGraph = buildProjectGraph();

const deploymentNotes = [
  "This dashboard runs inside a TanStack Start Cloudflare worker and reads data through server functions.",
  "Project surfaces are sourced from the current Superobjective project graph in this repo.",
  "Trace and artifact history are persisted in the shared SO_ARTIFACTS bucket and exposed from the live Cloudflare worker runtime.",
  "Optimization jobs are derived from compiled artifacts because there is no separate GEPA job queue surface yet.",
];

const projectSurfaces = {
  agents:
    project.agents?.map((agent) => ({
      name: agent.name,
      type: "agent" as const,
      description: agent.system.value,
      tools: (agent.tools ?? []).map((tool) => getCallableId(tool)),
      chatTarget: getCallableId(agent.chat),
    })) ?? [],
  programs:
    project.programs?.map((program) => ({
      id: getCallableId(program),
      name: getCallableId(program),
      type: "program" as const,
      description:
        "signature" in program && typeof program.signature?.instructions?.value === "string"
          ? program.signature.instructions.value
          : undefined,
    })) ?? [],
  rpc:
    project.rpc?.map((surface) => ({
      name: surface.name,
      type: "rpc" as const,
      handlers: Object.keys(surface.handlers),
    })) ?? [],
  mcp:
    project.mcp?.map((surface) => ({
      name: surface.name,
      type: "mcp" as const,
      tools: surface.tools.map((tool) => getCallableId(tool)),
    })) ?? [],
};

function summarizeTrace(trace: RunTraceLike) {
  const durationMs =
    trace.endedAt == null
      ? null
      : Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt));

  return {
    runId: trace.runId,
    targetId: trace.targetId,
    targetKind: trace.targetKind,
    startedAt: trace.startedAt,
    ...(trace.endedAt != null ? { endedAt: trace.endedAt } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    status: trace.error == null ? "ok" : "error",
    componentCount: trace.components.length,
    modelCallCount: trace.modelCalls.length,
    toolCallCount: trace.toolCalls.length,
    error: trace.error?.message,
    inputPreview:
      typeof trace.input === "string"
        ? trace.input.slice(0, 200)
        : JSON.stringify(trace.input).slice(0, 200),
    outputPreview:
      typeof trace.output === "string"
        ? trace.output.slice(0, 200)
        : JSON.stringify(trace.output).slice(0, 200),
  };
}

function summarizeArtifact(artifact: DashboardArtifact, activeArtifactIds: Set<string>) {
  return {
    id: artifact.id,
    targetId: artifact.target.id,
    targetKind: artifact.target.kind,
    optimizerId: artifact.optimizer.id,
    createdAt: artifact.createdAt,
    metricName: artifact.eval.metricName,
    ...(artifact.eval.trainScore != null ? { trainScore: artifact.eval.trainScore } : {}),
    ...(artifact.eval.valScore != null ? { valScore: artifact.eval.valScore } : {}),
    frontierSize: artifact.frontier?.length ?? 0,
    isActive: activeArtifactIds.has(artifact.id),
    candidatePathCount: Object.keys(artifact.textCandidate ?? {}).length,
  };
}

function deriveOptimizationJobs(artifacts: DashboardArtifact[]) {
  const jobs = new Map<
    string,
    {
      jobId: string;
      optimizerId: string;
      targetKind: string;
      targetId: string;
      artifactCount: number;
      latestArtifactId: string;
      latestCreatedAt: string;
      bestTrainScore: number | null;
      bestValScore: number | null;
    }
  >();

  for (const artifact of artifacts) {
    const jobId = [artifact.optimizer.id, artifact.target.kind, artifact.target.id].join(":");
    const existing = jobs.get(jobId);
    const trainScore = artifact.eval.trainScore ?? null;
    const valScore = artifact.eval.valScore ?? null;

    if (existing == null) {
      jobs.set(jobId, {
        jobId,
        optimizerId: artifact.optimizer.id,
        targetKind: artifact.target.kind,
        targetId: artifact.target.id,
        artifactCount: 1,
        latestArtifactId: artifact.id,
        latestCreatedAt: artifact.createdAt,
        bestTrainScore: trainScore,
        bestValScore: valScore,
      });
      continue;
    }

    existing.artifactCount += 1;
    if (artifact.createdAt > existing.latestCreatedAt) {
      existing.latestCreatedAt = artifact.createdAt;
      existing.latestArtifactId = artifact.id;
    }
    if (trainScore != null) {
      existing.bestTrainScore =
        existing.bestTrainScore == null
          ? trainScore
          : Math.max(existing.bestTrainScore, trainScore);
    }
    if (valScore != null) {
      existing.bestValScore =
        existing.bestValScore == null ? valScore : Math.max(existing.bestValScore, valScore);
    }
  }

  return Array.from(jobs.values()).sort((left, right) =>
    right.latestCreatedAt.localeCompare(left.latestCreatedAt),
  );
}

async function listTraces(url: URL, env?: CloudflareEnvLike) {
  const store = resolveTraceStore(env);
  return (
    (await store.listTraces?.({
      targetKind: url.searchParams.get("targetKind") ?? undefined,
      targetId: url.searchParams.get("targetId") ?? undefined,
      limit: parseLimit(url.searchParams.get("limit"), 25, 100),
    })) ?? []
  );
}

async function listArtifacts(url: URL, env?: CloudflareEnvLike): Promise<DashboardArtifact[]> {
  const store = resolveArtifactStore(env);
  const targetKind = url.searchParams.get("targetKind");
  return ((await store.listArtifacts?.({
    targetKind:
      targetKind === "predict" || targetKind === "program" || targetKind === "agent"
        ? targetKind
        : undefined,
    targetId: url.searchParams.get("targetId") ?? undefined,
    limit: parseLimit(url.searchParams.get("limit"), 25, 100),
  })) ?? []) as DashboardArtifact[];
}

async function handleDashboardRequest(
  url: URL,
  request: Request,
  env?: CloudflareEnvLike,
): Promise<Response> {
  const traceStore = resolveTraceStore(env);
  const artifactStore = resolveArtifactStore(env);
  const blobStore = resolveBlobStore(env);
  const appHost = env != null ? buildAppHost(env) : null;

  if (url.pathname === "/dashboard" || url.pathname === "/dashboard/summary") {
    const [traces, artifacts, blobKeys] = await Promise.all([
      listTraces(url, env),
      listArtifacts(url, env),
      blobStore.list?.(url.searchParams.get("prefix") ?? "") ?? [],
    ]);
    const activeArtifactIds = new Set(
      await Promise.all(
        artifacts.map(async (artifact) => {
          const activeArtifact = await artifactStore.loadActiveArtifact({
            targetKind: artifact.target.kind,
            targetId: artifact.target.id,
          });
          return activeArtifact?.id;
        }),
      ).then((values) => values.filter((value): value is string => value != null)),
    );

    return jsonResponse(200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      deployment: {
        namespace: SUPEROBJECTIVE_NAMESPACE,
        model: SUPEROBJECTIVE_MODEL,
        runtime: "Cloudflare Worker service binding via TanStack Start server functions",
        notes: deploymentNotes,
      },
      counts: {
        agents: projectGraph.counts.agents,
        programs: projectGraph.counts.programs,
        rpc: projectGraph.counts.rpc,
        mcp: projectGraph.counts.mcp,
        traces: traces.length,
        artifacts: artifacts.length,
        activeArtifacts: activeArtifactIds.size,
      },
      surfaces: projectSurfaces,
      project: projectGraph,
      traces: traces.map(summarizeTrace),
      artifacts: artifacts.map((artifact) => summarizeArtifact(artifact, activeArtifactIds)),
      optimizationJobs: deriveOptimizationJobs(artifacts),
      blobs: {
        prefix: url.searchParams.get("prefix") ?? "",
        keys: blobKeys.slice(0, parseLimit(url.searchParams.get("blobLimit"), 25, 100)),
        totalKnown: blobKeys.length,
      },
      notes: deploymentNotes,
    });
  }

  if (url.pathname === "/dashboard/project") {
    return jsonResponse(200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      project: projectGraph,
    });
  }

  if (url.pathname === "/dashboard/traces") {
    const traces = await listTraces(url, env);
    return jsonResponse(200, {
      ok: true,
      traces: traces.map(summarizeTrace),
    });
  }

  if (url.pathname.startsWith("/dashboard/traces/")) {
    const runId = decodeURIComponent(url.pathname.slice("/dashboard/traces/".length));
    const trace = await traceStore.loadTrace(runId);
    if (trace == null) {
      return jsonResponse(404, {
        ok: false,
        error: `Trace "${runId}" was not found.`,
      });
    }

    return jsonResponse(200, {
      ok: true,
      trace,
      summary: summarizeTrace(trace),
    });
  }

  if (url.pathname === "/dashboard/artifacts") {
    const artifacts = await listArtifacts(url, env);
    const activeArtifactIds = new Set(
      await Promise.all(
        artifacts.map(async (artifact) => {
          const activeArtifact = await artifactStore.loadActiveArtifact({
            targetKind: artifact.target.kind,
            targetId: artifact.target.id,
          });
          return activeArtifact?.id;
        }),
      ).then((values) => values.filter((value): value is string => value != null)),
    );
    return jsonResponse(200, {
      ok: true,
      artifacts: artifacts.map((artifact) => summarizeArtifact(artifact, activeArtifactIds)),
      optimizationJobs: deriveOptimizationJobs(artifacts),
    });
  }

  if (url.pathname.startsWith("/dashboard/artifacts/")) {
    const artifactId = decodeURIComponent(url.pathname.slice("/dashboard/artifacts/".length));
    const artifact = await artifactStore.loadArtifact(artifactId);
    if (artifact == null) {
      return jsonResponse(404, {
        ok: false,
        error: `Artifact "${artifactId}" was not found.`,
      });
    }

    const activeArtifact = await artifactStore.loadActiveArtifact({
      targetKind: artifact.target.kind,
      targetId: artifact.target.id,
    });

    return jsonResponse(200, {
      ok: true,
      artifact,
      summary: summarizeArtifact(
        artifact,
        new Set(activeArtifact == null ? [] : [activeArtifact.id]),
      ),
      activeForTarget: activeArtifact?.id === artifact.id,
    });
  }

  if (url.pathname === "/dashboard/blobs") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const blobKeys = (await blobStore.list?.(prefix)) ?? [];
    return jsonResponse(200, {
      ok: true,
      prefix,
      keys: blobKeys.slice(0, parseLimit(url.searchParams.get("limit"), 25, 100)),
      totalKnown: blobKeys.length,
    });
  }

  const appMatch = url.pathname.match(/^\/dashboard\/apps\/([^/]+)(?:\/(create|exercise))?$/);
  if (appMatch != null) {
    if (appHost == null || env == null) {
      return jsonResponse(500, {
        ok: false,
        error: "Cloudflare app host is not available without env bindings.",
      });
    }

    const [, rawAppId, action] = appMatch;
    const appId = decodeURIComponent(rawAppId);

    try {
      if (request.method === "POST" && action === "create") {
        const app = await appHost.create({
          id: appId,
          ...buildDefaultAppConfig(),
        });
        return jsonResponse(200, {
          ok: true,
          app: await summarizeApp(app),
        });
      }

      if (request.method === "POST" && action === "exercise") {
        const app = await appHost.get({
          id: appId,
        });
        return jsonResponse(200, {
          ok: true,
          ...(await exerciseLiveApp(app, request, env)),
        });
      }

      if (request.method === "GET" && action == null) {
        const app = await appHost.get({
          id: appId,
        });
        return jsonResponse(200, {
          ok: true,
          app: await summarizeApp(app),
        });
      }

      if (request.method === "DELETE" && action == null) {
        await appHost.destroy({
          id: appId,
        });
        return jsonResponse(200, {
          ok: true,
          destroyed: appId,
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Superobjective app "${appId}" was not found.`
      ) {
        return jsonResponse(404, {
          ok: false,
          error: error.message,
        });
      }
      throw error;
    }
  }

  return jsonResponse(404, {
    ok: false,
    error: `No dashboard route matched "${url.pathname}".`,
  });
}

export default {
  async fetch(
    request: Request,
    env?: CloudflareEnvLike,
    ctx?: Parameters<CloudflareWorkerLike["fetch"]>[2],
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/dashboard")) {
      return handleDashboardRequest(url, request, env);
    }

    return runtimeWorker.fetch(request, env, ctx);
  },
} satisfies CloudflareWorkerLike;
