# Ubiquitous Language

## Core LLM programming

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Superobjective** | A TypeScript-first programming layer for explicit, typed, optimizable LLM systems. | Zupa, prompt framework |
| **Signature** | The semantic source of truth for a typed LLM behavior, including instructions, input fields, output fields, schemas, and descriptions. | Task schema, prompt spec |
| **Field** | A named input or output slot that combines a stable key, validation schema, and semantic description. | Property, parameter, variable |
| **Input Field** | A field supplied by the caller before a module runs. | Input, argument |
| **Output Field** | A field produced by a module and validated after generation. | Result field, return property |
| **Text Param** | A text value that explicitly declares whether GEPA may optimize it. | Prompt string, description string |
| **Adapter** | A component that renders a signature, candidate, examples, and input into model messages and structured output configuration. | Prompt template, parser |
| **XML Adapter** | The default adapter that renders signature semantics as XML-like prompt sections while still using structured output enforcement. | XML parser |
| **Structured Generation Bridge** | The runtime boundary that asks a model provider for schema-constrained output. | AI SDK wrapper, model caller |
| **Predict Module** | A callable module that executes one signature through one adapter. | Predictor, prediction function |
| **Program** | A callable module that composes modules and tools using normal TypeScript control flow. | Workflow, flow |
| **Tool** | A callable capability exposed to programs, agents, or MCP with an input schema, optional output schema, and description. | Function, action |
| **Agent** | A chat surface with a system text, a chat module, and optional tools. | Assistant, bot |
| **Project Graph** | The explicit collection of programs, agents, RPC surfaces, MCP surfaces, and corpora to host. | Registry, app config |

## Optimization and evaluation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **GEPA** | The v0.1 optimizer that reflectively improves explicit text candidates using examples, metric feedback, and traces. | Optimizer, prompt tuner |
| **Text Candidate** | A dictionary of stable text paths to string values that GEPA is allowed to mutate. | Candidate, prompt patch |
| **Candidate Path** | A deterministic key naming an optimizable text value, such as a signature instruction or field description. | Text path, prompt key |
| **Compiled Artifact** | A stored optimization result containing a text candidate, target identity, optimizer metadata, eval scores, and optional frontier data. | Artifact, compiled prompt |
| **Active Artifact** | The compiled artifact selected by an artifact store for a target at runtime. | Current artifact, deployed artifact |
| **Example** | A validated input and expected output pair used to evaluate a target. | Fixture, sample |
| **Trainset** | The examples used by GEPA for iterative candidate improvement. | Training examples |
| **Valset** | The examples used to validate the selected candidate after optimization. | Validation examples |
| **Metric** | A deterministic evaluator that compares prediction to expected output and returns a score plus optional feedback and logs. | Scorer, eval |
| **Score** | The numeric result of a metric evaluation plus optional diagnostic context. | Grade, rating |
| **Objective** | The natural-language optimization goal passed to GEPA. | Goal, instruction |
| **Reflection Model** | The model used by GEPA to propose candidate patches from failures, traces, and feedback. | Optimizer model, mutation model |
| **Frontier** | The retained set of candidate variants and scores considered during optimization. | Candidate history, Pareto set |
| **Candidate Patch** | A proposed partial update to existing candidate paths. | Mutation, diff |

## Runtime and observability

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Runtime Context** | The runtime dependencies used by execution, including model, structured generation, stores, corpora, redaction, and logging. | Config, environment |
| **Run Trace** | The top-level execution record for one target invocation. | Trace, run log |
| **Component Trace** | The execution record for one module, tool, adapter, RPC, MCP, or RLM component inside a run. | Span, child trace |
| **Model Call Trace** | The trace record for one model invocation, including messages, schema, latency, usage, and finish reason. | LLM call log |
| **Tool Call Trace** | The trace record for one tool invocation, including input, output, errors, and source. | Tool log |
| **Prompt Inspection** | A preview of the rendered prompt, output schema, adapter metadata, and candidate used for a module input. | Prompt preview, inspect output |
| **Trace Store** | Persistence for run traces. | Log store |
| **Artifact Store** | Persistence for compiled artifacts and active artifact selection. | Prompt store, artifact registry |
| **Trace Redactor** | A runtime hook that removes sensitive data from traces before storage. | PII filter, sanitizer |

## Hosting and surfaces

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Surface** | A hosted entry point that exposes project graph behavior to callers. | Route, endpoint |
| **RPC Surface** | A named set of handlers exposed for RPC-style invocation. | RPC route, handler group |
| **MCP Surface** | A named set of tools exposed through Model Context Protocol. | MCP route, MCP server |
| **Cloudflare Worker** | The Cloudflare-hosted runtime that serves the project graph and dashboard-facing routes. | Worker app, server |
| **Stable Host Class** | A reusable Durable Object or Agent host class that dispatches logical project graph entries without generating a class per logical agent. | Generated agent class |
| **Kernel** | The Cloudflare dispatch layer for running modules, tools, chat state, artifacts, corpora, traces, and RLM runs. | Router, dispatcher |
| **Dashboard** | The operator UI for project graph surfaces, traces, compiled artifacts, frontier metadata, and live invocation. | Admin UI, console |
| **Corpus** | A named data collection with storage and optional retrieval configuration. | Dataset, knowledge base |
| **Corpus Resource** | A file or data item made available to RLM through a prepared context. | Document, resource |

