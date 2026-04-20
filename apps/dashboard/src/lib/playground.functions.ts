import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

import type { DashboardSnapshot } from "#/lib/dashboard.functions";

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

type JsonRecord = Record<string, JsonValue>;

const playgroundTurnInput = z.object({
  agentName: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string().min(1),
});

export type PlaygroundTurnResult = {
  ok: boolean;
  agentName: string;
  sessionId: string;
  traceId?: string;
  message: string;
  payload: JsonValue;
  snapshot: DashboardSnapshot;
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function messageToTicketInput(message: string) {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    subject: (lines[0] ?? normalized).slice(0, 80),
    body: normalized,
  };
}

function extractAssistantMessage(payload: JsonValue): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (!isJsonRecord(payload)) {
    return JSON.stringify(payload, null, 2);
  }

  const data = isJsonRecord(payload.data) ? payload.data : null;

  if (data != null) {
    if (typeof data.response === "string" && data.response.length > 0) {
      return data.response;
    }

    if (isJsonRecord(data.resolution) && typeof data.resolution.customerReply === "string") {
      return data.resolution.customerReply;
    }

    if (isJsonRecord(data.traceSummary) && typeof data.traceSummary.note === "string") {
      return data.traceSummary.note;
    }
  }

  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  return JSON.stringify(data ?? payload, null, 2);
}

async function getRuntimeBinding(): Promise<RuntimeServiceBinding> {
  const { env } = await import("cloudflare:workers");
  const runtime = (env as DashboardBindings).SUPEROBJECTIVE_RUNTIME;

  if (runtime == null || typeof runtime.fetch !== "function") {
    throw new Error('Cloudflare service binding "SUPEROBJECTIVE_RUNTIME" is not configured.');
  }

  return runtime;
}

async function fetchDashboardJson<T>(pathname: string): Promise<T> {
  setResponseHeaders({
    "cache-control": "no-store",
  });

  const runtime = await getRuntimeBinding();
  const response = await runtime.fetch(`https://superobjective-runtime${pathname}`, {
    headers: {
      accept: "application/json",
    },
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

export const runPlaygroundTurn = createServerFn({ method: "POST" })
  .inputValidator(playgroundTurnInput)
  .handler(async ({ data }) => {
    const snapshot = await fetchDashboardJson<DashboardSnapshot>("/dashboard/summary");
    const agent = snapshot.surfaces.agents.find((candidate) => candidate.name === data.agentName);

    if (agent == null) {
      throw new Error(`Agent "${data.agentName}" was not found in the runtime snapshot.`);
    }

    if (agent.chatTarget == null) {
      throw new Error(`Agent "${data.agentName}" does not expose a chat target.`);
    }

    const result = await invokeRuntime(
      `/agents/${encodeURIComponent(data.agentName)}/${encodeURIComponent(data.sessionId)}`,
      {
        input: messageToTicketInput(data.message),
      },
    );
    const payloadRecord = isJsonRecord(result.payload) ? result.payload : null;
    const ok = payloadRecord?.ok === true || result.status < 400;

    if (!ok) {
      const errorMessage =
        typeof payloadRecord?.error === "string"
          ? payloadRecord.error
          : `Playground request failed with status ${result.status}.`;
      throw new Error(errorMessage);
    }

    return {
      ok,
      agentName: data.agentName,
      sessionId: data.sessionId,
      traceId: typeof payloadRecord?.traceId === "string" ? payloadRecord.traceId : undefined,
      message: extractAssistantMessage(result.payload),
      payload: result.payload,
      snapshot: await fetchDashboardJson<DashboardSnapshot>("/dashboard/summary"),
    } satisfies PlaygroundTurnResult;
  });
