import {
  buildToolDefinition,
  createRouteTrace,
  getInputSchema,
  getOutputSchema,
  getTargetId,
  getTargetKind,
  isRecord,
  jsonResponse,
  notFound,
  badRequest,
  nowIso,
  serializeError,
  stableStringify,
  validateWithSchema,
  type CallableTargetLike,
  type NormalizedProjectLike,
  type RunTraceLike,
  type RuntimeContextLike,
  type ToolExecutionContextLike,
  type ToolLike,
} from "@superobjective/hosting";
import type { ModelMessage, ToolBindingState } from "superobjective";

import type { CloudflareEnvLike } from "./types";
import { createCorpusProvider, mergeCorpusProviders } from "./corpora";
import type { CorpusDescriptorLike, CorpusProviderLike } from "./types";

type KernelTarget = CallableTargetLike<unknown, unknown, CloudflareEnvLike> | ToolLike<unknown, unknown, CloudflareEnvLike>;

export type KernelStoredToolResult = {
  id: string;
  sessionId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  traceId?: string;
  createdAt: string;
};

export type KernelStoredChatMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  body: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type KernelStoredStateEntry = {
  sessionId?: string;
  key: string;
  value: unknown;
  updatedAt: string;
};

export type KernelStoredCorpus = {
  corpus: CorpusDescriptorLike;
  createdAt: string;
  updatedAt: string;
};

export type KernelStoredRlmRun = {
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
};

export type KernelStoredRlmStep = {
  runId: string;
  stepIndex: number;
  reasoning?: string;
  code: string;
  stdout?: string;
  stderr?: string;
  logs: string[];
  toolCalls?: unknown;
  submitted?: unknown;
  submitValidationError?: unknown;
  error?: unknown;
  queryCallsUsed?: number;
  startedAt: string;
  endedAt?: string;
};

export type KernelPersistence = {
  saveTrace(trace: RunTraceLike): Promise<void>;
  loadTrace(runId: string): Promise<RunTraceLike | null>;
  listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]>;
  saveToolResult(value: KernelStoredToolResult): Promise<void>;
  loadLatestToolResult(args: {
    sessionId?: string;
    toolName: string;
    resultId?: string;
  }): Promise<KernelStoredToolResult | null>;
  appendChatMessage(message: KernelStoredChatMessage): Promise<void>;
  listChatMessages(args: { sessionId: string; limit?: number }): Promise<KernelStoredChatMessage[]>;
  saveArtifact(artifact: Parameters<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["saveArtifact"]>[0]): Promise<void>;
  loadArtifact(id: string): Promise<
    Awaited<ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadArtifact"]>>
  >;
  listArtifacts(args?: {
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["listArtifacts"]>>
    >
  >;
  loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadActiveArtifact"]>
    >
  >;
  setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void>;
  loadState?(args: { sessionId?: string; key: string; path?: string }): Promise<unknown>;
  saveState?(args: { sessionId?: string; key: string; value: unknown }): Promise<void>;
  saveCorpus?(value: KernelStoredCorpus): Promise<void>;
  loadCorpus?(corpusId: string): Promise<KernelStoredCorpus | null>;
  listCorpora?(): Promise<KernelStoredCorpus[]>;
  saveRlmRun?(value: KernelStoredRlmRun): Promise<void>;
  loadRlmRun?(runId: string): Promise<KernelStoredRlmRun | null>;
  saveRlmStep?(value: KernelStoredRlmStep): Promise<void>;
  listRlmSteps?(runId: string): Promise<KernelStoredRlmStep[]>;
};

type MemoryKernelNamespace = {
  traces: Map<string, RunTraceLike>;
  toolResults: KernelStoredToolResult[];
  chatMessages: KernelStoredChatMessage[];
  artifacts: Map<string, NonNullable<Awaited<ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadArtifact"]>>>>;
  activeArtifacts: Map<string, string>;
  stateEntries: Map<string, KernelStoredStateEntry>;
  corpora: Map<string, KernelStoredCorpus>;
  rlmRuns: Map<string, KernelStoredRlmRun>;
  rlmSteps: KernelStoredRlmStep[];
};

const memoryKernelNamespaces = new Map<string, MemoryKernelNamespace>();

function asHostingTarget(target: KernelTarget) {
  return target as unknown as Parameters<typeof buildToolDefinition>[0];
}

function getMemoryKernelNamespace(namespace: string): MemoryKernelNamespace {
  let existing = memoryKernelNamespaces.get(namespace);
  if (existing == null) {
    existing = {
      traces: new Map<string, RunTraceLike>(),
      toolResults: [],
      chatMessages: [],
      artifacts: new Map(),
      activeArtifacts: new Map(),
      stateEntries: new Map(),
      corpora: new Map(),
      rlmRuns: new Map(),
      rlmSteps: [],
    };
    memoryKernelNamespaces.set(namespace, existing);
  }
  return existing;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createId(prefix: string): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `${prefix}_${crypto.randomUUID()}`
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getPathValue(value: unknown, path: string | undefined): unknown {
  if (path == null || path.trim().length === 0) {
    return value;
  }

  let current: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function makeStateNamespace(sessionId: string | undefined): string {
  return sessionId == null || sessionId.length === 0 ? "__global__" : sessionId;
}

function makeArtifactTargetKey(targetKind: string, targetId: string): string {
  return `${targetKind}:${targetId}`;
}

function renderUserMessage(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (isRecord(input)) {
    if (typeof input.message === "string") {
      return input.message;
    }
    if (typeof input.question === "string") {
      return input.question;
    }

    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (subject.length > 0 || body.length > 0) {
      return [`Subject: ${subject || "(none)"}`, body].filter(Boolean).join("\n\n");
    }
  }

  return stableStringify(input);
}

function renderAssistantMessage(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (isRecord(output)) {
    for (const key of ["response", "message", "answer", "customerReply"]) {
      if (typeof output[key] === "string") {
        return output[key] as string;
      }
    }
  }

  return stableStringify(output);
}

function toModelMessages(messages: KernelStoredChatMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.body === "string" ? message.body : stableStringify(message.body),
    ...(typeof message.metadata?.toolName === "string" ? { toolName: message.metadata.toolName } : {}),
    ...(typeof message.metadata?.toolCallId === "string"
      ? { toolCallId: message.metadata.toolCallId }
      : {}),
    ...(message.metadata != null ? { metadata: message.metadata } : {}),
  }));
}

function findAgentTool(
  project: NormalizedProjectLike<CloudflareEnvLike>,
  agentName: string,
  toolName: string,
): KernelTarget | null {
  const agent = project.agents.get(agentName);
  if (agent == null) {
    return null;
  }

  const tool = [agent.chat, ...(agent.tools ?? [])].find(
    (candidate) => getTargetId(asHostingTarget(candidate as KernelTarget)) === toolName,
  );
  return tool ?? null;
}

