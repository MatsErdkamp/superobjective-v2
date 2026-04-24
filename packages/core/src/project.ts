import { z } from "zod";

import type {
  Agent,
  CorpusDescriptor,
  CompiledArtifact,
  ExecutionPlanTrace,
  McpSurface,
  PredictModule,
  Program,
  Project,
  RLMModule,
  RpcSurface,
  TextCandidate,
  TextParam,
  Tool,
  ToolBindingDefinition,
  ToolContext,
} from "./types.js";
import {
  buildBoundInputSchema,
  createExecutionPlan,
  resolveBoundInput,
} from "./bindings.js";
import { mergeCandidates } from "./candidate.js";
import { text } from "./schema.js";
import { signatureToInputZodSchema, signatureToOutputZodSchema } from "./schema.js";
import { chooseArtifactCandidate } from "./utils.js";

type ToolDefinition<TInput, TOutput> = {
  name: string;
  description: TextParam;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput> | TOutput;
};

type ModuleToolTarget<TInput, TOutput> =
  | PredictModule<TInput, TOutput>
  | Program<TInput, TOutput>
  | RLMModule<TInput, TOutput>
  | Tool<TInput, TOutput>;

export function tool<TInput, TOutput>(value: ToolDefinition<TInput, TOutput>): Tool<TInput, TOutput>;
export function tool<TInput extends Record<string, unknown>, TOutput>(
  value: ModuleToolTarget<TInput, TOutput>,
  binding?: ToolBindingDefinition<TInput>,
): Tool<TInput, TOutput>;
export function tool<TInput extends Record<string, unknown>, TOutput>(
  value: ToolDefinition<TInput, TOutput> | ModuleToolTarget<TInput, TOutput>,
  binding?: ToolBindingDefinition<TInput>,
): Tool<TInput, TOutput> {
  if (isModuleToolTarget<TInput, TOutput>(value)) {
    if (value.kind === "tool" && binding == null) {
      return value;
    }
    return buildModuleTool(value, binding);
  }
  return buildCustomTool(value);
}

