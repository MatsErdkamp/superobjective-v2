import { dispatchHostedRequest, normalizeProject, stableStringify } from "@superobjective/hosting";
import { createAiSdkBridge, bindRuntimeEnv } from "./runtime";
import type {
  CloudflareEnvLike,
  CloudflareWorkerLike,
  CreateCloudflareWorkerOptions,
  ExecutionContextLike,
  NormalizedProjectLike,
  ProjectLike,
  RuntimeContextLike,
} from "./types";

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

let activeWorkerRegistration: RegisteredWorker | null = null;

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
      return dispatchRequest({
        request,
        env,
        executionContext,
        registration,
      });
    },
  };
}

class BaseHost {
  protected readonly env: CloudflareEnvLike | undefined;

  constructor(_state?: unknown, env?: CloudflareEnvLike) {
    this.env = env;
  }

  protected async dispatch(
    request: Request,
    hostPrefix: "agents" | "rpc" | "mcp",
  ): Promise<Response> {
    return dispatchRequest({
      request,
      env: this.env,
      registration: requireActiveRegistration(),
      hostPrefix,
    });
  }
}

export class AgentHost extends BaseHost {
  async fetch(request: Request): Promise<Response> {
    return this.dispatch(request, "rpc");
  }
}

export class ThinkHost extends BaseHost {
  async fetch(request: Request): Promise<Response> {
    return this.dispatch(request, "agents");
  }
}

export class McpHost extends BaseHost {
  async fetch(request: Request): Promise<Response> {
    return this.dispatch(request, "mcp");
  }
}

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
