# Superobjective v0.1 — Expansive Implementation Spec

## 0. Executive summary

**Superobjective is a TypeScript-first DSPy-like programming layer for LLM systems.**

It should let developers write explicit, typed, optimizable LLM programs:

```ts
const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
});
```

Then compile those programs with **GEPA**:

```ts
const compiled = await so.compile(triageTicket, {
  optimizer: so.optimizers.gepa(),
  trainset,
  valset,
  metric: triageQuality,
  objective: "Improve support ticket triage accuracy.",
});
```

Then host them anywhere, with **Cloudflare as the first production target**:

```ts
export default createCloudflareWorker({
  project,
  runtime: {
    model: cloudflare.workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  },
});
```

The core architecture is:

```txt
Signature
  defines typed behavior and optimizable descriptions

Adapter
  renders signature semantics into model messages
  derives AI SDK structured output schema from the signature

AI SDK
  enforces structure and validates output

PredictModule / Program
  executes typed LLM calls and normal TypeScript control flow

Metric
  returns score + feedback + logs/traces

GEPA
  optimizes adapter-visible text parameters

CompiledArtifact
  stores optimized text candidate dictionary

Cloudflare plugin
  hosts explicit project graph using stable Agent/Think/MCP host classes
```

The important update from earlier drafts is:

> **Superobjective should use AI SDK structured output schemas for output enforcement.**
> The XML adapter remains valuable, but primarily as the semantic prompt renderer and optimization surface, not as the only parser.

AI SDK’s current structured-output API standardizes schema-constrained object generation across providers using `output` on `generateText` / `streamText`, and supports Zod, Valibot, or JSON schemas for the requested shape. The docs also state that the schema is used to validate generated data. ([AI SDK][1])

---

# 1. Design goals

## 1.1 What Superobjective is

Superobjective is:

```txt
a TypeScript-first declarative LLM programming library
a DSPy-inspired signature/module/program system
a compiler target for GEPA optimization
an adapter framework for prompt/schema generation
a runtime trace/eval system
a Cloudflare-hostable project graph
```

## 1.2 What Superobjective is not

Superobjective core is **not**:

```txt
a prompt-template string library
a hidden global registry
a file-glob auto-loader
a mandatory dev server
a Cloudflare-only agent framework
a wrapper around Wrangler
a runtime that generates Cloudflare subclasses per logical agent
a schema-only structured output helper
```

## 1.3 DSPy alignment

DSPy’s conceptual model is the closest reference. DSPy signatures are declarative specifications of input/output behavior, and its docs emphasize that field names carry semantic roles rather than being arbitrary variable names. ([DSPy][2])

Superobjective should preserve that idea, but translate it into explicit TypeScript values:

```txt
DSPy Signature       → Superobjective Signature
DSPy InputField      → so.input(...)
DSPy OutputField     → so.output(...)
DSPy Adapter         → Adapter
DSPy Predict         → PredictModule
DSPy Program         → Program
DSPy Example         → Example
DSPy Metric          → Metric
DSPy GEPA optimizer  → @superobjective/optimizer-gepa
```

## 1.4 Main departure from DSPy

Superobjective intentionally differs from DSPy in these ways:

```txt
TypeScript-first, not Python-first
Zod-first field schemas
AI SDK structured output as the enforcement layer
Cloudflare-native hosting plugin
GEPA-only MVP optimizer
explicit project graph, no global implicit registry
```

---

# 2. Non-negotiable invariants

## 2.1 Signature is the source of truth

The source of truth is:

```txt
Signature
  instructions
  input fields
  output fields
  field schemas
  field descriptions
```

Not:

```txt
plain Zod object
AI SDK schema
JSON Schema
Cloudflare tool schema
MCP tool schema
prompt template
```

Everything else is derived from the signature.

```txt
Signature
  → adapter-visible prompt text
  → AI SDK structured output schema
  → tool input schema
  → MCP schema
  → docs / prompt inspection
  → GEPA text candidate
```

## 2.2 Schema enforces structure; descriptions carry meaning

The implementation must keep this separation:

```txt
Zod schema
  validates shape and values

TextParam descriptions
  explain semantic meaning
  are visible in prompts and schemas
  may be optimized by GEPA
```

GEPA can rewrite:

```txt
instructions
input field descriptions
output field descriptions
tool descriptions
agent/system descriptions
```

GEPA cannot rewrite:

```txt
field keys
schema types
enum values
required/optional status
program control flow
tool allowlists
model choice
Cloudflare config
```

## 2.3 `predict()` is pure

`predict()` returns a module value.

It must not:

```txt
register globally
mutate a singleton project
generate files
create Cloudflare routes
create Durable Object classes
expose tools
infer MCP/RPC placement
```

Correct:

```ts
export const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
});
```

Incorrect:

```ts
so.predict(TriageTicket); // relying on side-effect registration
```

## 2.4 No side-effect imports for user programs

Do not require:

```ts
import "./support.zupa";
import "./billing.zupa";
```

Instead:

```ts
import { triageTicket } from "./triage";
import { supportFlow } from "./support-flow";

export const project = so.project({
  programs: [triageTicket, supportFlow],
});
```

Explicit composition is the default. Tooling can add file discovery later, but core must not rely on it.

## 2.5 Cloudflare must not leak into `predict()`

Do not support this:

```ts
so.predict(TriageTicket, {
  cloudflare: {
    expose: ["think.tool", "agent.rpc", "mcp.tool"],
  },
});
```

Surface placement belongs to the explicit project graph:

```ts
so.agent({
  name: "support",
  chat: supportFlow,
  tools: [triageTicket],
});

so.rpc({
  name: "support_rpc",
  handlers: { triageTicket },
});

so.mcp({
  name: "support_tools",
  tools: [triageTicket],
});
```

## 2.6 No mandatory Superobjective dev server

Core usage should work as ordinary TypeScript:

```bash
tsx scripts/compile-triage.ts
tsx scripts/run-eval.ts
```

Cloudflare usage should work through Wrangler:

```bash
wrangler dev
wrangler deploy
```

A later `superobjective dev` command may exist as convenience, but must not be required.

## 2.7 GEPA-only optimizer in v0.1

The only optimizer in MVP is:

```txt
GEPA over text parameters
```

Do not implement:

```txt
MIPRO
bootstrap few-shot
demo selection
model routing optimization
schema mutation
tool-policy optimization
program-architecture mutation
```

GEPA’s newer `optimize_anything` framing is a good fit because it optimizes artifacts representable as text, and the user declares both what to optimize and how to measure it. ([gepa-ai.github.io][3])

## 2.8 ASI is simple

For v0.1, “Actionable Side Information” should mean:

```txt
feedback
ctx.log(...) output
stdout
stderr
run traces
component traces
adapter prompts
tool traces
validation failures
retrieval traces
human notes
judge notes
```

Do not build a large ASI ontology.

GEPA’s own framing says ASI can include error messages, profiling data, reasoning logs, and other diagnostic feedback that helps an LLM diagnose failures and propose targeted fixes. ([gepa-ai.github.io][4])

---

# 3. Naming and package conventions

## 3.1 Package names

Use the brand in package names:

```txt
superobjective
@superobjective/cloudflare
@superobjective/optimizer-gepa
```

## 3.2 Runtime namespace

Core package exports both:

```ts
import { so } from "superobjective";
```

and:

```ts
import { superobjective } from "superobjective";
```

Examples should prefer:

```ts
so;
```