## RLM

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **RLM Module** | A module that solves a signature through iterative JavaScript steps over prepared external context. | Reasoning module, code mode module |
| **RLM Session** | The runtime object that prepares context, executes steps, checkpoints progress, resumes work, and closes resources. | Session, hosted session |
| **Prepared Context** | The RLM-accessible context root, manifest, resources, variables, and tool summary for a run. | Workspace, context |
| **Act Step** | The RLM model step that emits reasoning and executable JavaScript for the next iteration. | Planning step, code step |
| **Extract Step** | The RLM model step that converts the trajectory into the final structured output. | Finalization, extraction |
| **REPL History** | The sequence of previous RLM code snippets and observations. | Trajectory, history |
| **Query Provider** | The provider used by RLM code to ask bounded semantic subquestions through `llm_query` or batched queries. | Subsolver, helper LLM |
| **Checkpoint** | A persisted RLM session state that can be resumed later. | Save point, snapshot |
| **Query Budget** | The maximum number of semantic query calls allowed during an RLM run. | Query limit |
| **LLM Budget** | The maximum number of model steps allowed during an RLM run. | Model-call limit |

## Support-triage fixture

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Support Ticket** | A customer-written support request with subject and body. | Case, request |
| **Triage** | The classification of a support ticket into routing, priority, and human-review decisions. | Classification |
| **Queue** | The internal support owner for a ticket, such as billing, technical, account, or trust-and-safety. | Category, route |
| **Priority** | The urgency assigned to a support ticket. | Severity |
| **Severity** | The risk level predicted by the trace probe risk stage. | Priority |
| **Intent** | The normalized reason for the customer's request, such as refund, access, degradation, or policy review. | Purpose, category |
| **Customer Tone** | The inferred tone of the customer request. | Sentiment |
| **Escalation Reason** | The reason a ticket should or should not be escalated. | Rationale |
| **Needs Human** | A boolean decision that a human specialist should take over. | Escalated, human review |
| **Operator Summary** | A concise internal summary for support operators. | Case summary |
| **Customer Reply** | A concise draft response for the customer. | Response, email |
| **Eligibility** | The tool result deciding whether automated handling is approved. | Approval |

## Relationships

- A **Signature** contains one or more **Input Fields** and one or more **Output Fields**.
- A **Predict Module** executes exactly one **Signature** through exactly one **Adapter**.
- A **Program** composes one or more **Predict Modules**, **RLM Modules**, **Programs**, or **Tools**.
- A **Project Graph** contains zero or more **Programs**, **Agents**, **RPC Surfaces**, **MCP Surfaces**, and **Corpora**.
- An **Agent** has exactly one chat module and zero or more **Tools**.
- **GEPA** extracts a **Text Candidate** from a target and produces one **Compiled Artifact**.
- A **Compiled Artifact** belongs to exactly one target and contains exactly one **Text Candidate**.
- An **Artifact Store** can select at most one **Active Artifact** per target.
- A **Run Trace** contains zero or more **Component Traces**, **Model Call Traces**, and **Tool Call Traces**.
- An **RLM Module** uses one **Act Step** per iteration and optionally one **Extract Step** for final structured output.
- A **Support Ticket** produces one **Triage** result in the support-triage fixture.
- A **Triage** result assigns exactly one **Queue**, exactly one **Priority**, and exactly one **Needs Human** decision.

## Example dialogue

> **Developer:** "Should I change the **Signature** when I want GEPA to improve the prompt?"
> **Domain expert:** "Change the **Text Param** only if the text should be optimizer-owned; GEPA mutates the **Text Candidate**, not field keys, schemas, or program control flow."
> **Developer:** "If I compile `triageTicket`, what do I deploy?"
> **Domain expert:** "You store the **Compiled Artifact** and make it the **Active Artifact** for that **Predict Module** through the **Artifact Store**."
> **Developer:** "Where do I inspect what the model actually saw?"
> **Domain expert:** "Use **Prompt Inspection** for a single input, and use the **Run Trace** plus **Component Trace** records after execution."
> **Developer:** "Is `support_flow` a **Surface**?"
> **Domain expert:** "No, it is a **Program**. It becomes reachable only when the **Project Graph** exposes it through an **Agent**, **RPC Surface**, **MCP Surface**, or Cloudflare **Kernel** route."

## Flagged ambiguities

- "candidate" is used casually to mean both a whole **Text Candidate** and a proposed **Candidate Patch**; use **Text Candidate** for the full path dictionary and **Candidate Patch** for a partial update.
- "artifact" can mean any generated file in normal engineering language, but in this repo **Compiled Artifact** means a persisted optimization result with target, optimizer, eval, and text candidate metadata.
- "adapter" should not mean only a prompt template; an **Adapter** also emits structured output configuration and may provide fallback parsing.
- "schema" is overloaded between Zod schemas, JSON Schema, input schemas, output schemas, and AI SDK structured output; prefer **Field** when discussing domain semantics and name the concrete schema form when discussing enforcement.
- "agent" can mean a Superobjective **Agent**, a Cloudflare Agent host class, or a human support agent in fixture text; use **Agent** for the project graph surface and **human specialist** or **human support agent** for support-domain escalation.
- "program" and "project" are easy to blur; a **Program** is executable behavior, while a **Project Graph** is the hosted inventory of executable behavior and surfaces.
- "route" and "surface" are related but not identical; use **Surface** for the domain concept and route/path only for a concrete transport URL.
- "priority" and "severity" both describe urgency in the support fixture; use **Priority** for the triage output and **Severity** for the trace probe risk stage.
