import type { z } from "zod";

import type {
  Agent,
  CompiledArtifact,
  McpSurface,
  PredictModule,
  Program,
  Project,
  RpcSurface,
  TextCandidate,
  TextParam,
  Tool,
  ToolContext,
} from "./types.js";
import { text } from "./schema.js";
import { chooseArtifactCandidate, mergeCandidates } from "./utils.js";

type ToolDefinition<TInput, TOutput> = {
  name: string;
  description: TextParam;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput> | TOutput;
};

export function tool<TInput, TOutput>(
  value: ToolDefinition<TInput, TOutput>,
): Tool<TInput, TOutput> {
  const build = (attached: {
    candidate?: TextCandidate;
    artifact?: CompiledArtifact;
  }): Tool<TInput, TOutput> => ({
    kind: "tool",
    name: value.name,
    description: value.description,
    inputSchema: value.input,
    ...(value.output ? { outputSchema: value.output } : {}),
    async execute(input, ctx) {
      return value.execute(input, ctx);
    },
    inspectTextCandidate() {
      return mergeCandidates(
        { [`tool.${value.name}.description`]: value.description.value },
        chooseArtifactCandidate(attached.artifact),
        attached.candidate,
      );
    },
    withCandidate(candidate) {
      return build({
        ...attached,
        candidate: mergeCandidates(attached.candidate, candidate),
      });
    },
    withArtifact(artifact) {
      return build({
        ...attached,
        artifact,
      });
    },
  });

  return build({});
}

export function agent(value: {
  name: string;
  system: TextParam;
  chat: PredictModule<any, any> | Program<any, any>;
  tools?: Array<PredictModule<any, any> | Tool<any, any>>;
  metadata?: Record<string, unknown>;
}): Agent {
  const build = (attached: { candidate?: TextCandidate; artifact?: CompiledArtifact }): Agent => ({
    kind: "agent",
    name: value.name,
    system: value.system,
    chat: value.chat,
    tools: value.tools ?? [],
    ...(value.metadata ? { metadata: value.metadata } : {}),
    inspectTextCandidate() {
      return mergeCandidates(
        { [`agent.${value.name}.system`]: value.system.value },
        value.chat.inspectTextCandidate(),
        ...(value.tools ?? []).map((entry) => inspectToolLikeCandidate(entry)),
        chooseArtifactCandidate(attached.artifact),
        attached.candidate,
      );
    },
    withCandidate(candidateValue) {
      return build({
        ...attached,
        candidate: mergeCandidates(attached.candidate, candidateValue),
      });
    },
    withArtifact(artifactValue) {
      return build({
        ...attached,
        artifact: artifactValue,
      });
    },
  });

  return build({});
}

export function rpc(value: {
  name: string;
  handlers: Record<string, PredictModule<any, any> | Program<any, any>>;
  metadata?: Record<string, unknown>;
}): RpcSurface {
  const handlerNames = Object.keys(value.handlers);
  const unique = new Set(handlerNames);
  if (handlerNames.length !== unique.size) {
    throw new Error(`RPC surface "${value.name}" contains duplicate handlers.`);
  }

  return {
    kind: "rpc",
    name: value.name,
    handlers: value.handlers,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

export function mcp(value: {
  name: string;
  tools: Array<PredictModule<any, any> | Tool<any, any>>;
  metadata?: Record<string, unknown>;
}): McpSurface {
  const toolNames = value.tools.map((entry) => inspectToolLikeName(entry));
  assertUniqueNames(toolNames, `MCP surface "${value.name}"`);

  return {
    kind: "mcp",
    name: value.name,
    tools: value.tools,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

export function project(value: {
  programs?: Array<PredictModule<any, any> | Program<any, any>>;
  agents?: Agent[];
  rpc?: RpcSurface[];
  mcp?: McpSurface[];
  metadata?: Record<string, unknown>;
}): Project {
  const programs = value.programs ?? [];
  const agentsValue = value.agents ?? [];
  const rpcValue = value.rpc ?? [];
  const mcpValue = value.mcp ?? [];

  assertUniqueNames(
    programs.map((entry) => entry.id),
    "project programs",
  );
  assertUniqueNames(
    agentsValue.map((entry) => entry.name),
    "project agents",
  );
  assertUniqueNames(
    rpcValue.map((entry) => entry.name),
    "project rpc surfaces",
  );
  assertUniqueNames(
    mcpValue.map((entry) => entry.name),
    "project mcp surfaces",
  );

  return {
    kind: "project",
    programs,
    agents: agentsValue,
    rpc: rpcValue,
    mcp: mcpValue,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

function inspectToolLikeName(value: PredictModule<any, any> | Tool<any, any>): string {
  return value.kind === "predict" ? value.signature.name : value.name;
}

function inspectToolLikeCandidate(value: PredictModule<any, any> | Tool<any, any>): TextCandidate {
  return value.inspectTextCandidate();
}

function assertUniqueNames(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate name "${value}" in ${label}.`);
    }
    seen.add(value);
  }
}

export const surfaces = {
  tool,
  agent,
  rpc,
  mcp,
  project,
  text,
};