because it keeps code readable.

## 3.3 Type names

Do not prefix core types with `Superobjective`.

Use:

```txt
TextParam
Field
Signature
Adapter
PredictModule
Program
Example
Metric
Score
RunTrace
ComponentTrace
ModelCallTrace
ToolCallTrace
TextCandidate
CompiledArtifact
Project
```

Do not use:

```txt
SuperobjectiveText
SuperobjectiveField
SuperobjectiveSignature
SuperobjectiveRunTrace
SuperobjectiveCompiledArtifact
```

The package import path already names the system.

## 3.4 Cloudflare host class names

Inside `@superobjective/cloudflare/hosts`, export:

```ts
import { AgentHost, ThinkHost, McpHost } from "@superobjective/cloudflare/hosts";
```

No prefix needed because the module path is already specific.

---

# 4. Core domain model

## 4.1 `TextParam`

Optimizable text must be explicit.

```ts
export type TextParam = {
  value: string;
  optimize?: boolean;
  id?: string;
  metadata?: Record<string, unknown>;
};
```

API:

```ts
so.text("Classify a support ticket.");
```

```ts
so.text({
  value: "Classify a support ticket for human routing.",
  optimize: true,
});
```

Rules:

```txt
optimize: true
  GEPA may mutate this text.

optimize: false or omitted
  GEPA must preserve this text.
```

Default:

```ts
optimize: false;
```

Rationale: not all text should be optimizer-owned. Security policies, legal disclaimers, and hard product constraints may be fixed.

---

## 4.2 `Field`

Raw Zod is not enough. A field combines a validation schema with semantic text.

```ts
export type Field<T> = {
  kind: "input" | "output";
  schema: z.ZodType<T>;
  description: TextParam;
  optional?: boolean;
  default?: T;
  examples?: T[];
  metadata?: Record<string, unknown>;
};
```

Input helper:

```ts
so.input(z.string(), {
  description: so.text({
    value: "The ticket subject line, usually a terse user-written summary.",
    optimize: true,
  }),
});
```

Output helper:

```ts
so.output(z.enum(["billing", "technical", "account", "other"]), {
  description: so.text({
    value: "The primary support queue that should handle the request.",
    optimize: true,
  }),
});
```

Rules:

```txt
field key
  stable identifier, not optimized

schema
  validation and type contract, not optimized

description
  semantic explanation, adapter-visible, optionally optimized
```

---

## 4.3 `Signature`

A signature declares typed LLM behavior.

```ts
export type Signature<
  TInput extends Record<string, Field<any>>,
  TOutput extends Record<string, Field<any>>,
> = {
  kind: "signature";
  name: string;
  instructions: TextParam;
  input: TInput;
  output: TOutput;
  metadata?: Record<string, unknown>;
};
```

Example:

```ts
import { z } from "zod";
import { so } from "superobjective";

export const TriageTicket = so
  .signature("triage_ticket")
  .withInstructions("Classify a support ticket for human routing.", {
    optimize: true,
  })
  .withInput("subject", z.string(), {
    description: "The ticket subject line, usually a terse user-written summary.",
    optimize: true,
  })
  .withInput("body", z.string(), {
    description:
      "The full user-written ticket body, including symptoms, account context, and desired resolution.",
    optimize: true,
  })
  .withOutput("category", z.enum(["billing", "technical", "account", "other"]), {
    description: "The primary support queue that should handle the request.",
    optimize: true,
  })
  .withOutput("priority", z.enum(["low", "medium", "high"]), {
    description: "Urgency based on user impact, business risk, and time sensitivity.",
    optimize: true,
  })
  .withOutput("needsHuman", z.boolean(), {
    description: "Whether the issue should be escalated to a human support agent.",
    optimize: true,
  })
  .build();
```

Type inference goals:

```ts
type TriageInput = InferInput<typeof TriageTicket>;
// {
//   subject: string;
//   body: string;
// }

type TriageOutput = InferOutput<typeof TriageTicket>;
// {
//   category: "billing" | "technical" | "account" | "other";
//   priority: "low" | "medium" | "high";
//   needsHuman: boolean;
// }
```

---

# 5. Adapter layer

## 5.1 Purpose

Adapters bridge:

```txt
Signature + TextCandidate + Examples + Input
  → model messages
  → AI SDK structured output schema
  → optional fallback parser
```

The adapter is not only a prompt template. It is the component that decides how signature semantics become a model call.

DSPy’s adapter docs describe the adapter system as responsible for translating signatures into system messages, formatting input data, parsing LM responses back into structured outputs, managing conversation history and function calls, and converting DSPy types into prompt messages. ([DSPy][5])

## 5.2 Important update: adapters emit AI SDK structured output config

Adapters must now return both:

```txt
messages
structured output config
```

The model call should be schema-enforced through AI SDK whenever available.

```ts
export type AdapterOutput = {
  messages: ModelMessage[];

  output: {
    /**
     * Prefer a Zod schema when using AI SDK directly.
     * Also store JSON Schema form for tracing, MCP, docs, and provider adapters.
     */
    zodSchema: z.ZodTypeAny;
    jsonSchema: JsonSchema;

    name?: string;
    description?: string;
    strict?: boolean;
  };

  /**
   * Fallback instructions if the provider cannot do structured output.
   */
  fallback?: {
    mode: "xml-tags" | "json-text";
    parse: (rawText: string) => Promise<unknown>;
  };
};
```

## 5.3 Adapter interface

```ts
export type Adapter = {
  id: string;
  version: string;

  format(args: {
    signature: Signature<any, any>;
    candidate: TextCandidate;
    input: unknown;
    examples?: Example<any, any>[];
    history?: ModelMessage[];
    mode?: "structured" | "text-fallback";
  }): Promise<AdapterOutput>;

  /**
   * Main structured path should receive object output from AI SDK.
   * Text parsing is only fallback.
   */
  parseStructured?(args: { signature: Signature<any, any>; value: unknown }): Promise<unknown>;

  parseTextFallback?(args: { signature: Signature<any, any>; rawText: string }): Promise<unknown>;

  formatFailureAsFeedback?(error: unknown): string;
};
```

## 5.4 XML adapter should be first

The default v0.1 adapter should be:

```ts
so.adapters.xml();
```

Reason: XML makes instructions, field names, field descriptions, and structure legible to both developers and GEPA. DSPy’s XMLAdapter requires fields to be wrapped in XML tags, formats field descriptions, field structure, and task description into the system message, and instructs the user message to respond with output fields wrapped in XML tags. ([DSPy][6])

But in Superobjective, XML does **not** mean “we only parse XML.” The preferred execution path is:

```txt
XML semantic prompt
+
AI SDK structured output schema
```

So the XML adapter renders semantics like this:

```xml
<task>
Classify a support ticket for human routing.
</task>

<input_fields>
  <field name="subject" type="string">
    The ticket subject line, usually a terse user-written summary.
  </field>

  <field name="body" type="string">
    The full user-written ticket body, including symptoms, account context,
    and desired resolution.
  </field>
</input_fields>

<output_fields>
  <field name="category" type="billing | technical | account | other">
    The primary support queue that should handle the request.
  </field>

  <field name="priority" type="low | medium | high">
    Urgency based on user impact, business risk, and time sensitivity.
  </field>

  <field name="needsHuman" type="boolean">
    Whether the issue should be escalated to a human support agent.
  </field>
</output_fields>

<input>
  <subject>Refund not received</subject>
  <body>I returned my order two weeks ago and still have not received the refund.</body>
</input>
```

