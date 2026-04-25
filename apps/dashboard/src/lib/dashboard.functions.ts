import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

type RuntimeServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type DashboardBindings = {
  SUPEROBJECTIVE_RUNTIME?: RuntimeServiceBinding;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

const dashboardActionInput = z.object({
  mode: z.enum(["agent-chat", "triage-tool", "support-flow", "triage-rpc", "trace-probe-agent"]),
  sessionId: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const traceDetailInput = z.object({
  runId: z.string().min(1),
  raw: z.boolean().optional(),
});

type DashboardActionInput = z.infer<typeof dashboardActionInput>;

export type DashboardSnapshot = {
  ok: boolean;
  generatedAt: string;
  deployment: {
    namespace: string;
    model: string;
    runtime: string;
    notes: string[];
  };
  counts: {
    agents: number;
    programs: number;
    rpc: number;
    mcp: number;
    traces: number;
    artifacts: number;
    activeArtifacts: number;
  };
  surfaces: {
    agents: Array<{
      name: string;
      type: "agent";
      description?: string;
      tools?: string[];
      chatTarget?: string;
    }>;
    programs: Array<{
      id?: string;
      name: string;
      type: "program";
      description?: string;
    }>;
    rpc: Array<{
      name: string;
      type: "rpc";
      handlers?: string[];
    }>;
    mcp: Array<{
      name: string;
      type: "mcp";
      tools?: string[];
    }>;
  };
  project: {
    nodes: Array<{
      id: string;
      kind: string;
      label: string;
      group: string;
      details: Record<string, JsonValue>;
    }>;
    edges: Array<{
      from: string;
      to: string;
      relation: string;
    }>;
    counts: {
      agents: number;
      programs: number;
      rpc: number;
      mcp: number;
    };
  };
  traces: Array<{
    runId: string;
    targetId: string;
    targetKind: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    status: string;
    componentCount: number;
    modelCallCount: number;
    toolCallCount: number;
    error?: string;
    inputPreview: string;
    outputPreview: string;
  }>;
  artifacts: Array<{
    id: string;
    targetId: string;
    targetKind: string;
    optimizerId: string;
    createdAt: string;
    metricName: string;
    trainScore: number | null;
    valScore: number | null;
    frontierSize: number;
    isActive: boolean;
    candidatePathCount: number;
  }>;
  optimizationJobs: Array<{
    jobId: string;
    optimizerId: string;
    targetKind: string;
    targetId: string;
    artifactCount: number;
    latestArtifactId: string;
    latestCreatedAt: string;
    bestTrainScore: number | null;
    bestValScore: number | null;
  }>;
  blobs: {
    prefix: string;
    keys: string[];
    totalKnown: number;
  };
  notes: string[];
};

export type DashboardActionResult = {
  requestPath: string;
  status: number;
  ok: boolean;
  traceId?: string;
  payload: JsonValue;
  snapshot: DashboardSnapshot;
};

export type DashboardTraceResponse = {
  ok: boolean;
  serialization: "safe" | "raw";
  trace: JsonValue;
  summary: DashboardSnapshot["traces"][number];
};

async function getRuntimeBinding(): Promise<RuntimeServiceBinding> {
  const { env } = await import("cloudflare:workers");
  const runtime = (env as DashboardBindings).SUPEROBJECTIVE_RUNTIME;

  if (runtime == null || typeof runtime.fetch !== "function") {
    throw new Error('Cloudflare service binding "SUPEROBJECTIVE_RUNTIME" is not configured.');
  }

  return runtime;
}

async function fetchDashboardJson<T>(
  pathname: string,
  query?: Record<string, string | number | undefined>,
  init?: RequestInit,
): Promise<T> {
  setResponseHeaders({
    "cache-control": "no-store",
  });

  const runtime = await getRuntimeBinding();
  const url = new URL(`https://superobjective-runtime${pathname}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");

  const response = await runtime.fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `Dashboard runtime request failed with ${response.status} ${response.statusText}.`,
    );
  }

  return (await response.json()) as T;
}

async function invokeRuntime(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: JsonValue }> {
  const runtime = await getRuntimeBinding();
  const response = await runtime.fetch(`https://superobjective-runtime${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as JsonValue)
    : ((await response.text()) as JsonValue);

  return {
    status: response.status,
    payload,
  };
}

function resolveInvocation(input: DashboardActionInput): {
  path: string;
  body: Record<string, unknown>;
} {
  const normalized = {
    subject: input.subject.trim(),
    body: input.body.trim(),
  };

  switch (input.mode) {
    case "agent-chat":
      return {
        path: `/agents/support/${encodeURIComponent(input.sessionId)}`,
        body: {
          input: normalized,
        },
      };
    case "triage-tool":
      return {
        path: `/agents/support/${encodeURIComponent(input.sessionId)}`,
        body: {
          tool: "triage_ticket",
          input: normalized,
        },
      };
    case "support-flow":
      return {
        path: "/rpc/support_rpc/supportFlow",
        body: normalized,
      };
    case "triage-rpc":
      return {
        path: "/rpc/support_rpc/triageTicket",
        body: normalized,
      };
    case "trace-probe-agent":
      return {
        path: `/agents/trace_probe/${encodeURIComponent(input.sessionId)}`,
        body: {
          input: normalized,
        },
      };
  }
}

export const getDashboardSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  return fetchDashboardJson<DashboardSnapshot>("/dashboard/summary");
});

export const getDashboardTrace = createServerFn({ method: "GET" })
  .inputValidator(traceDetailInput)
  .handler(async ({ data }) => {
    return fetchDashboardJson<DashboardTraceResponse>(
      `/dashboard/traces/${encodeURIComponent(data.runId)}`,
      {
        raw: data.raw === true ? 1 : undefined,
      },
    );
  });

export const runDashboardAction = createServerFn({ method: "POST" })
  .inputValidator(dashboardActionInput)
  .handler(async ({ data }) => {
    const invocation = resolveInvocation(data);
    const result = await invokeRuntime(invocation.path, invocation.body);
    const payloadRecord =
      result.payload != null &&
      typeof result.payload === "object" &&
      "ok" in (result.payload as Record<string, unknown>)
        ? (result.payload as Record<string, unknown>)
        : null;

    return {
      requestPath: invocation.path,
      status: result.status,
      ok: payloadRecord?.ok === true || result.status < 400,
      traceId: typeof payloadRecord?.traceId === "string" ? payloadRecord.traceId : undefined,
      payload: result.payload,
      snapshot: await fetchDashboardJson<DashboardSnapshot>("/dashboard/summary"),
    } satisfies DashboardActionResult;
  });