function findProjectTarget(
  project: NormalizedProjectLike<CloudflareEnvLike>,
  id: string,
): KernelTarget | null {
  const direct = project.programs.get(id);
  if (direct != null) {
    return direct;
  }

  for (const rpc of project.rpc.values()) {
    for (const [handlerName, handler] of Object.entries(rpc.handlers)) {
      if (handlerName === id || getTargetId(asHostingTarget(handler as KernelTarget)) === id) {
        return handler as KernelTarget;
      }
    }
  }

  for (const agent of project.agents.values()) {
    if (getTargetId(asHostingTarget(agent.chat as KernelTarget)) === id) {
      return agent.chat as KernelTarget;
    }
    for (const tool of agent.tools ?? []) {
      if (getTargetId(asHostingTarget(tool as KernelTarget)) === id) {
        return tool as KernelTarget;
      }
    }
  }

  for (const mcp of project.mcp.values()) {
    for (const tool of mcp.tools) {
      if (getTargetId(asHostingTarget(tool as KernelTarget)) === id) {
        return tool as KernelTarget;
      }
    }
  }

  return null;
}

function findProjectTool(
  project: NormalizedProjectLike<CloudflareEnvLike>,
  toolName: string,
): KernelTarget | null {
  const target = findProjectTarget(project, toolName);
  if (target != null) {
    return target;
  }

  for (const agent of project.agents.values()) {
    for (const tool of agent.tools ?? []) {
      const { definition } = buildToolDefinition(asHostingTarget(tool as KernelTarget));
      if (definition.name === toolName) {
        return tool as KernelTarget;
      }
    }
  }

  for (const mcp of project.mcp.values()) {
    for (const tool of mcp.tools) {
      const { definition } = buildToolDefinition(asHostingTarget(tool as KernelTarget));
      if (definition.name === toolName) {
        return tool as KernelTarget;
      }
    }
  }

  return null;
}

function createKernelTraceStore(
  persistence: KernelPersistence,
  delegate: RuntimeContextLike<CloudflareEnvLike>["traceStore"],
): {
  store: NonNullable<RuntimeContextLike<CloudflareEnvLike>["traceStore"]>;
  getLastSavedTrace(): RunTraceLike | null;
} {
  let lastSavedTrace: RunTraceLike | null = null;

  return {
    store: {
      async saveTrace(trace) {
        lastSavedTrace = cloneValue(trace);
        await persistence.saveTrace(trace);
        if (delegate != null) {
          await delegate.saveTrace(trace);
        }
      },
      async loadTrace(runId) {
        const stored = await persistence.loadTrace(runId);
        if (stored != null) {
          return stored;
        }
        return delegate?.loadTrace(runId) ?? Promise.resolve(null);
      },
      async listTraces(args) {
        return persistence.listTraces(args);
      },
    },
    getLastSavedTrace() {
      return lastSavedTrace == null ? null : cloneValue(lastSavedTrace);
    },
  };
}