And separately derives this output schema:

```ts
z.object({
  category: z
    .enum(["billing", "technical", "account", "other"])
    .describe("The primary support queue that should handle the request."),

  priority: z
    .enum(["low", "medium", "high"])
    .describe("Urgency based on user impact, business risk, and time sensitivity."),

  needsHuman: z
    .boolean()
    .describe("Whether the issue should be escalated to a human support agent."),
});
```

## 5.5 Structured-output bridge

Do not hardwire core to a single AI SDK major-version call shape. AI SDK’s current docs show structured output via `generateText({ output: Output.object({ schema }) })`, while older or alternate examples may use `generateObject`. Superobjective should hide this behind a provider bridge.

```ts
export type StructuredGenerationBridge = {
  id: string;

  generateObject<T>(args: {
    model: ModelHandle;
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
    strict?: boolean;
    tools?: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): Promise<{
    object: T;
    rawResponse?: unknown;
    usage?: TokenUsage;
    finishReason?: string;
  }>;
};
```

AI SDK bridge implementation concept:

```ts
import { generateText, Output } from "ai";

const result = await generateText({
  model,
  messages,
  output: Output.object({
    schema,
  }),
});

return {
  object: result.output,
  rawResponse: result.response,
  usage: result.usage,
};
```

The exact implementation should track the installed AI SDK version, but the Superobjective runtime API should remain stable. AI SDK’s current docs say structured output uses schemas to generate conforming typed data and validates generated data for type safety and correctness. ([AI SDK][1])

## 5.6 Adapter types for v0.1

Implement these adapters:

```txt
xml
  default
  semantic prompt rendered as XML sections
  AI SDK schema still enforces output

json
  semantic prompt rendered in JSON-ish instructions
  AI SDK schema enforces output

nativeStructured
  minimal prompt
  leans heavily on AI SDK schema descriptions
  useful for production once XML semantics are validated
```

Do **not** build too many adapters in v0.1. XML + structured schema is enough for the first usable system.

---

# 6. Schema derivation

## 6.1 Signature-to-output-Zod

Given:

```ts
signature.output;
```

derive:

```ts
z.object({
  [fieldName]: field.schema.describe(resolveDescription(field.description)),
});
```

Where:

```ts
resolveDescription(field.description, candidate);
```

uses optimized text if a compiled candidate has a value for that field path.

## 6.2 Signature-to-JSON-Schema

Also derive JSON Schema for:

```txt
trace inspection
MCP tools
OpenAPI/RPC docs
Cloudflare tool conversion
debugging
provider bridges that prefer JSON Schema
```

```ts
export function signatureToOutputJsonSchema(args: {
  signature: Signature<any, any>;
  candidate?: TextCandidate;
}): JsonSchema;
```

## 6.3 Input schema derivation

Input schema is needed for:

```txt
input validation
tool parameters
RPC handlers
MCP tools
Think tool conversion
```

```ts
export function signatureToInputZodSchema(signature): z.ZodObject<any>;
export function signatureToInputJsonSchema(signature): JsonSchema;
```

Input field descriptions should be applied to input schema fields as `.describe(...)` too. This matters when converting `PredictModule` to a tool.

## 6.4 Output schema derivation

Output schema is needed for:

```txt
AI SDK structured output
output validation
trace schema snapshots
artifact reproducibility
```

Output field descriptions should be included in the schema because providers may use schema descriptions as part of structured output generation.

## 6.5 Candidate-aware schema generation

The schema generator must be candidate-aware:

```ts
const schema = signatureToOutputZodSchema({
  signature,
  candidate,
});
```

This matters because GEPA may change:

```txt
triage_ticket.output.category.description
```

and the AI SDK output schema should receive the optimized description, not the seed description.

---

# 7. Predict modules

## 7.1 Type

```ts
export type PredictModule<TInput, TOutput> = {
  kind: "predict";
  id: string;
  signature: Signature<any, any>;
  adapter: Adapter;

  (input: TInput, options?: RunOptions): Promise<TOutput>;

  inspectTextCandidate(): TextCandidate;
  inspectPrompt(input: TInput, options?: InspectOptions): Promise<AdapterOutput>;

  withCandidate(candidate: TextCandidate): PredictModule<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): PredictModule<TInput, TOutput>;
};
```

## 7.2 Construction

```ts
export const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
  model: "default",
});
```

## 7.3 Execution pipeline

The runtime for a `PredictModule` should do:

```txt
1. Start RunTrace / ComponentTrace.
2. Validate input with signature input schema.
3. Resolve active candidate:
   a. explicit run option candidate
   b. module-attached candidate
   c. active artifact from artifact store
   d. seed candidate from signature
4. Adapter formats:
   a. model messages
   b. AI SDK output schema
   c. fallback parser
5. Call StructuredGenerationBridge.
6. Validate returned object with output schema.
7. Record model call trace.
8. Record component trace, including adapter-rendered prompt.
9. Store trace if trace store configured.
10. Return typed output.
```

## 7.4 Example

```ts
const result = await triageTicket({
  subject: "Refund not received",
  body: "I returned my item two weeks ago and still have not received the refund.",
});
```

Return type:

```ts
{
  category: "billing" | "technical" | "account" | "other";
  priority: "low" | "medium" | "high";
  needsHuman: boolean;
}
```

## 7.5 Prompt inspection

`inspectPrompt` is mandatory.

```ts
const prompt = await triageTicket.inspectPrompt({
  subject: "Refund not received",
  body: "I returned my item two weeks ago...",
});
```

It must return:

```txt
messages
output Zod schema summary
output JSON Schema
candidate used
adapter id/version
```

This is essential because GEPA mutates field descriptions. Developers need to see the actual prompt/schema produced by a compiled artifact.

---

# 8. Programs

## 8.1 Purpose

A program composes modules using normal TypeScript.

```ts
export const supportFlow = so.program({
  name: "support_flow",

  input: z.object({
    subject: z.string(),
    body: z.string(),
  }),

  output: z.object({
    response: z.string(),
    escalated: z.boolean(),
  }),

  async run(ctx, input) {
    const triage = await ctx.call(triageTicket, input);

    if (triage.needsHuman) {
      return ctx.call(escalateToHuman, {
        ...input,
        triage,
      });
    }

    return ctx.call(draftAutoReply, {
      ...input,
      triage,
    });
  },
});
```

## 8.2 Type

```ts
export type Program<TInput, TOutput> = {
  kind: "program";
  id: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;

  (input: TInput, options?: RunOptions): Promise<TOutput>;

  run(ctx: ProgramContext, input: TInput): Promise<TOutput>;

  inspectTextCandidate(): TextCandidate;
  withCandidate(candidate: TextCandidate): Program<TInput, TOutput>;
  withArtifact(artifact: CompiledArtifact): Program<TInput, TOutput>;
};
```

## 8.3 Program context

```ts
export type ProgramContext = {
  call<TInput, TOutput>(
    module: PredictModule<TInput, TOutput> | Program<TInput, TOutput>,
    input: TInput,
    options?: RunOptions,
  ): Promise<TOutput>;

  log(message: string): void;

  trace: RunTrace;

  runtime: RuntimeContext;
};
```

## 8.4 Program optimization

GEPA v0.1 may optimize text parameters contained in a program’s component modules.

It should not mutate:

```txt
program control flow
if statements
loop structure
tool selection logic
function code
```