function buildCustomTool<TInput, TOutput>(value: ToolDefinition<TInput, TOutput>): Tool<TInput, TOutput> {
  const build = (attached: {
    candidate?: TextCandidate;
    artifact?: CompiledArtifact;
  }): Tool<TInput, TOutput> => ({
    kind: "tool",
    id: value.name,
    name: value.name,
    description: value.description,
    inputSchema: value.input,
    ...(value.output ? { outputSchema: value.output } : {}),
    async execute(input, ctx) {
      return value.execute(input, ctx);
    },
    inspectExecutionPlan(): ExecutionPlanTrace {
      return {
        selected: "direct",
        explicit: true,
        reasons: ["custom tool executes directly"],
        dependencyGraph: {
          fields: Object.keys(getSchemaShape(value.input) ?? {}).map((field) => ({
            field,
            source: `arg:${field}`,
          })),
        },
      };
    },
    inspectTextCandidate() {
      return mergeCandidates(
        optimizedTextCandidate(`tool.${value.name}.description`, value.description),
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

function buildModuleTool<TInput extends Record<string, unknown>, TOutput>(
  module: ModuleToolTarget<TInput, TOutput>,
  binding: ToolBindingDefinition<TInput> | undefined,
): Tool<TInput, TOutput> {
  const build = (state: {
    module: ModuleToolTarget<TInput, TOutput>;
    binding?: ToolBindingDefinition<TInput>;
    candidate?: TextCandidate;
    artifact?: CompiledArtifact;
  }): Tool<TInput, TOutput> => {
    const baseName = getModuleName(state.module);
    const name = state.binding?.name ?? baseName;
    const description = state.binding?.description ?? getModuleDescription(state.module);
    const moduleInputSchema = getModuleInputSchema(state.module);
    const inputSchema =
      (buildBoundInputSchema(moduleInputSchema, state.binding) as z.ZodType<TInput> | undefined) ??
      moduleInputSchema;
    const outputSchema = getModuleOutputSchema(state.module);
    const publicInputSchema = inputSchema ?? ((z.object({}) as unknown) as z.ZodType<TInput>);

    const toolValue: Tool<TInput, TOutput> = {
      kind: "tool",
      id: name,
      name,
      description,
      inputSchema: publicInputSchema,
      async execute(input, ctx) {
        const plan = createExecutionPlan(moduleInputSchema, state.binding);
        if (plan.selected !== "direct") {
          throw new Error(
            `Tool "${name}" selected ${plan.selected} execution, but only direct binding resolution is available in core right now.`,
          );
        }

        const resolvedInput = await resolveBoundInput(
          input,
          moduleInputSchema,
          state.binding,
          ctx,
        );

        return executeWrappedModule(state.module, resolvedInput, ctx);
      },
      inspectExecutionPlan(): ExecutionPlanTrace {
        return createExecutionPlan(moduleInputSchema, state.binding);
      },
      inspectTextCandidate() {
        return mergeCandidates(
          state.module.inspectTextCandidate(),
          optimizedTextCandidate(`tool.${name}.description`, description),
          chooseArtifactCandidate(state.artifact),
          state.candidate,
        );
      },
      withCandidate(candidateValue) {
        return build({
          ...state,
          module: state.module.withCandidate(candidateValue) as ModuleToolTarget<TInput, TOutput>,
          candidate: mergeCandidates(state.candidate, candidateValue),
        });
      },
      withArtifact(artifactValue) {
        return build({
          ...state,
          module: state.module.withArtifact(artifactValue) as ModuleToolTarget<TInput, TOutput>,
          artifact: artifactValue,
        });
      },
    };

    if (outputSchema != null) {
      (toolValue as Tool<TInput, TOutput> & { outputSchema: z.ZodType<TOutput> }).outputSchema =
        outputSchema;
    }

    return toolValue;
  };

  return build(binding == null ? { module } : { module, binding });
}

export function corpus(value: CorpusDescriptor): CorpusDescriptor {
  return value;
}

export function agent(value: {
  name: string;
  system: TextParam;
  chat: PredictModule<any, any> | Program<any, any> | RLMModule<any, any>;
  tools?: Array<PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>>;
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
        optimizedTextCandidate(`agent.${value.name}.system`, value.system),
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
  handlers: Record<
    string,
    PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>
  >;
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
  tools: Array<PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>>;
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
  programs?: Array<PredictModule<any, any> | Program<any, any> | RLMModule<any, any>>;
  agents?: Agent[];
  rpc?: RpcSurface[];
  mcp?: McpSurface[];
  corpora?: CorpusDescriptor[];
  metadata?: Record<string, unknown>;
}): Project {
  const programs = value.programs ?? [];
  const agentsValue = value.agents ?? [];
  const rpcValue = value.rpc ?? [];
  const mcpValue = value.mcp ?? [];
  const corporaValue = value.corpora ?? [];

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
  assertUniqueNames(
    corporaValue.map((entry) => entry.id),
    "project corpora",
  );

  return {
    kind: "project",
    programs,
    agents: agentsValue,
    rpc: rpcValue,
    mcp: mcpValue,
    corpora: corporaValue,
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

function isModuleToolTarget<TInput, TOutput>(
  value: ToolDefinition<TInput, TOutput> | ModuleToolTarget<TInput, TOutput>,
): value is ModuleToolTarget<TInput, TOutput> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    "kind" in value &&
    (value.kind === "predict" ||
      value.kind === "program" ||
      value.kind === "tool" ||
      value.kind === "rlm")
  );
}

function getSchemaShape(schema: z.ZodTypeAny | undefined): Record<string, z.ZodTypeAny> | null {
  if (schema == null) {
    return null;
  }

  const candidate = schema as z.ZodTypeAny & {
    shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
    _def?: {
      shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
    };
  };

  const directShape = candidate.shape;
  if (typeof directShape === "function") {
    return directShape();
  }
  if (directShape != null && typeof directShape === "object") {
    return directShape;
  }

  const nestedShape = candidate._def?.shape;
  if (typeof nestedShape === "function") {
    return nestedShape();
  }
  if (nestedShape != null && typeof nestedShape === "object") {
    return nestedShape;
  }

  return null;
}

function getModuleName<TInput, TOutput>(value: ModuleToolTarget<TInput, TOutput>): string {
  if (value.kind === "predict" || value.kind === "rlm") {
    return value.signature.name;
  }
  return value.kind === "program" ? value.id : value.name;
}

function getModuleDescription<TInput, TOutput>(value: ModuleToolTarget<TInput, TOutput>): TextParam {
  if (value.kind === "predict" || value.kind === "rlm") {
    return value.signature.instructions;
  }
  if (value.kind === "tool") {
    return value.description;
  }
  return text({
    value: `Run the program "${value.id}".`,
  });
}

function getModuleInputSchema<TInput, TOutput>(
  value: ModuleToolTarget<TInput, TOutput>,
): z.ZodType<TInput> | undefined {
  if (value.kind === "predict" || value.kind === "rlm") {
    return signatureToInputZodSchema({
      signature: value.signature,
    }) as z.ZodType<TInput>;
  }
  return value.inputSchema;
}

function getModuleOutputSchema<TInput, TOutput>(
  value: ModuleToolTarget<TInput, TOutput>,
): z.ZodType<TOutput> | undefined {
  if (value.kind === "predict" || value.kind === "rlm") {
    return signatureToOutputZodSchema({
      signature: value.signature,
    }) as z.ZodType<TOutput>;
  }
  return value.outputSchema;
}

async function executeWrappedModule<TInput, TOutput>(
  value: ModuleToolTarget<TInput, TOutput>,
  input: TInput,
  ctx: ToolContext,
): Promise<TOutput> {
  if (value.kind === "tool") {
    return value.execute(input, ctx);
  }

  return value(input, {
    runtime: ctx.runtime,
  });
}

function inspectToolLikeName(
  value: PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>,
): string {
  if (value.kind === "predict" || value.kind === "rlm") {
    return value.signature.name;
  }
  return value.kind === "program" ? value.id : value.name;
}

function inspectToolLikeCandidate(
  value: PredictModule<any, any> | Program<any, any> | Tool<any, any> | RLMModule<any, any>,
): TextCandidate {
  return value.inspectTextCandidate();
}

function optimizedTextCandidate(path: string, value: TextParam): TextCandidate {
  return value.optimize ? { [path]: value.value } : {};
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