function createKernelArtifactStore(
  persistence: KernelPersistence,
  delegate: RuntimeContextLike<CloudflareEnvLike>["artifactStore"],
): NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]> {
  return {
    async saveArtifact(artifact) {
      await persistence.saveArtifact(artifact);
      if (delegate != null) {
        await delegate.saveArtifact(artifact);
      }
    },
    async loadArtifact(id) {
      const stored = await persistence.loadArtifact(id);
      if (stored != null) {
        return stored;
      }
      return delegate?.loadArtifact(id) ?? Promise.resolve(null);
    },
    async listArtifacts(args) {
      const local = await persistence.listArtifacts(args);
      if (delegate?.listArtifacts == null) {
        return local;
      }

      const delegated = await delegate.listArtifacts(args);
      const merged = new Map<string, (typeof local)[number]>();
      for (const artifact of [...delegated, ...local]) {
        merged.set(artifact.id, artifact);
      }

      return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async loadActiveArtifact(args) {
      const stored = await persistence.loadActiveArtifact(args);
      if (stored != null) {
        return stored;
      }
      return delegate?.loadActiveArtifact(args) ?? Promise.resolve(null);
    },
    async setActiveArtifact(args) {
      await persistence.setActiveArtifact(args);
      if (delegate != null) {
        await delegate.setActiveArtifact(args);
      }
    },
  };
}

async function createKernelCorpusProvider(args: {
  persistence: KernelPersistence;
  runtime: RuntimeContextLike<CloudflareEnvLike>;
  project: NormalizedProjectLike<CloudflareEnvLike>;
  env?: CloudflareEnvLike;
}): Promise<CorpusProviderLike<CloudflareEnvLike> | undefined> {
  const persisted =
    args.persistence.listCorpora == null ? [] : await args.persistence.listCorpora();
  const persistedProvider =
    persisted.length === 0
      ? undefined
      : createCorpusProvider({
          corpora: persisted.map((entry) => entry.corpus),
          ...(args.env ? { env: args.env } : {}),
        });
  const projectProvider =
    args.project.corpora.size === 0
      ? undefined
      : createCorpusProvider({
          corpora: args.project.corpora,
          ...(args.env ? { env: args.env } : {}),
        });

  return mergeCorpusProviders(persistedProvider, projectProvider, args.runtime.corpora);
}

async function createKernelRuntime(args: {
  persistence: KernelPersistence;
  runtime: RuntimeContextLike<CloudflareEnvLike>;
  project: NormalizedProjectLike<CloudflareEnvLike>;
  env?: CloudflareEnvLike;
}): Promise<RuntimeContextLike<CloudflareEnvLike>> {
  const corpora = await createKernelCorpusProvider(args);
  return corpora == null
    ? args.runtime
    : {
        ...args.runtime,
        corpora,
      };
}

async function buildBindingState(
  persistence: KernelPersistence,
  sessionId: string | undefined,
): Promise<ToolBindingState | undefined> {
  if (sessionId == null) {
    return undefined;
  }

  const storedMessages = await persistence.listChatMessages({
    sessionId,
    limit: 200,
  });
  const chatHistory = toModelMessages(storedMessages);
  const currentUserMessage = [...chatHistory]
    .reverse()
    .find((message) => message.role === "user")?.content;
  const latestAssistantMessage = [...chatHistory]
    .reverse()
    .find((message) => message.role === "assistant")?.content;

  const state: ToolBindingState = {
    async loadLatestToolResult(toolName, options) {
      const record = await persistence.loadLatestToolResult({
        sessionId,
        toolName,
        ...(options?.resultId ? { resultId: options.resultId } : {}),
      });

      if (record == null) {
        if (options?.required) {
          throw new Error(`No prior result was found for tool "${toolName}" in session "${sessionId}".`);
        }
        return undefined;
      }

      return getPathValue(record.output, options?.path);
    },
    async loadState(key, path) {
      if (persistence.loadState == null) {
        return undefined;
      }
      return persistence.loadState(path == null ? { sessionId, key } : { sessionId, key, path });
    },
  };

  if (currentUserMessage != null) {
    state.currentUserMessage = currentUserMessage;
  }
  if (latestAssistantMessage != null) {
    state.latestAssistantMessage = latestAssistantMessage;
  }
  if (chatHistory.length > 0) {
    state.chatHistory = chatHistory;
  }

  return state;
}

async function persistRlmTrace(args: {
  persistence: KernelPersistence;
  trace: RunTraceLike;
  moduleId: string;
  sessionId?: string;
}): Promise<void> {
  if (args.persistence.saveRlmRun == null) {
    return;
  }

  const programmable = (args.trace as RunTraceLike & {
    programmable?: {
      mode?: string;
      context?: {
        manifest?: unknown;
      };
      steps?: Array<{
        index?: number;
        reasoning?: string;
        code?: string;
        stdout?: string;
        stderr?: string;
        logs?: string[];
        toolCalls?: unknown;
        submitted?: unknown;
        submitValidationError?: unknown;
        error?: unknown;
        queryCallsUsed?: number;
        startedAt?: string;
        endedAt?: string;
      }>;
    };
  }).programmable;

  if (programmable?.mode !== "rlm") {
    return;
  }

  await args.persistence.saveRlmRun({
    runId: args.trace.runId,
    moduleId: args.moduleId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    status: args.trace.error == null ? "completed" : "failed",
    input: args.trace.input,
    ...(args.trace.output !== undefined ? { output: args.trace.output } : {}),
    ...(args.trace.error != null ? { error: args.trace.error } : {}),
    traceId: args.trace.runId,
    ...(programmable.context?.manifest !== undefined
      ? { contextManifest: programmable.context.manifest }
      : {}),
    startedAt: args.trace.startedAt,
    ...(args.trace.endedAt != null ? { endedAt: args.trace.endedAt } : {}),
    updatedAt: args.trace.endedAt ?? nowIso(),
  });

  if (args.persistence.saveRlmStep == null) {
    return;
  }

  for (const [index, step] of (programmable.steps ?? []).entries()) {
    await args.persistence.saveRlmStep({
      runId: args.trace.runId,
      stepIndex: step.index ?? index + 1,
      ...(step.reasoning != null ? { reasoning: step.reasoning } : {}),
      code: step.code ?? "",
      ...(step.stdout != null ? { stdout: step.stdout } : {}),
      ...(step.stderr != null ? { stderr: step.stderr } : {}),
      logs: [...(step.logs ?? [])],
      ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
      ...(step.submitted !== undefined ? { submitted: step.submitted } : {}),
      ...(step.submitValidationError !== undefined
        ? { submitValidationError: step.submitValidationError }
        : {}),
      ...(step.error !== undefined ? { error: step.error } : {}),
      ...(typeof step.queryCallsUsed === "number" ? { queryCallsUsed: step.queryCallsUsed } : {}),
      startedAt: step.startedAt ?? args.trace.startedAt,
      ...(step.endedAt != null ? { endedAt: step.endedAt } : {}),
    });
  }
}

function deriveRlmRunFromTrace(args: {
  trace: RunTraceLike;
  moduleId: string;
  sessionId?: string;
}): KernelStoredRlmRun | null {
  const programmable = (args.trace as RunTraceLike & {
    programmable?: {
      mode?: string;
      context?: {
        manifest?: unknown;
      };
    };
  }).programmable;

  if (programmable?.mode !== "rlm") {
    return null;
  }

  return {
    runId: args.trace.runId,
    moduleId: args.moduleId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    status: args.trace.error == null ? "completed" : "failed",
    input: args.trace.input,
    ...(args.trace.output !== undefined ? { output: args.trace.output } : {}),
    ...(args.trace.error != null ? { error: args.trace.error } : {}),
    traceId: args.trace.runId,
    ...(programmable.context?.manifest !== undefined
      ? { contextManifest: programmable.context.manifest }
      : {}),
    startedAt: args.trace.startedAt,
    ...(args.trace.endedAt != null ? { endedAt: args.trace.endedAt } : {}),
    updatedAt: args.trace.endedAt ?? nowIso(),
  };
}

function deriveRlmStepsFromTrace(trace: RunTraceLike): KernelStoredRlmStep[] {
  const programmable = (trace as RunTraceLike & {
    programmable?: {
      mode?: string;
      steps?: Array<{
        index?: number;
        reasoning?: string;
        code?: string;
        stdout?: string;
        stderr?: string;
        logs?: string[];
        toolCalls?: unknown;
        submitted?: unknown;
        submitValidationError?: unknown;
        error?: unknown;
        queryCallsUsed?: number;
        startedAt?: string;
        endedAt?: string;
      }>;
    };
  }).programmable;

  if (programmable?.mode !== "rlm") {
    return [];
  }

  return (programmable.steps ?? []).map((step, index) => ({
    runId: trace.runId,
    stepIndex: step.index ?? index + 1,
    ...(step.reasoning != null ? { reasoning: step.reasoning } : {}),
    code: step.code ?? "",
    ...(step.stdout != null ? { stdout: step.stdout } : {}),
    ...(step.stderr != null ? { stderr: step.stderr } : {}),
    logs: [...(step.logs ?? [])],
    ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
    ...(step.submitted !== undefined ? { submitted: step.submitted } : {}),
    ...(step.submitValidationError !== undefined
      ? { submitValidationError: step.submitValidationError }
      : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    ...(typeof step.queryCallsUsed === "number" ? { queryCallsUsed: step.queryCallsUsed } : {}),
    startedAt: step.startedAt ?? trace.startedAt,
    ...(step.endedAt != null ? { endedAt: step.endedAt } : {}),
  }));
}

export class MemoryKernelPersistence implements KernelPersistence {
  private readonly namespace: MemoryKernelNamespace;

  constructor(namespace = "default") {
    this.namespace = getMemoryKernelNamespace(namespace);
  }

  async saveTrace(trace: RunTraceLike): Promise<void> {
    this.namespace.traces.set(trace.runId, cloneValue(trace));
  }

  async loadTrace(runId: string): Promise<RunTraceLike | null> {
    const trace = this.namespace.traces.get(runId);
    return trace == null ? null : cloneValue(trace);
  }

  async listTraces(args?: {
    targetKind?: string;
    targetId?: string;
    limit?: number;
  }): Promise<RunTraceLike[]> {
    const traces = Array.from(this.namespace.traces.values())
      .filter((trace) => {
        if (args?.targetKind != null && trace.targetKind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && trace.targetId !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return cloneValue(args?.limit != null ? traces.slice(0, args.limit) : traces);
  }

  async saveToolResult(value: KernelStoredToolResult): Promise<void> {
    this.namespace.toolResults.push(cloneValue(value));
  }

  async loadLatestToolResult(args: {
    sessionId?: string;
    toolName: string;
    resultId?: string;
  }): Promise<KernelStoredToolResult | null> {
    const matches = [...this.namespace.toolResults]
      .filter((entry) => {
        if (entry.toolName !== args.toolName) {
          return false;
        }
        if (args.resultId != null) {
          return entry.id === args.resultId;
        }
        if (args.sessionId != null) {
          return entry.sessionId === args.sessionId;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return matches[0] == null ? null : cloneValue(matches[0]);
  }

  async appendChatMessage(message: KernelStoredChatMessage): Promise<void> {
    this.namespace.chatMessages.push(cloneValue(message));
  }

  async listChatMessages(args: {
    sessionId: string;
    limit?: number;
  }): Promise<KernelStoredChatMessage[]> {
    const matches = this.namespace.chatMessages
      .filter((message) => message.sessionId === args.sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const limited = args.limit != null ? matches.slice(-args.limit) : matches;
    return cloneValue(limited);
  }

  async saveArtifact(
    artifact: NonNullable<
      Awaited<ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadArtifact"]>>
    >,
  ): Promise<void> {
    this.namespace.artifacts.set(artifact.id, cloneValue(artifact));
  }

  async loadArtifact(
    id: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadArtifact"]>>
  > {
    const artifact = this.namespace.artifacts.get(id);
    return artifact == null ? null : cloneValue(artifact);
  }

  async listArtifacts(args?: {
    targetKind?: "predict" | "program" | "agent";
    targetId?: string;
    limit?: number;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["listArtifacts"]>>
    >
  > {
    const artifacts = Array.from(this.namespace.artifacts.values())
      .filter((artifact) => {
        if (args?.targetKind != null && artifact.target.kind !== args.targetKind) {
          return false;
        }
        if (args?.targetId != null && artifact.target.id !== args.targetId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return cloneValue(args?.limit != null ? artifacts.slice(0, args.limit) : artifacts);
  }

  async loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<
    Awaited<
      ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadActiveArtifact"]>
    >
  > {
    const artifactId = this.namespace.activeArtifacts.get(
      makeArtifactTargetKey(args.targetKind, args.targetId),
    );
    if (artifactId == null) {
      return null;
    }
    const artifact = this.namespace.artifacts.get(artifactId);
    return artifact == null ? null : cloneValue(artifact);
  }

  async setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void> {
    this.namespace.activeArtifacts.set(
      makeArtifactTargetKey(args.targetKind, args.targetId),
      args.artifactId,
    );
  }

  async loadState(args: { sessionId?: string; key: string; path?: string }): Promise<unknown> {
    const entry = this.namespace.stateEntries.get(
      `${makeStateNamespace(args.sessionId)}:${args.key}`,
    );
    if (entry == null) {
      return undefined;
    }
    return getPathValue(entry.value, args.path);
  }

  async saveState(args: { sessionId?: string; key: string; value: unknown }): Promise<void> {
    this.namespace.stateEntries.set(`${makeStateNamespace(args.sessionId)}:${args.key}`, {
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      key: args.key,
      value: cloneValue(args.value),
      updatedAt: nowIso(),
    });
  }

  async saveCorpus(value: KernelStoredCorpus): Promise<void> {
    this.namespace.corpora.set(value.corpus.id, cloneValue(value));
  }

  async loadCorpus(corpusId: string): Promise<KernelStoredCorpus | null> {
    const value = this.namespace.corpora.get(corpusId);
    return value == null ? null : cloneValue(value);
  }

  async listCorpora(): Promise<KernelStoredCorpus[]> {
    return cloneValue(
      [...this.namespace.corpora.values()].sort((left, right) =>
        left.corpus.id.localeCompare(right.corpus.id),
      ),
    );
  }

  async saveRlmRun(value: KernelStoredRlmRun): Promise<void> {
    this.namespace.rlmRuns.set(value.runId, cloneValue(value));
  }

  async loadRlmRun(runId: string): Promise<KernelStoredRlmRun | null> {
    const value = this.namespace.rlmRuns.get(runId);
    return value == null ? null : cloneValue(value);
  }

  async saveRlmStep(value: KernelStoredRlmStep): Promise<void> {
    const index = this.namespace.rlmSteps.findIndex(
      (step) => step.runId === value.runId && step.stepIndex === value.stepIndex,
    );
    if (index >= 0) {
      this.namespace.rlmSteps[index] = cloneValue(value);
      return;
    }
    this.namespace.rlmSteps.push(cloneValue(value));
  }

  async listRlmSteps(runId: string): Promise<KernelStoredRlmStep[]> {
    return cloneValue(
      this.namespace.rlmSteps
        .filter((step) => step.runId === runId)
        .sort((left, right) => left.stepIndex - right.stepIndex),
    );
  }
}

export async function executeKernelTarget(args: {
  target: KernelTarget;
  input: unknown;
  runtime: RuntimeContextLike<CloudflareEnvLike>;
  env?: CloudflareEnvLike;
  request?: Request;
  sessionId?: string;
  persistence: KernelPersistence;
  metadata?: Record<string, unknown>;
}): Promise<{
  output: unknown;
  traceId: string;
  trace: RunTraceLike;
}> {
  const targetId = getTargetId(asHostingTarget(args.target));
  const targetKind = getTargetKind(asHostingTarget(args.target));
  const inputSchema = getInputSchema(asHostingTarget(args.target));
  const validatedInput = validateWithSchema(inputSchema, args.input);
  const { store: traceStore, getLastSavedTrace } = createKernelTraceStore(
    args.persistence,
    args.runtime.traceStore,
  );
  const artifactStore = createKernelArtifactStore(args.persistence, args.runtime.artifactStore);
  const runtime: RuntimeContextLike<CloudflareEnvLike> = {
    ...args.runtime,
    traceStore,
    artifactStore,
  };

  if ("execute" in args.target) {
    const trace = createRouteTrace(
      targetId,
      "tool" as RunTraceLike["targetKind"],
      validatedInput,
      args.metadata,
    );
    const component: RunTraceLike["components"][number] = {
      componentId: targetId,
      componentKind: "tool",
      startedAt: nowIso(),
      input: validatedInput,
      stdout: "",
    };
    trace.components.push(component);

    try {
      const bindingState = await buildBindingState(args.persistence, args.sessionId);
      const toolContext: ToolExecutionContextLike<CloudflareEnvLike> = {
        runtime,
        ...(args.env ? { env: args.env } : {}),
        ...(args.request ? { request: args.request } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        trace,
        log(message) {
          trace.stdout = trace.stdout ? `${trace.stdout}\n${message}` : message;
          component.stdout = component.stdout ? `${component.stdout}\n${message}` : message;
        },
      };

      if (bindingState != null) {
        (toolContext as ToolExecutionContextLike<CloudflareEnvLike> & {
          bindingState?: ToolBindingState;
        }).bindingState = bindingState;
      }

      const inspectableTarget = args.target as unknown as {
        inspectExecutionPlan?: () => Record<string, unknown>;
      };
      const executionPlan =
        typeof inspectableTarget.inspectExecutionPlan === "function"
          ? inspectableTarget.inspectExecutionPlan()
          : undefined;

      const output = await args.target.execute(validatedInput, toolContext);
      const validatedOutput = validateWithSchema(
        getOutputSchema(asHostingTarget(args.target)),
        output,
      );

      component.output = validatedOutput;
      component.endedAt = nowIso();
      trace.output = validatedOutput;
      trace.endedAt = nowIso();

      trace.toolCalls.push({
        toolName: targetId,
        input: validatedInput,
        output: validatedOutput,
        source: "direct-binding",
        startedAt: component.startedAt,
        endedAt: trace.endedAt,
        ...(executionPlan != null ? { metadata: { executionPlan } } : {}),
      });

      await traceStore.saveTrace(trace);
      await args.persistence.saveToolResult({
        id: createId("tool_result"),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        toolName: targetId,
        input: validatedInput,
        output: validatedOutput,
        traceId: trace.runId,
        createdAt: trace.endedAt,
      });

      if (args.sessionId != null) {
        await args.persistence.appendChatMessage({
          id: createId("chat"),
          sessionId: args.sessionId,
          role: "tool",
          body: validatedOutput,
          metadata: {
            toolName: targetId,
            traceId: trace.runId,
            ...(executionPlan != null ? { executionPlan } : {}),
          },
          createdAt: trace.endedAt,
        });
      }

      return {
        output: validatedOutput,
        traceId: trace.runId,
        trace,
      };
    } catch (error) {
      component.error = serializeError(error);
      component.endedAt = nowIso();
      trace.error = serializeError(error);
      trace.endedAt = nowIso();
      trace.toolCalls.push({
        toolName: targetId,
        input: validatedInput,
        error: trace.error,
        source: "direct-binding",
        startedAt: component.startedAt,
        endedAt: trace.endedAt,
      });
      await traceStore.saveTrace(trace);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        traceId: trace.runId,
      });
    }
  }

  try {
    const output = await args.target(validatedInput, {
      runtime,
      ...(args.env ? { env: args.env } : {}),
      ...(args.request ? { request: args.request } : {}),
    });
    const validatedOutput = validateWithSchema(
      getOutputSchema(asHostingTarget(args.target)),
      output,
    );
    const nestedTrace = getLastSavedTrace();

    if (nestedTrace != null) {
      await traceStore.saveTrace(nestedTrace);
      if (targetKind === "rlm") {
        await persistRlmTrace({
          persistence: args.persistence,
          trace: nestedTrace,
          moduleId: targetId,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        });
      }
      return {
        output: validatedOutput,
        traceId: nestedTrace.runId,
        trace: nestedTrace,
      };
    }

    const fallbackTrace = createRouteTrace(
      targetId,
      targetKind as RunTraceLike["targetKind"],
      validatedInput,
      args.metadata,
    );
    fallbackTrace.output = validatedOutput;
    fallbackTrace.endedAt = nowIso();
    await traceStore.saveTrace(fallbackTrace);
    if (targetKind === "rlm") {
      await persistRlmTrace({
        persistence: args.persistence,
        trace: fallbackTrace,
        moduleId: targetId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      });
    }
    return {
      output: validatedOutput,
      traceId: fallbackTrace.runId,
      trace: fallbackTrace,
    };
  } catch (error) {
    const nestedTrace = getLastSavedTrace();
    if (nestedTrace != null) {
      await traceStore.saveTrace(nestedTrace);
      if (targetKind === "rlm") {
        await persistRlmTrace({
          persistence: args.persistence,
          trace: nestedTrace,
          moduleId: targetId,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        });
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        traceId: nestedTrace.runId,
      });
    }

    const fallbackTrace = createRouteTrace(
      targetId,
      targetKind as RunTraceLike["targetKind"],
      validatedInput,
      args.metadata,
    );
    fallbackTrace.error = serializeError(error);
    fallbackTrace.endedAt = nowIso();
    await traceStore.saveTrace(fallbackTrace);
    if (targetKind === "rlm") {
      await persistRlmTrace({
        persistence: args.persistence,
        trace: fallbackTrace,
        moduleId: targetId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      });
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      traceId: fallbackTrace.runId,
    });
  }
}

async function parseRequestInput(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    const input = new URL(request.url).searchParams.get("input");
    if (input == null) {
      return undefined;
    }
    try {
      return JSON.parse(input);
    } catch {
      return input;
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

type KernelFiberRunner = {
  runFiber<T>(
    name: string,
    fn: (fiber: { stash(value: unknown): void; snapshot?: unknown }) => Promise<T>,
  ): Promise<T>;
};

export async function handleKernelRequest(args: {
  request: Request;
  env?: CloudflareEnvLike;
  runtime: RuntimeContextLike<CloudflareEnvLike>;
  project: NormalizedProjectLike<CloudflareEnvLike>;
  persistence: KernelPersistence;
  warnings: string[];
  fiberRunner?: KernelFiberRunner;
}): Promise<Response> {
  const url = new URL(args.request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "kernel") {
    return notFound(`No route matched "${url.pathname}".`, args.warnings);
  }
  const runtime = await createKernelRuntime({
    persistence: args.persistence,
    runtime: args.runtime,
    project: args.project,
    ...(args.env ? { env: args.env } : {}),
  });
  const artifactStore = createKernelArtifactStore(args.persistence, args.runtime.artifactStore);

  if (segments[1] === "run" && segments[2] != null && args.request.method === "POST") {
    const payload = await parseRequestInput(args.request);
    const target = findProjectTarget(args.project, segments[2]);
    if (target == null) {
      return notFound(`Module "${segments[2]}" was not found.`, args.warnings);
    }

    const input = isRecord(payload) && "input" in payload ? payload.input : payload;
    const sessionId =
      isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId : undefined;

    try {
      const result = await executeKernelTarget({
        target,
        input,
        runtime,
        ...(args.env ? { env: args.env } : {}),
        request: args.request,
        ...(sessionId ? { sessionId } : {}),
        persistence: args.persistence,
        metadata: {
          route: "kernel.run",
          targetId: segments[2],
        },
      });
      return jsonResponse(
        200,
        {
          ok: true,
          target: {
            kind: getTargetKind(asHostingTarget(target)),
            id: getTargetId(asHostingTarget(target)),
          },
          output: result.output,
          traceId: result.traceId,
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
          traceId: isRecord(error) && typeof error.traceId === "string" ? error.traceId : undefined,
        },
        args.warnings,
      );
    }
  }

  if (segments[1] === "tool" && segments[2] != null && args.request.method === "POST") {
    const payload = await parseRequestInput(args.request);
    const target = findProjectTool(args.project, segments[2]);
    if (target == null) {
      return notFound(`Tool "${segments[2]}" was not found.`, args.warnings);
    }

    const input = isRecord(payload) && "input" in payload ? payload.input : payload;
    const sessionId =
      isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId : undefined;

    try {
      const result = await executeKernelTarget({
        target,
        input,
        runtime,
        ...(args.env ? { env: args.env } : {}),
        request: args.request,
        ...(sessionId ? { sessionId } : {}),
        persistence: args.persistence,
        metadata: {
          route: "kernel.tool",
          toolName: segments[2],
        },
      });
      return jsonResponse(
        200,
        {
          ok: true,
          tool: getTargetId(asHostingTarget(target)),
          output: result.output,
          traceId: result.traceId,
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
          traceId: isRecord(error) && typeof error.traceId === "string" ? error.traceId : undefined,
        },
        args.warnings,
      );
    }
  }

  if (segments[1] === "rlm" && segments[2] != null && args.request.method === "GET") {
    if (args.persistence.loadRlmRun == null) {
      return notFound(`RLM run storage is not configured.`, args.warnings);
    }

    let run = await args.persistence.loadRlmRun(segments[2]);
    let steps = args.persistence.listRlmSteps == null ? [] : await args.persistence.listRlmSteps(segments[2]);

    if (run == null) {
      const trace = await args.persistence.loadTrace(segments[2]);
      if (trace == null || trace.targetKind !== "rlm") {
        return notFound(`RLM run "${segments[2]}" was not found.`, args.warnings);
      }

      const recoveredRun = deriveRlmRunFromTrace({
        trace,
        moduleId: trace.targetId,
      });
      if (recoveredRun == null) {
        return notFound(`RLM run "${segments[2]}" was not found.`, args.warnings);
      }

      if (args.persistence.saveRlmRun != null) {
        await args.persistence.saveRlmRun(recoveredRun);
      }
      for (const step of deriveRlmStepsFromTrace(trace)) {
        if (args.persistence.saveRlmStep != null) {
          await args.persistence.saveRlmStep(step);
        }
      }

      run = recoveredRun;
      steps = deriveRlmStepsFromTrace(trace);
    }

    return jsonResponse(
      200,
      {
        ok: true,
        run,
        steps,
      },
      args.warnings,
    );
  }

  if (segments[1] === "rlm" && segments[2] != null && args.request.method === "POST") {
    const payload = await parseRequestInput(args.request);
    const target = findProjectTarget(args.project, segments[2]);
    if (target == null) {
      return notFound(`RLM module "${segments[2]}" was not found.`, args.warnings);
    }

    if (getTargetKind(asHostingTarget(target)) !== "rlm") {
      return badRequest(`Target "${segments[2]}" is not an RLM module.`, args.warnings);
    }

    const input = isRecord(payload) && "input" in payload ? payload.input : payload;
    const sessionId =
      isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    const runId =
      isRecord(payload) && typeof payload.runId === "string" ? payload.runId : createId("run");
    const durable =
      isRecord(payload) &&
      isRecord(payload.execution) &&
      payload.execution.durable === true;
    const hostedSessionManager =
      isRecord(args.runtime) &&
      isRecord((args.runtime as { __superobjectiveCloudflareInternal?: unknown }).__superobjectiveCloudflareInternal) &&
      (args.runtime as {
        __superobjectiveCloudflareInternal: { rlmSessionManager?: { deleteSession?(runId: string): Promise<void> } };
      }).__superobjectiveCloudflareInternal.rlmSessionManager != null
        ? (args.runtime as {
            __superobjectiveCloudflareInternal: { rlmSessionManager: { deleteSession?(runId: string): Promise<void> } };
          }).__superobjectiveCloudflareInternal.rlmSessionManager
        : undefined;

    const createRlmRuntime = (onCheckpoint?: (value: {
      runId: string;
      moduleId: string;
      nextIteration: number;
      llmCallsUsed: number;
      queryCallsUsed: number;
      sessionKind?: string;
    }) => void | Promise<void>) =>
      ({
        ...runtime,
        __superobjectiveRlmResume: {
          runId,
        },
        ...(onCheckpoint != null
          ? {
              __superobjectiveRlmCheckpoint: onCheckpoint,
            }
          : {}),
      }) as RuntimeContextLike<CloudflareEnvLike>;

    const executeRlm = async (runtimeOverride?: RuntimeContextLike<CloudflareEnvLike>) =>
      executeKernelTarget({
        target,
        input,
        runtime: runtimeOverride ?? createRlmRuntime(),
        ...(args.env ? { env: args.env } : {}),
        request: args.request,
        ...(sessionId ? { sessionId } : {}),
        persistence: args.persistence,
        metadata: {
          route: "kernel.rlm",
          moduleId: segments[2],
          ...(durable ? { durable: true } : {}),
        },
      });

    try {
      const result =
        durable && args.fiberRunner != null
          ? await args.fiberRunner.runFiber(
              `rlm:${segments[2]}:${sessionId ?? "default"}`,
              async (fiber) => {
                const stashSnapshot = (extra?: Record<string, unknown>) =>
                  fiber.stash({
                    route: "kernel.rlm",
                    runId,
                    moduleId: segments[2],
                    sessionId,
                    payload,
                    ...(extra ?? {}),
                  });

                stashSnapshot();
                const runtimeOverride = createRlmRuntime(async (checkpoint) => {
                  stashSnapshot({
                    checkpointVersion: checkpoint.nextIteration,
                    llmCallsUsed: checkpoint.llmCallsUsed,
                    queryCallsUsed: checkpoint.queryCallsUsed,
                    ...(checkpoint.sessionKind != null
                      ? { sessionKind: checkpoint.sessionKind }
                      : {}),
                  });
                });
                return executeRlm(runtimeOverride);
              },
            )
          : await executeRlm();

      return jsonResponse(
        200,
        {
          ok: true,
          target: {
            kind: "rlm",
            id: getTargetId(asHostingTarget(target)),
          },
          output: result.output,
          traceId: result.traceId,
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
          traceId: isRecord(error) && typeof error.traceId === "string" ? error.traceId : undefined,
        },
        args.warnings,
      );
    } finally {
      await hostedSessionManager?.deleteSession?.(runId);
    }
  }

  if (
    segments[1] === "agent" &&
    segments[2] != null &&
    segments[3] != null &&
    (args.request.method === "GET" || args.request.method === "POST")
  ) {
    const agentName = segments[2];
    const sessionId = segments[3];
    const agent = args.project.agents.get(agentName);
    if (agent == null) {
      return notFound(`Agent "${agentName}" was not found.`, args.warnings);
    }

    if (args.request.method === "GET") {
      return jsonResponse(
        200,
        {
          ok: true,
          agent: agentName,
          sessionId,
          tools: [agent.chat, ...(agent.tools ?? [])].map((tool) => {
            const { definition, jsonSchema } = buildToolDefinition(
              asHostingTarget(tool as KernelTarget),
            );
            return {
              name: definition.name,
              description: definition.description,
              ...(jsonSchema != null ? { inputJsonSchema: jsonSchema } : {}),
            };
          }),
        },
        args.warnings,
      );
    }

    const payload = await parseRequestInput(args.request);
    if (payload == null) {
      return badRequest("Agent messages require a JSON body.", args.warnings);
    }

    const toolName =
      isRecord(payload) && typeof payload.tool === "string" ? payload.tool : undefined;
    const input = isRecord(payload) && "input" in payload ? payload.input : payload;

    if (toolName == null) {
      await args.persistence.appendChatMessage({
        id: createId("chat"),
        sessionId,
        role: "user",
        body: renderUserMessage(input),
        createdAt: nowIso(),
      });
    }

    const target = toolName != null ? findAgentTool(args.project, agentName, toolName) : agent.chat;
    if (target == null) {
      return notFound(
        `Tool "${toolName}" was not found on agent "${agentName}".`,
        args.warnings,
      );
    }

    try {
      const result = await executeKernelTarget({
        target,
        input,
        runtime,
        ...(args.env ? { env: args.env } : {}),
        request: args.request,
        sessionId,
        persistence: args.persistence,
        metadata: {
          route: "kernel.agent",
          agentName,
          sessionId,
          ...(toolName ? { toolName } : {}),
        },
      });

      if (toolName == null) {
        await args.persistence.appendChatMessage({
          id: createId("chat"),
          sessionId,
          role: "assistant",
          body: renderAssistantMessage(result.output),
          createdAt: nowIso(),
        });
      }

      return jsonResponse(
        200,
        {
          ok: true,
          agent: agentName,
          sessionId,
          ...(toolName ? { tool: toolName } : {}),
          output: result.output,
          traceId: result.traceId,
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
          traceId: isRecord(error) && typeof error.traceId === "string" ? error.traceId : undefined,
        },
        args.warnings,
      );
    }
  }

  if (segments[1] === "traces" && segments[2] != null && args.request.method === "GET") {
    const trace = await args.persistence.loadTrace(segments[2]);
    if (trace == null) {
      return notFound(`Trace "${segments[2]}" was not found.`, args.warnings);
    }
    return jsonResponse(
      200,
      {
        ok: true,
        trace,
      },
      args.warnings,
    );
  }

  if (segments[1] === "traces" && args.request.method === "GET") {
    const limitParam = url.searchParams.get("limit");
    const limit =
      limitParam != null && Number.isFinite(Number(limitParam)) ? Number.parseInt(limitParam, 10) : undefined;
    const listArgs: {
      targetKind?: string;
      targetId?: string;
      limit?: number;
    } = {};
    const targetKind = url.searchParams.get("targetKind");
    const targetId = url.searchParams.get("targetId");
    if (targetKind != null) {
      listArgs.targetKind = targetKind;
    }
    if (targetId != null) {
      listArgs.targetId = targetId;
    }
    if (limit != null) {
      listArgs.limit = limit;
    }
    const traces = await args.persistence.listTraces(listArgs);
    return jsonResponse(
      200,
      {
        ok: true,
        traces,
      },
      args.warnings,
    );
  }

  if (segments[1] === "state" && segments[2] != null && args.request.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const path = url.searchParams.get("path") ?? undefined;
    const value = await args.persistence.loadState?.({
      ...(sessionId ? { sessionId } : {}),
      key: segments[2],
      ...(path ? { path } : {}),
    });
    return jsonResponse(
      200,
      {
        ok: true,
        key: segments[2],
        ...(sessionId ? { sessionId } : {}),
        value,
      },
      args.warnings,
    );
  }

  if (segments[1] === "state" && segments[2] != null && args.request.method === "POST") {
    const payload = await parseRequestInput(args.request);
    if (!isRecord(payload) || !("value" in payload)) {
      return badRequest('State writes require a JSON body with "value".', args.warnings);
    }

    await args.persistence.saveState?.({
      ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
      key: segments[2],
      value: payload.value,
    });

    return jsonResponse(
      200,
      {
        ok: true,
        key: segments[2],
        ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
      },
      args.warnings,
    );
  }

  if (segments[1] === "corpora" && segments[2] == null && args.request.method === "POST") {
    const payload = await parseRequestInput(args.request);
    const corpus = isRecord(payload) && "corpus" in payload ? payload.corpus : payload;
    if (
      !isRecord(corpus) ||
      typeof corpus.id !== "string" ||
      !isRecord(corpus.storage) ||
      corpus.storage.kind !== "r2" ||
      typeof corpus.storage.bucketBinding !== "string" ||
      typeof corpus.storage.prefix !== "string"
    ) {
      return badRequest(
        'Corpus writes require a JSON corpus payload with "id" and an R2 "storage" descriptor.',
        args.warnings,
      );
    }

    const existing = await args.persistence.loadCorpus?.(corpus.id);
    const timestamp = nowIso();
    await args.persistence.saveCorpus?.({
      corpus: corpus as CorpusDescriptorLike,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });

    return jsonResponse(
      200,
      {
        ok: true,
        corpus,
      },
      args.warnings,
    );
  }

  if (segments[1] === "corpora" && segments[2] == null && args.request.method === "GET") {
    const corpora = await runtime.corpora?.list?.();
    return jsonResponse(
      200,
      {
        ok: true,
        corpora: corpora ?? [],
      },
      args.warnings,
    );
  }

  if (segments[1] === "corpora" && segments[2] != null && segments[3] == null && args.request.method === "GET") {
    const persisted = await args.persistence.loadCorpus?.(segments[2]);
    if (persisted != null) {
      return jsonResponse(
        200,
        {
          ok: true,
          corpus: persisted.corpus,
        },
        args.warnings,
      );
    }

    try {
      const handle = await runtime.corpora?.resolve(segments[2]);
      if (handle == null) {
        return notFound(`Corpus "${segments[2]}" was not found.`, args.warnings);
      }
      return jsonResponse(
        200,
        {
          ok: true,
          corpus: handle.corpus,
        },
        args.warnings,
      );
    } catch (error) {
      return notFound(`Corpus "${segments[2]}" was not found.`, args.warnings);
    }
  }

  if (
    segments[1] === "corpora" &&
    segments[2] != null &&
    segments[3] === "files" &&
    args.request.method === "GET"
  ) {
    try {
      const handle = await runtime.corpora?.resolve(segments[2]);
      if (handle == null) {
        return notFound(`Corpus "${segments[2]}" was not found.`, args.warnings);
      }
      const prefix = url.searchParams.get("prefix") ?? undefined;
      return jsonResponse(
        200,
        {
          ok: true,
          corpusId: segments[2],
          files: await handle.files.list(prefix),
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
        },
        args.warnings,
      );
    }
  }

  if (
    segments[1] === "corpora" &&
    segments[2] != null &&
    segments[3] === "read" &&
    args.request.method === "POST"
  ) {
    const payload = await parseRequestInput(args.request);
    if (!isRecord(payload) || typeof payload.path !== "string") {
      return badRequest('Corpus reads require a JSON body with "path".', args.warnings);
    }

    try {
      const handle = await runtime.corpora?.resolve(segments[2]);
      if (handle == null) {
        return notFound(`Corpus "${segments[2]}" was not found.`, args.warnings);
      }
      return jsonResponse(
        200,
        {
          ok: true,
          corpusId: segments[2],
          path: payload.path,
          content: await handle.files.getText(payload.path),
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
        },
        args.warnings,
      );
    }
  }

  if (
    segments[1] === "corpora" &&
    segments[2] != null &&
    segments[3] === "search" &&
    args.request.method === "POST"
  ) {
    const payload = await parseRequestInput(args.request);
    try {
      const handle = await runtime.corpora?.resolve(segments[2]);
      if (handle == null) {
        return notFound(`Corpus "${segments[2]}" was not found.`, args.warnings);
      }
      if (handle.search == null) {
        return badRequest(`Corpus "${segments[2]}" does not have AI Search configured.`, args.warnings);
      }

      const result = await handle.search.search(
        isRecord(payload)
          ? {
              ...(typeof payload.query === "string" ? { query: payload.query } : {}),
              ...(Array.isArray(payload.messages) ? { messages: payload.messages as ModelMessage[] } : {}),
              ...(isRecord(payload.filters) ? { filters: payload.filters } : {}),
              ...(typeof payload.maxResults === "number" ? { maxResults: payload.maxResults } : {}),
              ...(Array.isArray(payload.instanceIds)
                ? { instanceIds: payload.instanceIds.filter((value): value is string => typeof value === "string") }
                : {}),
            }
          : {},
      );

      return jsonResponse(
        200,
        {
          ok: true,
          corpusId: segments[2],
          result,
        },
        args.warnings,
      );
    } catch (error) {
      return jsonResponse(
        500,
        {
          ok: false,
          error: serializeError(error).message,
        },
        args.warnings,
      );
    }
  }

  if (segments[1] === "artifacts" && args.request.method === "POST" && segments[2] == null) {
    const payload = await parseRequestInput(args.request);
    const artifact = isRecord(payload) && "artifact" in payload ? payload.artifact : payload;
    if (
      !isRecord(artifact) ||
      typeof artifact.id !== "string" ||
      !isRecord(artifact.target) ||
      typeof artifact.target.kind !== "string" ||
      typeof artifact.target.id !== "string" ||
      typeof artifact.createdAt !== "string"
    ) {
      return badRequest('Artifact writes require a JSON artifact payload with "id", "target", and "createdAt".', args.warnings);
    }

    await artifactStore.saveArtifact(
      artifact as NonNullable<
        Awaited<ReturnType<NonNullable<RuntimeContextLike<CloudflareEnvLike>["artifactStore"]>["loadArtifact"]>>
      >,
    );

    return jsonResponse(
      200,
      {
        ok: true,
        artifactId: artifact.id,
      },
      args.warnings,
    );
  }

  if (segments[1] === "artifacts" && args.request.method === "GET" && segments[2] == null) {
    const targetKind = url.searchParams.get("targetKind");
    const targetId = url.searchParams.get("targetId");
    const limitParam = url.searchParams.get("limit");
    const limit =
      limitParam != null && Number.isFinite(Number(limitParam)) ? Number.parseInt(limitParam, 10) : undefined;
    const artifacts = await artifactStore.listArtifacts?.({
      ...(targetKind != null ? { targetKind: targetKind as "predict" | "program" | "agent" } : {}),
      ...(targetId != null ? { targetId } : {}),
      ...(limit != null ? { limit } : {}),
    });

    return jsonResponse(
      200,
      {
        ok: true,
        artifacts: artifacts ?? [],
      },
      args.warnings,
    );
  }

  if (
    segments[1] === "artifacts" &&
    segments[2] != null &&
    segments[3] == null &&
    args.request.method === "GET"
  ) {
    const artifact = await artifactStore.loadArtifact(segments[2]);
    if (artifact == null) {
      return notFound(`Artifact "${segments[2]}" was not found.`, args.warnings);
    }
    return jsonResponse(
      200,
      {
        ok: true,
        artifact,
      },
      args.warnings,
    );
  }

  if (
    segments[1] === "artifacts" &&
    segments[2] != null &&
    segments[3] != null &&
    segments[4] === "active" &&
    args.request.method === "POST"
  ) {
    const payload = await parseRequestInput(args.request);
    const artifactId = isRecord(payload) && typeof payload.artifactId === "string" ? payload.artifactId : undefined;
    if (artifactId == null) {
      return badRequest('Artifact activation requires a JSON body with "artifactId".', args.warnings);
    }
    await artifactStore.setActiveArtifact({
      targetKind: segments[2] as "predict" | "program" | "agent",
      targetId: segments[3],
      artifactId,
    });
    return jsonResponse(
      200,
      {
        ok: true,
        targetKind: segments[2],
        targetId: segments[3],
        artifactId,
      },
      args.warnings,
    );
  }

  if (
    segments[1] === "artifacts" &&
    segments[2] === "active" &&
    segments[3] != null &&
    segments[4] != null &&
    args.request.method === "GET"
  ) {
    const artifact = await artifactStore.loadActiveArtifact({
      targetKind: segments[3] as "predict" | "program" | "agent",
      targetId: segments[4],
    });
    if (artifact == null) {
      return notFound(
        `No active artifact was found for ${segments[3]} "${segments[4]}".`,
        args.warnings,
      );
    }

    return jsonResponse(
      200,
      {
        ok: true,
        artifact,
      },
      args.warnings,
    );
  }

  return notFound(`No kernel route matched "${url.pathname}".`, args.warnings);
}