Later versions may support optimizing code or agent architecture, but not v0.1.

---

# 9. Examples

## 9.1 Example type

```ts
export type Example<TInput, TExpected> = {
  id?: string;
  input: TInput;
  expected: TExpected;
  metadata?: Record<string, unknown>;
};
```

## 9.2 Signature examples

```ts
export const trainset = so.examples(TriageTicket, [
  {
    input: {
      subject: "Refund not received",
      body: "I returned my item two weeks ago and still have not received the refund.",
    },
    expected: {
      category: "billing",
      priority: "medium",
      needsHuman: false,
    },
  },
]);
```

## 9.3 Program examples

```ts
export const supportExamples = so.examples(supportFlow, [
  {
    input: {
      subject: "Cannot log in",
      body: "Password reset emails are not arriving.",
    },
    expected: {
      escalated: false,
    },
  },
]);
```

## 9.4 Example validation

`so.examples(target, examples)` should validate:

```txt
input conforms to target input schema
expected conforms to target output/expected schema where possible
example ids unique if supplied
```

## 9.5 Train/val/test split

Provide utility:

```ts
const { trainset, valset, testset } = so.splitExamples(examples, {
  train: 0.7,
  val: 0.2,
  test: 0.1,
  seed: 42,
});
```

Keep deterministic.

---

# 10. Metrics and feedback

## 10.1 Metric type

```ts
export type Metric<TInput, TPrediction, TExpected> = {
  name: string;

  evaluate(ctx: MetricContext<TInput, TPrediction, TExpected>): Promise<Score> | Score;
};
```

## 10.2 Metric context

```ts
export type MetricContext<TInput, TPrediction, TExpected> = {
  example: Example<TInput, TExpected>;
  prediction: TPrediction;
  expected: TExpected;

  trace: RunTrace;

  /**
   * Used by GEPA for component-scoped feedback.
   */
  target?: {
    componentId: string;
    trace: ComponentTrace;
  };

  log(message: string): void;
};
```

## 10.3 Score type

```ts
export type Score = {
  score: number;

  /**
   * Natural-language explanation for GEPA.
   */
  feedback?: string;

  /**
   * ASI-like diagnostic logs.
   */
  logs?: string[];
  stdout?: string;
  stderr?: string;

  /**
   * Optional explicit trace override. Usually ctx.trace is enough.
   */
  trace?: RunTrace;

  /**
   * Escape hatch for images, tables, retrieval dumps, etc.
   */
  attachments?: Array<{
    name: string;
    mediaType: string;
    data: unknown;
  }>;

  metadata?: Record<string, unknown>;
};
```

## 10.4 Example metric

```ts
export const triageQuality = so.metric({
  name: "triage_quality",

  async evaluate(ctx) {
    const prediction = ctx.prediction;
    const expected = ctx.expected;

    let score = 1;
    const failures: string[] = [];

    if (prediction.category !== expected.category) {
      score -= 0.5;
      failures.push(`Wrong category: expected ${expected.category}, got ${prediction.category}.`);
    }

    if (prediction.priority !== expected.priority) {
      score -= 0.25;
      failures.push(`Wrong priority: expected ${expected.priority}, got ${prediction.priority}.`);
    }

    if (prediction.needsHuman !== expected.needsHuman) {
      score -= 0.25;
      failures.push(
        `Wrong escalation: expected ${expected.needsHuman}, got ${prediction.needsHuman}.`,
      );
    }

    for (const failure of failures) {
      ctx.log(failure);
    }

    if (ctx.target) {
      ctx.log(`Target component: ${ctx.target.componentId}`);
      ctx.log(`Component prompt:\n${ctx.target.trace.prompt?.messages ?? ""}`);
    }

    return {
      score: Math.max(0, score),

      feedback:
        failures.length === 0
          ? "Correct."
          : `
The triage output had these problems:
${failures.map((failure) => `- ${failure}`).join("\n")}

Improve the field descriptions so the model uses the user's desired resolution
and concrete business impact, not only surface-level keywords.
          `,
    };
  },
});
```

## 10.5 Metric design rules

Metrics should:

```txt
return scalar score
include useful natural-language feedback on failures
use ctx.log(...) for diagnostic details
avoid overfitting suggestions to a single example
be deterministic where possible
support component-scoped evaluation when helpful
```

---

# 11. Trace model

## 11.1 `RunTrace`

Every run should produce a trace.

```ts
export type RunTrace = {
  runId: string;
  targetId: string;
  targetKind: "predict" | "program" | "agent" | "rpc" | "mcp";

  startedAt: string;
  endedAt?: string;

  input: unknown;
  output?: unknown;
  error?: SerializedError;

  stdout: string;
  stderr?: string;

  components: ComponentTrace[];
  modelCalls: ModelCallTrace[];
  toolCalls: ToolCallTrace[];

  metadata?: Record<string, unknown>;
};
```

## 11.2 `ComponentTrace`

```ts
export type ComponentTrace = {
  componentId: string;
  componentKind: "predict" | "program" | "adapter" | "tool" | "rpc" | "mcp";

  startedAt: string;
  endedAt?: string;

  input: unknown;
  output?: unknown;
  error?: SerializedError;

  candidate?: {
    paths: string[];
    hash: string;
  };

  prompt?: {
    adapterId: string;
    adapterVersion: string;
    messages: ModelMessage[];
    outputJsonSchema?: JsonSchema;
  };

  stdout: string;
  stderr?: string;

  metadata?: Record<string, unknown>;
};
```

## 11.3 `ModelCallTrace`

```ts
export type ModelCallTrace = {
  provider: string;
  model: string;

  messages: ModelMessage[];
  outputJsonSchema?: JsonSchema;

  rawResponse?: unknown;

  latencyMs?: number;

  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };

  finishReason?: string;
};
```

## 11.4 `ToolCallTrace`

```ts
export type ToolCallTrace = {
  toolName: string;

  input: unknown;
  output?: unknown;
  error?: SerializedError;

  latencyMs?: number;

  metadata?: Record<string, unknown>;
};
```

## 11.5 Trace requirements for GEPA

GEPA must be able to access:

```txt
whole-run trace
component trace
adapter-rendered messages
candidate paths used
structured output schema
parse/validation failures
metric logs
tool traces
stdout/stderr
```

## 11.6 Privacy hooks

Even in v0.1, add hooks:

```ts
type TraceRedactor = {
  redactTrace(trace: RunTrace): RunTrace;
};
```

Runtime config:

```ts
so.configure({
  trace: {
    redact: so.redactors.standardPII(),
    sampleRate: 1.0,
  },
});
```

Minimum redaction targets:

```txt
email addresses
phone numbers
API keys
bearer tokens
credit card-like numbers
```

---

# 12. GEPA optimizer

## 12.1 Conceptual model

GEPA should optimize the **text candidate** extracted from a target module/program.

GEPA should consume:

```txt
score
feedback
logs
stdout
run traces
component traces
adapter prompts
validation failures
```

GEPA’s paper describes examining execution traces, identifying a target module’s inputs/outputs/reasoning, and using an LLM to reflectively propose prompt improvements for the target module. ([arxiv.org][7])

## 12.2 Candidate format

```ts
export type TextCandidate = Record<string, string>;
```

Example:

```ts
const seedCandidate: TextCandidate = {
  "triage_ticket.instructions": "Classify a support ticket for human routing.",

  "triage_ticket.input.subject.description":
    "The ticket subject line, usually a terse user-written summary.",

  "triage_ticket.input.body.description":
    "The full user-written ticket body, including symptoms, account context, and desired resolution.",

  "triage_ticket.output.category.description":
    "The primary support queue that should handle the request.",

  "triage_ticket.output.priority.description":
    "Urgency based on user impact, business risk, and time sensitivity.",

  "triage_ticket.output.needsHuman.description":
    "Whether the issue should be escalated to a human support agent.",
};
```

## 12.3 Text path naming

Use stable paths:

```txt
{signatureName}.instructions
{signatureName}.input.{fieldName}.description
{signatureName}.output.{fieldName}.description
tool.{toolName}.description
agent.{agentName}.system
```

Rules:

```txt
path must be deterministic
path must not depend on file path
path must survive refactors when signature/tool/agent names stay stable
```

## 12.4 Compile API

```ts
const compiled = await so.compile(triageTicket, {
  optimizer: so.optimizers.gepa({
    maxMetricCalls: 120,
    reflectionBatchSize: 3,
    skipPerfectScores: true,
    candidateSelection: "pareto",
  }),

  trainset,
  valset,

  metric: triageQuality,

  objective: `
Improve support ticket triage accuracy.
Prefer category decisions based on the user's desired resolution.
Avoid overfitting to isolated keywords.
  `,

  background: `
Billing includes refunds, charges, invoices, subscriptions, and failed payments.
Technical includes product defects, login failures, API issues, and integrations.
Account includes permissions, identity, account status, and profile changes.
  `,
});
```

## 12.5 GEPA config

```ts
export type GepaConfig = {
  maxMetricCalls: number;
  reflectionBatchSize?: number;
  skipPerfectScores?: boolean;

  candidateSelection?: "pareto" | "best-score";

  reflectionModel?: ModelProvider | ReflectionModel;

  mutation?: {
    maxPathsPerMutation?: number;
    allowNewPaths?: false;
  };

  scoring?: {
    aggregate?: "mean" | "median" | "weighted";
  };

  trace?: {
    includePrompts?: boolean;
    includeModelResponses?: boolean;
    includePassingExamples?: boolean;
  };
};
```

Defaults:

```ts
{
  reflectionBatchSize: 3,
  skipPerfectScores: true,
  candidateSelection: "pareto",
  mutation: {
    maxPathsPerMutation: 3,
    allowNewPaths: false,
  },
  trace: {
    includePrompts: true,
    includeModelResponses: false,
    includePassingExamples: false,
  },
}
```

## 12.6 GEPA loop

Implement:

```txt
1. Extract seed TextCandidate from target.
2. Evaluate seed on train minibatch.
3. Store candidate and scores.
4. Select candidate from frontier.
5. Select examples for reflection.
6. Run candidate on examples.
7. Collect:
   - predictions
   - scores
   - feedback
   - ctx.log output
   - run traces
   - component traces
   - adapter prompts
8. Optionally request component-scoped feedback.
9. Call reflection model to propose candidate patch.
10. Validate patch:
    - only existing candidate paths
    - string values
    - no schema/control-flow changes
11. Apply patch to candidate.
12. Evaluate patched candidate.
13. Update Pareto frontier.
14. Repeat until maxMetricCalls exhausted.
15. Return best CompiledArtifact.
```

## 12.7 Component-scoped feedback

GEPA must support asking a metric about one component:

```ts
await metric.evaluate({
  example,
  prediction,
  expected,
  trace,

  target: {
    componentId: "triage_ticket",
    trace: trace.components.find((component) => component.componentId === "triage_ticket"),
  },
});
```

This is important because feedback like “the flow failed” is less useful than “the `category` field description caused the triage component to over-index on keywords.”

## 12.8 Reflection model interface

```ts
export type ReflectionModel = {
  generatePatch(args: {
    objective: string;
    background?: string;

    currentCandidate: TextCandidate;

    allowedPaths: Array<{
      path: string;
      currentValue: string;
      kind:
        | "instructions"
        | "input_description"
        | "output_description"
        | "tool_description"
        | "agent_system";
    }>;

    examples: Array<{
      input: unknown;
      expected: unknown;
      prediction: unknown;
      score: number;
      feedback?: string;
      logs?: string[];
      trace?: RunTrace;
      target?: {
        componentId: string;
        trace?: ComponentTrace;
      };
    }>;
  }): Promise<{
    candidatePatch: Partial<TextCandidate>;
    rationale: string;
  }>;
};
```

## 12.9 Patch validation

GEPA must reject patches that:

```txt
modify unknown paths
delete required paths
return non-string values
try to add schema/config paths
produce empty critical descriptions
exceed max length constraints
```

Add config:

```ts
maxTextLengthPerPath?: number;
minTextLengthPerPath?: number;
```

## 12.10 Pareto frontier

A simple frontier model for v0.1:

```ts
type FrontierCandidate = {
  id: string;
  parentId?: string;
  textCandidate: TextCandidate;
  scores: Record<string, number>;
  aggregateScore: number;
  rationale?: string;
  createdAt: string;
};
```

Do not over-engineer multi-objective Pareto math in v0.1. Keep the structure extensible, but implement:

```txt
best aggregate score
plus optional per-example best candidates
```

---

# 13. Compiled artifacts

## 13.1 Type

```ts
export type CompiledArtifact = {
  id: string;

  target: {
    kind: "predict" | "program" | "agent";
    id: string;
  };

  optimizer: {
    id: "gepa";
    version: string;
    configHash: string;
  };

  textCandidate: TextCandidate;

  adapter: {
    id: string;
    version: string;
  };

  eval: {
    metricName: string;
    trainScore?: number;
    valScore?: number;
    trainSize: number;
    valSize?: number;
  };

  frontier?: Array<{
    candidateId: string;
    parentId?: string;
    aggregateScore: number;
    textCandidate: TextCandidate;
    rationale?: string;
    feedbackSummary?: string;
  }>;

  createdAt: string;

  metadata?: Record<string, unknown>;
};
```

## 13.2 Required APIs

```ts
triageTicket.withArtifact(compiled);
triageTicket.withCandidate(compiled.textCandidate);
triageTicket.inspectTextCandidate();
triageTicket.inspectPrompt(input);
```

## 13.3 Artifact stores

```ts
export type ArtifactStore = {
  saveArtifact(artifact: CompiledArtifact): Promise<void>;

  loadArtifact(id: string): Promise<CompiledArtifact | null>;

  loadActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
  }): Promise<CompiledArtifact | null>;

  setActiveArtifact(args: {
    targetKind: "predict" | "program" | "agent";
    targetId: string;
    artifactId: string;
  }): Promise<void>;
};
```

## 13.4 Artifact loading precedence

At runtime:

```txt
explicit run candidate
  > module.withCandidate(...)
  > module.withArtifact(...)
  > active artifact store
  > seed signature text
```

---

# 14. Runtime configuration

## 14.1 Core runtime

```ts
so.configure({
  model: openai("gpt-4.1-mini"),

  structuredGeneration: aiSdkStructuredBridge(),

  traceStore: so.stores.memory(),
  artifactStore: so.stores.memory(),

  trace: {
    sampleRate: 1.0,
    redact: so.redactors.standardPII(),
  },
});
```

## 14.2 Runtime context

```ts
export type RuntimeContext = {
  model: ModelProvider | ModelHandle;
  structuredGeneration: StructuredGenerationBridge;

  traceStore?: TraceStore;
  artifactStore?: ArtifactStore;

  redactor?: TraceRedactor;

  logger?: Logger;
};
```

## 14.3 Model provider abstraction

```ts
export type ModelProvider = {
  id: string;

  complete?(args: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<ModelResponse>;

  structured?(args: {
    messages: ModelMessage[];
    schema: z.ZodTypeAny;
    abortSignal?: AbortSignal;
  }): Promise<{
    object: unknown;
    rawResponse?: unknown;
    usage?: TokenUsage;
  }>;
};
```

In most cases, Superobjective should prefer the AI SDK bridge instead of implementing provider-specific structured calls.

---

# 15. Project graph

## 15.1 Purpose

The project graph is explicit data describing how modules/programs are surfaced.

```ts
export const project = so.project({
  programs: [triageTicket, supportFlow],
  agents: [supportAgent],
  rpc: [supportRpc],
  mcp: [supportMcp],
});
```

## 15.2 Agent surface

```ts
export const supportAgent = so.agent({
  name: "support",

  chat: supportFlow,

  tools: [triageTicket, lookupOrder],

  system: so.text({
    value: "You are a precise support assistant.",
    optimize: true,
  }),
});
```

## 15.3 RPC surface

```ts
export const supportRpc = so.rpc({
  name: "support_rpc",

  handlers: {
    triageTicket,
    supportFlow,
  },
});
```

## 15.4 MCP surface

```ts
export const supportMcp = so.mcp({
  name: "support_tools",

  tools: [triageTicket, lookupOrder],
});
```

## 15.5 Project validation

`so.project(...)` should validate:

```txt
unique program/module names
unique agent names
unique rpc names
unique mcp names
all referenced tools are known modules/programs/tools
no duplicate handler names
no name collisions that would create ambiguous routes
no Cloudflare-specific config in core objects
```

---

# 16. Tool conversion

## 16.1 PredictModule as tool

A `PredictModule` can become a tool in agents or MCP.

Tool input schema:

```txt
derived from signature.input
field descriptions included
```

Tool execution:

```txt
validate input
call PredictModule
return output
record ToolCallTrace + component trace
```

## 16.2 Tool type

```ts
export type Tool<TInput, TOutput> = {
  kind: "tool";
  name: string;
  description: TextParam;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;

  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
};
```

## 16.3 Custom tool helper

```ts
export const lookupOrder = so.tool({
  name: "lookup_order",

  description: so.text({
    value: "Look up an order by order ID or customer email.",
    optimize: true,
  }),

  input: z.object({
    orderId: z.string().optional(),
    email: z.string().email().optional(),
  }),

  async execute(input, ctx) {
    ctx.log(`Looking up order: ${JSON.stringify(input)}`);
    return await ctx.runtime.env.ORDERS.lookup(input);
  },
});
```

---

# 17. Cloudflare plugin

## 17.1 Role

`@superobjective/cloudflare` hosts a Superobjective project graph on Cloudflare primitives.

Cloudflare Agents are TypeScript classes running on Durable Objects, and Cloudflare describes each agent as a stateful micro-server with its own SQL database, WebSockets, and scheduling. ([Cloudflare Docs][8])

The plugin should provide:

```txt
createCloudflareWorker
stable host classes
Workers AI model adapter
AI SDK structured-generation bridge
SQLite trace store
SQLite artifact store
optional R2 blob store
Agent/Think/MCP/RPC routing
development mode warnings
```

It should not provide:

```txt
core signature model
core GEPA algorithm
core examples/metrics semantics
hidden registry
generated subclass per logical agent
```

## 17.2 Stable host classes

Users should not write:

```ts
class SupportAgent extends Think {}
```

Instead:

```ts
// src/worker.ts
import { createCloudflareWorker, cloudflare } from "@superobjective/cloudflare";
import { AgentHost, ThinkHost, McpHost } from "@superobjective/cloudflare/hosts";

import { project } from "./project";

export { AgentHost, ThinkHost, McpHost };

export default createCloudflareWorker({
  project,

  runtime: {
    model: cloudflare.workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    traceStore: cloudflare.sqliteTraceStore(),
    artifactStore: cloudflare.sqliteArtifactStore(),
  },
});
```

## 17.3 Wrangler config

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "superobjective-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-04-19",

  "durable_objects": {
    "bindings": [
      {
        "name": "SO_AGENT",
        "class_name": "AgentHost",
      },
      {
        "name": "SO_THINK",
        "class_name": "ThinkHost",
      },
      {
        "name": "SO_MCP",
        "class_name": "McpHost",
      },
    ],
  },

  "migrations": [
    {
      "tag": "superobjective-hosts-v1",
      "new_sqlite_classes": ["AgentHost", "ThinkHost", "McpHost"],
    },
  ],

  "ai": {
    "binding": "AI",
  },

  "r2_buckets": [
    {
      "binding": "SO_ARTIFACTS",
      "bucket_name": "superobjective-artifacts",
    },
  ],
}
```

## 17.4 Why stable host classes

Adding a new logical Superobjective program should not require a new Durable Object class. Durable Object class names and migrations are deployment/state concerns. A stable set of host classes lets the project graph change without creating a new Cloudflare class for every logical agent.

## 17.5 Routing model

```txt
/agents/:agentName/:sessionId
  → ThinkHost
  → project.agents[agentName]
  → chat program + tools

/rpc/:rpcName/:handlerName
  → AgentHost
  → project.rpc[rpcName].handlers[handlerName]
  → PredictModule or Program

/mcp/:mcpName
  → McpHost
  → project.mcp[mcpName].tools
```

## 17.6 Think integration

Cloudflare Think supports several tool sources, including custom server-side tools via `getTools()`, MCP tools, client tools, and built-in workspace tools backed by Durable Object SQLite. ([Cloudflare Docs][9])

`ThinkHost` should:

```txt
map so.agent({ chat, tools }) to Think lifecycle
convert PredictModule/Tool to AI SDK tools
use input field descriptions in tool schemas
call Superobjective runtime inside tool execute
record tool traces
record model traces
load/store active artifacts from SQLite
```

## 17.7 Durable execution / long-running compile jobs

GEPA compile jobs may be long. Cloudflare’s durable execution docs note that Durable Objects can be evicted due to inactivity, code updates, or alarm handler timeout, and that `runFiber()` can make mid-work eviction survivable. ([Cloudflare Docs][10])

For v0.1:

```txt
Core GEPA runs in normal TypeScript.
Cloudflare compile endpoint may use fibers or workflows later.
Do not require Cloudflare for compile.
```

Recommended later extension:

```txt
CompileWorkflow
  runs GEPA in Cloudflare Workflows/Fibers
  stores artifacts in SQLite/R2
  streams progress to Agent state
```

## 17.8 Cloudflare development hints

Superobjective should expose hints but not replace Wrangler:

```ts
export default createCloudflareWorker({
  project,

  cloudflare: {
    development: {
      mode: "local-remote-bindings",

      bindings: {
        AI: "remote",
        SO_ARTIFACTS: "local",
        SO_TRACES: "local",
      },

      durableObjects: "local",
      workflows: "local",
    },
  },
});
```

Types:

```ts
type DevelopmentMode = "local" | "local-remote-bindings" | "remote-preview" | "deploy";

type BindingMode = "local" | "remote";
```

Warnings:

```txt
Remote bindings may write to real remote resources.
Remote bindings may incur billing.
Remote bindings add network latency.
Durable Objects and Workflows cannot always be remote in local development.
```

---

# 18. Cloudflare storage schema

## 18.1 Artifacts

```sql
CREATE TABLE IF NOT EXISTS so_artifacts (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  optimizer_id TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  score REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_so_artifacts_target
  ON so_artifacts(target_kind, target_id, created_at);
```

## 18.2 Active artifacts

```sql
CREATE TABLE IF NOT EXISTS so_active_artifacts (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
```

## 18.3 Traces

```sql
CREATE TABLE IF NOT EXISTS so_traces (
  run_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_so_traces_target
  ON so_traces(target_kind, target_id, created_at);
```

## 18.4 Eval runs

```sql
CREATE TABLE IF NOT EXISTS so_eval_runs (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  optimizer_id TEXT,
  score REAL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## 18.5 R2 spillover

Large artifacts should go to R2 later:

```txt
large traces
large model responses
screenshots/images
huge stdout logs
frontier histories
retrieval dumps
```

SQLite row stores:

```txt
r2://bucket/key
```

---

# 19. Package layout

## 19.1 Monorepo

```txt
packages/
  core/
    package: superobjective

  optimizer-gepa/
    package: @superobjective/optimizer-gepa

  cloudflare/
    package: @superobjective/cloudflare
```

## 19.2 `superobjective` exports

```txt
so
superobjective

text
input
output
signature
predict
program
tool
examples
metric
compile
project
agent
rpc
mcp

adapters.xml
adapters.json
adapters.nativeStructured

stores.memory
stores.filesystem

redactors.standardPII
```

Types:

```txt
TextParam
Field
Signature
Adapter
AdapterOutput
PredictModule
Program
Tool
Example
Metric
Score
RunTrace
ComponentTrace
ModelCallTrace
ToolCallTrace
TextCandidate
CompiledArtifact
Project
RuntimeContext
ArtifactStore
TraceStore
StructuredGenerationBridge
```

## 19.3 `@superobjective/optimizer-gepa` exports

```txt
gepa
GepaOptimizer
GepaConfig
ReflectionModel
```

Core may re-export:

```ts
so.optimizers.gepa();
```

## 19.4 `@superobjective/cloudflare` exports

```txt
createCloudflareWorker
cloudflare

cloudflare.workersAI
cloudflare.sqliteTraceStore
cloudflare.sqliteArtifactStore
cloudflare.r2BlobStore
cloudflare.aiSdkBridge
```

Hosts:

```txt
@superobjective/cloudflare/hosts
  AgentHost
  ThinkHost
  McpHost
```

---

# 20. End-to-end example

## 20.1 Signature and module

```ts
// src/triage.ts
import { z } from "zod";
import { so } from "superobjective";

export const TriageTicket = so
  .signature("triage_ticket")
  .withInstructions("Classify a support ticket for human routing.", {
    optimize: true,
  })
  .withInput("subject", z.string(), {
    description: "The ticket subject line, usually a terse user-written summary.",
    optimize: true,
  })
  .withInput("body", z.string(), {
    description:
      "The full user-written ticket body, including symptoms, account context, and desired resolution.",
    optimize: true,
  })
  .withOutput("category", z.enum(["billing", "technical", "account", "other"]), {
    description: "The primary support queue that should handle the request.",
    optimize: true,
  })
  .withOutput("priority", z.enum(["low", "medium", "high"]), {
    description: "Urgency based on user impact, business risk, and time sensitivity.",
    optimize: true,
  })
  .withOutput("needsHuman", z.boolean(), {
    description: "Whether the issue should be escalated to a human support agent.",
    optimize: true,
  })
  .build();

export const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
});
```

## 20.2 Examples

```ts
// src/triage.examples.ts
import { so } from "superobjective";
import { TriageTicket } from "./triage";

export const trainset = so.examples(TriageTicket, [
  {
    id: "refund-001",
    input: {
      subject: "Refund not received",
      body: "I returned my item two weeks ago and still have not received the refund.",
    },
    expected: {
      category: "billing",
      priority: "medium",
      needsHuman: false,
    },
  },
]);
```

## 20.3 Metric

```ts
// src/triage.metric.ts
import { so } from "superobjective";

export const triageQuality = so.metric({
  name: "triage_quality",

  async evaluate(ctx) {
    const prediction = ctx.prediction;
    const expected = ctx.expected;

    let score = 1;
    const failures: string[] = [];

    if (prediction.category !== expected.category) {
      score -= 0.5;
      failures.push(`Wrong category: expected ${expected.category}, got ${prediction.category}.`);
    }

    if (prediction.priority !== expected.priority) {
      score -= 0.25;
      failures.push(`Wrong priority: expected ${expected.priority}, got ${prediction.priority}.`);
    }

    if (prediction.needsHuman !== expected.needsHuman) {
      score -= 0.25;
      failures.push(
        `Wrong escalation: expected ${expected.needsHuman}, got ${prediction.needsHuman}.`,
      );
    }

    for (const failure of failures) {
      ctx.log(failure);
    }

    return {
      score: Math.max(0, score),

      feedback:
        failures.length === 0
          ? "Correct."
          : `
The triage output had these problems:
${failures.map((failure) => `- ${failure}`).join("\n")}

Improve the field descriptions so the model uses the user's desired resolution
and concrete business impact, not only surface-level keywords.
          `,
    };
  },
});
```

## 20.4 Compile

```ts
// scripts/compile-triage.ts
import { so } from "superobjective";
import { triageTicket } from "../src/triage";
import { trainset } from "../src/triage.examples";
import { triageQuality } from "../src/triage.metric";

const compiled = await so.compile(triageTicket, {
  optimizer: so.optimizers.gepa({
    maxMetricCalls: 120,
    reflectionBatchSize: 3,
    skipPerfectScores: true,
    candidateSelection: "pareto",
  }),

  trainset,

  metric: triageQuality,

  objective: "Improve support ticket triage accuracy.",

  background: `
Billing includes refunds, charges, invoices, subscriptions, and failed payments.
Technical includes product defects, login failures, API issues, and integrations.
Account includes permissions, identity, account status, and profile changes.
  `,
});

await so.stores.filesystem(".superobjective/artifacts").saveArtifact(compiled);
```

## 20.5 Project graph

```ts
// src/project.ts
import { so } from "superobjective";
import { triageTicket } from "./triage";
import { supportFlow } from "./support-flow";
import { lookupOrder } from "./tools";

export const supportAgent = so.agent({
  name: "support",

  system: so.text({
    value: "You are a precise and concise customer support assistant.",
    optimize: true,
  }),

  chat: supportFlow,

  tools: [triageTicket, lookupOrder],
});

export const supportRpc = so.rpc({
  name: "support_rpc",

  handlers: {
    triageTicket,
    supportFlow,
  },
});

export const supportMcp = so.mcp({
  name: "support_tools",

  tools: [triageTicket, lookupOrder],
});

export const project = so.project({
  programs: [triageTicket, supportFlow],

  agents: [supportAgent],

  rpc: [supportRpc],

  mcp: [supportMcp],
});
```

## 20.6 Cloudflare worker

```ts
// src/worker.ts
import { createCloudflareWorker, cloudflare } from "@superobjective/cloudflare";
import { AgentHost, ThinkHost, McpHost } from "@superobjective/cloudflare/hosts";

import { project } from "./project";

export { AgentHost, ThinkHost, McpHost };

export default createCloudflareWorker({
  project,

  runtime: {
    model: cloudflare.workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    structuredGeneration: cloudflare.aiSdkBridge(),
    traceStore: cloudflare.sqliteTraceStore(),
    artifactStore: cloudflare.sqliteArtifactStore(),
  },

  cloudflare: {
    development: {
      mode: "local-remote-bindings",
      bindings: {
        AI: "remote",
        SO_ARTIFACTS: "local",
      },
      durableObjects: "local",
      workflows: "local",
    },
  },
});
```

---

# 21. Implementation milestones

## Milestone 1 — Core value model

Implement:

```txt
so.text
so.input
so.output
so.signature
type inference
seed TextCandidate extraction
candidate application
```

Definition of done:

```txt
signature can be created
input/output types infer correctly
text candidate paths are deterministic
candidate can override instructions/descriptions
```

## Milestone 2 — Adapter + schema generation

Implement:

```txt
Adapter interface
XML adapter
signatureToInputZodSchema
signatureToOutputZodSchema
signatureToInputJsonSchema
signatureToOutputJsonSchema
candidate-aware descriptions
inspectPrompt
```

Definition of done:

```txt
XML adapter renders instructions + field descriptions + field types
adapter emits AI SDK structured output schema
schema descriptions reflect active candidate
inspectPrompt is deterministic
```

## Milestone 3 — Predict runtime

Implement:

```txt
so.predict
RuntimeContext
StructuredGenerationBridge
AI SDK bridge
input validation
output validation
trace capture
memory trace store
memory artifact store
```

Definition of done:

```txt
PredictModule can be called
AI SDK structured output path works
fallback parser exists but is not primary
traces include messages and output schema
```

## Milestone 4 — Programs, examples, metrics

Implement:

```txt
so.program
ProgramContext
so.examples
so.metric
runEval
ctx.log
component traces
```

Definition of done:

```txt
programs compose predict modules
examples validate against target
metrics receive prediction/expected/trace
ctx.log becomes optimizer-visible logs
```

## Milestone 5 — GEPA

Implement:

```txt
@superobjective/optimizer-gepa
GEPA config
reflection model interface
candidate mutation
patch validation
component-scoped metric calls
frontier storage
CompiledArtifact
withArtifact
```

Definition of done:

```txt
GEPA optimizes instructions
GEPA optimizes field descriptions
GEPA consumes score + feedback + logs/traces
GEPA never mutates schemas/control flow
CompiledArtifact changes inspectPrompt output
```

## Milestone 6 — Project graph

Implement:

```txt
so.project
so.agent
so.rpc
so.mcp
so.tool
graph validation
tool conversion helpers
```

Definition of done:

```txt
project is explicit
no side-effect imports required
no cloudflare metadata in predict
tools derive schemas from signatures
```

## Milestone 7 — Cloudflare plugin

Implement:

```txt
createCloudflareWorker
AgentHost
ThinkHost
McpHost
Workers AI model adapter
AI SDK structured bridge
SQLite trace/artifact stores
R2 blob store optional
RPC route dispatch
Think tool conversion
MCP tool conversion
development mode warnings
```

Definition of done:

```txt
wrangler dev works
wrangler deploy works
stable host classes are exported
new predict module does not require new host class
Think tools can call PredictModule
traces/artifacts persist in SQLite
```

---

# 22. Acceptance checklist

A v0.1 prototype is acceptable only if:

```txt
[ ] `predict()` returns a pure callable module value.
[ ] No user program relies on side-effect imports.
[ ] Field descriptions are required.
[ ] Field descriptions are adapter-visible.
[ ] Field descriptions can be marked optimize: true.
[ ] XML adapter includes instructions, field descriptions, field types, examples, and current input.
[ ] Adapter emits AI SDK structured output schema.
[ ] Output schema is derived from Signature, not separately authored.
[ ] Output schema descriptions reflect active TextCandidate.
[ ] AI SDK structured output is the default enforcement path.
[ ] XML parsing is fallback, not the preferred structured path.
[ ] `inspectPrompt(input)` returns deterministic messages and schema summary.
[ ] Examples are typed.
[ ] Metrics return `{ score, feedback?, logs? }`.
[ ] `ctx.log()` becomes optimizer-visible ASI.
[ ] Traces include whole-run and component-level data.
[ ] Traces include adapter-rendered prompt and output schema.
[ ] GEPA optimizes only TextCandidate string values.
[ ] GEPA never mutates schemas, field names, enum values, or control flow.
[ ] CompiledArtifact stores a TextCandidate dictionary.
[ ] `.withArtifact()` changes rendered prompt/schema descriptions without changing code.
[ ] Cloudflare placement is defined only in `project`.
[ ] `@superobjective/cloudflare/hosts` exports `AgentHost`, `ThinkHost`, `McpHost`.
[ ] Cloudflare Worker uses normal `wrangler dev` and `wrangler deploy`.
[ ] Cloudflare local/remote binding hints emit warnings but do not replace Wrangler.
```

---

# 23. Non-goals for v0.1

Do not implement:

```txt
hidden global registry
side-effect imports
file-glob discovery in core
required superobjective dev command
cloudflare.expose inside predict()
generated subclass per logical agent
MIPRO
few-shot bootstrap optimizer
model routing optimizer
tool policy optimizer
schema mutation
field renaming
program control-flow mutation
dynamic worker code evolution
Python DSPy bridge
visual UI
multi-tenant dashboard
```

---

# 24. Final mental model

```txt
Signature
  typed behavior
  optimizable instructions
  optimizable field descriptions

Adapter
  renders semantics into messages
  derives AI SDK output schema

AI SDK
  enforces structured output

PredictModule
  typed callable LLM module

Program
  TypeScript composition of modules

Example
  typed input/expected case

Metric
  score + feedback + logs/traces

GEPA
  improves TextCandidate using feedback

CompiledArtifact
  optimized text dictionary

Project
  explicit graph of programs, agents, RPC, MCP

Cloudflare plugin
  stable host classes + routing + storage
```

The one-line implementation directive:

> **Build Superobjective as explicit TypeScript values. Use signatures as the semantic source of truth, adapters as the prompt/schema bridge, AI SDK as the structured-output enforcement layer, GEPA as the text optimizer, and Cloudflare as an optional host for the explicit project graph.**

[1]: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data "AI SDK Core: Generating Structured Data"
[2]: https://dspy.ai/learn/programming/signatures/ "Signatures - DSPy"
[3]: https://gepa-ai.github.io/gepa/blog/2026/02/18/introducing-optimize-anything/ "optimize_anything: A Universal API for Optimizing any Text Parameter - GEPA"
[4]: https://gepa-ai.github.io/gepa/ "Optimize Anything with LLMs - GEPA"
[5]: https://dspy.ai/learn/programming/adapters/?utm_source=chatgpt.com "Adapters"
[6]: https://dspy.ai/api/adapters/XMLAdapter/ "XMLAdapter - DSPy"
[7]: https://arxiv.org/html/2507.19457v1?utm_source=chatgpt.com "GEPA: Reflective Prompt Evolution Can Outperform ..."
[8]: https://developers.cloudflare.com/agents/ "Agents · Cloudflare Agents docs"
[9]: https://developers.cloudflare.com/agents/api-reference/think/ "Think · Cloudflare Agents docs"
[10]: https://developers.cloudflare.com/agents/api-reference/durable-execution/ "Durable execution · Cloudflare Agents docs"
