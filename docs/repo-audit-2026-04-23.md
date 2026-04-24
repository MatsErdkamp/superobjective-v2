# Superobjective Repo Audit

Date: 2026-04-23

Scope: manual repository review, Knip dead-code analysis, dependency audit, architecture review of the core/kernel/runtime split, DRY review, and validation via typecheck/test/build.

## Commands Run

- `pnpm add -D -w knip`
- `pnpm exec knip --reporter compact`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- targeted source reads/searches across `packages/core`, `packages/hosting`, `packages/optimizer-gepa`, `packages/cloudflare`, `apps/cloudflare-worker`, `apps/dashboard`, `tests`, `examples`, and `scripts`

Current validation results after the latest refactor pass:

- `pnpm typecheck`: passed. This now covers package project references, `tests/tsconfig.json`, `apps/cloudflare-worker/tsconfig.json`, and `apps/dashboard/tsconfig.json`.
- `pnpm test`: passed, `9` files passed, `1` skipped; `47` tests passed, `3` skipped.
- `pnpm build`: passed. This now builds the package project references before the dashboard. Dashboard build still emits chunk-size warnings: client `-dashboard` chunk is about `571 kB` minified, SSR `-dashboard` chunk is about `1.12 MB`, and server `index.js` is about `565 kB`.
- `pnpm knip --reporter compact`: passed.

## Executive Assessment

Superobjective has a credible core shape for a TypeScript DSPy-like system:

- Signatures are explicit, typed, and carry the semantic text surface.
- Predict modules validate input/output and have prompt inspection.
- Programs/tools/agents are explicit values rather than hidden registry entries.
- Cloudflare hosting is already exercising the harder parts: Worker routes, Durable Object or Agent-backed state, RLM hosted execution, traces, artifacts, and a dashboard.
- The test suite is small but meaningful and currently green.

The repo is not yet clean. The main issue is not a lack of functionality; it is that the architecture has evolved faster than the package boundaries. The same concepts now appear in several forms:

- Core trace/artifact/project types.
- Hosting structural equivalents.
- Optimizer structural equivalents.
- Cloudflare structural equivalents.
- Dashboard summary equivalents.
- Worker-specific route and persistence equivalents.

That duplication is currently tolerable for a prototype, but it is the main thing preventing the repo from becoming a stable library. If this is going to be a library for declarative DSPy-like systems on Cloudflare, the highest-leverage cleanup is to define one protocol layer and make every package depend on it.

The biggest correctness risk is in the text-candidate/optimization path. The public invariant in `README.md` and `SPEC.md` says GEPA optimizes only explicit `TextCandidate` string values. Several code paths violate that by including non-optimized text, and RLM appears to generate candidate paths that do not actually feed the child prompts that get rendered. This can make optimization look successful while mutating dead text.

## What Works Well

### Core DSL

`packages/core` has the right primitives:

- `so.signature(...).withInput(...).withOutput(...).build()` is explicit and strongly typed.
- `TextParam` separates optimizable semantic text from schema shape.
- `predict()` has a good execution path: input validation, candidate resolution, adapter render, structured generation, output parse, trace finalization.
- `inspectPrompt()` on predict modules is a strong user-facing affordance. It makes the prompt/schema/candidate state inspectable before execution.
- Programs use ordinary TypeScript control flow while preserving trace components through `ctx.call`.
- Tool binding sources such as `so.from.chat.currentUserMessage()` and `so.from.latestToolResult()` are an ergonomic direction for deployed agents.

### Runtime

The runtime defaults are pragmatic:

- A missing model provider fails with a clear message.
- Memory stores are good defaults for tests and local use.
- The AI SDK bridge and provider bridge are clean extension points.
- Trace redaction exists as a first-class runtime concern.

### Cloudflare Target

The Cloudflare package is ambitious and already covers important edge-specific concerns:

- Workers AI model handle.
- AI SDK bridge that can bind `env`.
- R2-backed trace/artifact stores with in-memory fallback.
- Corpus abstraction over R2 and AI Search.
- Kernel routes for running modules, tools, chat state, artifacts, corpora, and RLM runs.
- Hosted RLM session flow using loader/facets.
- Durable host classes for RPC, agent chat, MCP, and kernel dispatch.

Conceptually, this is the right direction for Cloudflare deployment. The cleanup problem is that these concerns are packed into too few files and partially duplicated across generic hosting and Cloudflare-specific kernel code.

### Tests

The existing tests cover more than simple happy paths:

- `predict()` end-to-end typing and tracing.
- RLM invalid SUBMIT fallback.
- RLM multi-step long-context behavior.
- Kernel chat/tool binding behavior.
- Cloudflare runtime and app-host pieces.
- Cloudflare RLM compiled step and hosted behavior.

The tests are not exhaustive, but the current set is valuable and fast.

## Highest-Priority Correctness Findings

### 1. RLM TextCandidate Paths Look Wrong For Actual Prompt Rendering

Status after the first refactor pass: fixed with RLM candidate filtering/mapping tests.

Files:

- `packages/core/src/rlm.ts`
- `packages/core/src/predict.ts`
- `packages/core/src/adapters.ts`

`RLMModule.inspectTextCandidate()` merges:

- the original RLM signature path, such as `inspect_dossier.instructions`
- the act child predict signature paths, such as `inspect_dossier_act.instructions`
- the extract child predict signature paths, such as `inspect_dossier_extract.instructions`

The seed candidate is built in `extractRlmSeedCandidate()` with:

```ts
{
  [`${state.signature.name}.instructions`]: state.signature.instructions.value,
}
```

But the actual model calls are made through the child `state.act` and `state.extract` predict modules. Those adapters resolve paths from the child signatures, not the original RLM signature. That means the original RLM path can become an optimizable candidate path that does not affect any rendered prompt.

Impact:

- GEPA can spend mutations on dead RLM paths.
- Artifacts can contain text that users expect to apply but which does not change behavior.
- It breaks the core library invariant that candidate paths are adapter-visible.

Recommendation:

- Decide whether RLM has one public optimization surface or two child surfaces.
- If RLM should expose the original signature as the optimization surface, map original paths into act/extract prompts during rendering.
- If child signatures are the real surface, remove the original seed path from RLM candidates.
- Add tests that compile or apply a candidate to RLM and assert the rendered act/extract prompt changes.

### 2. `optimize: false` Is Not Honored Consistently

Status after the first refactor pass: fixed for tools, agents, and RLM surfaces with regression tests.

Files:

- `packages/core/src/project.ts`
- `packages/core/src/rlm.ts`

Custom tools always emit `tool.${name}.description` in `inspectTextCandidate()`, regardless of `value.description.optimize`.

Module-backed tools also always emit the tool description path, regardless of `description.optimize`.

Agents always emit `agent.${name}.system`, regardless of `value.system.optimize`.

RLM seed candidates always emit original signature instructions, regardless of `state.signature.instructions.optimize`.

Impact:

- This violates the stated invariant: GEPA optimizes only explicit `TextCandidate` string values.
- Users cannot reliably mark text as non-optimizable.
- Artifacts may mutate tool descriptions or agent system prompts that users did not opt into optimization.

Recommendation:

- Centralize `extractTextParamCandidate(path, textParam)` in core and use it everywhere.
- Add tests for `optimize: false` on signature instructions, field descriptions, tool descriptions, agent system prompts, and RLM options.

### 3. GEPA Default Execution Does Not Capture Real Traces

Status after the first refactor pass: fixed. Default GEPA execution now captures real traces through a temporary trace store.

Files:

- `packages/optimizer-gepa/src/evaluate.ts`
- `packages/core/src/predict.ts`
- `packages/core/src/runtime.ts`

`evaluateCandidate()` calls:

```ts
const candidateBoundTarget = args.target.withCandidate(args.candidate);
const rawResult = await candidateBoundTarget(args.example.input);
```

Core targets return plain output values. They do not return `{ output, trace }`; they save traces to the configured trace store. `looksLikeRunResult()` only unwraps when both `output` and `trace` keys exist. Therefore, unless the caller passes a custom GEPA `execute` hook, GEPA creates synthetic empty traces.

Impact:

- Reflection examples often lack prompts, model calls, tool calls, and component traces.
- This weakens the stated GEPA design of using feedback plus logs/traces.
- Users can run GEPA and get much less useful reflection than expected.

Recommendation:

- Give GEPA a runtime trace capture option or a core execution API that returns output plus trace.
- Alternatively, when no custom `execute` hook is provided, create a temporary trace store and pass it through `RunOptions`.
- Add a GEPA test that verifies reflection examples include a prompt/model call for a predict target.

### 4. RLM Is Supported At Runtime But Excluded From Artifact/Optimizer Target Types

Status after the first refactor pass: fixed. RLM is now included in artifact target and optimizer trace/target unions.

Files:

- `packages/core/src/types.ts`
- `packages/hosting/src/types.ts`
- `packages/optimizer-gepa/src/types.ts`
- `packages/cloudflare/src/kernel.ts`

Core `RunTrace.targetKind` includes `"rlm"`, and Cloudflare kernel handles `"rlm"` targets. But `CompiledArtifact.target.kind`, `ArtifactStore` filters, and GEPA `GepaTargetLike.kind` only include `"predict" | "program" | "agent"` in several places.

Impact:

- The type system says RLM is not a first-class artifact target.
- Runtime code partly treats RLM as first-class.
- Active artifact lookup cannot cleanly support RLM without casts or omissions.

Recommendation:

- Either explicitly exclude RLM from optimization/artifacts and document that, or add `"rlm"` across artifact, optimizer, hosting, and Cloudflare types.
- The better fit for this repo is to make RLM first-class, because RLM already exposes text candidates and traces.

### 5. XML Fallback Parser Produces Strings For Boolean Fields

Status after the first refactor pass: fixed, including boolean handling and escaped XML field tags.

File:

- `packages/core/src/adapters.ts`

In XML fallback parsing, boolean fields are assigned with:

```ts
value[key] = String(match[1].trim().toLowerCase() === "true");
```

That returns `"true"` or `"false"` strings, not booleans. The output Zod schema later expects a boolean.

Impact:

- Structured generation hides this in normal execution.
- If structured generation fails and the model provider has `complete()`, fallback parsing can fail for boolean outputs.

Recommendation:

- Assign a boolean, not a string.
- Add fallback tests for boolean, number, enum, optional, and nested output fields.
- Escape regex tag names or restrict field names to XML-safe identifiers.

### 6. Query Budget Is Effectively Unlimited For RLM

Status after the first refactor pass: fixed. `RLMOptions.maxQueryCalls` is now passed into step execution.

Files:

- `packages/core/src/types.ts`
- `packages/core/src/rlm.ts`
- `packages/cloudflare/src/rlm.ts`
- `packages/cloudflare/src/rlm-hosted-step.ts`

The Cloudflare RLM step runner enforces `maxQueryCalls`, but core `RLMOptions` does not expose it. Core passes a very large value to step execution.

Impact:

- Prompts mention budgeted helper use, but users cannot set a real query budget.
- Expensive AI Search or semantic query loops can run unchecked inside a step until other limits are hit.

Recommendation:

- Add `maxQueryCalls` to `RLMOptions`.
- Enforce it consistently in replay and hosted sessions.
- Surface query budget in traces.

## Architecture Review: Core / Hosting / Kernel / Runtime

### Current Shape

The intended layering seems to be:

- `superobjective` / `packages/core`: user DSL, runtime context, signatures, predict/program/tool/agent/RLM, stores, compile API.
- `@superobjective/optimizer-gepa`: optimizer implementation.
- `@superobjective/hosting`: structural contracts and generic request dispatch.
- `@superobjective/cloudflare`: Cloudflare runtime adapters, stores, kernel, worker/host classes, corpora, RLM execution.
- `apps/cloudflare-worker`: example/live app project and dashboard runtime API.
- `apps/dashboard`: operator dashboard.

This layering is sensible in concept. The problem is that the layer boundaries are porous.

### Main Boundary Problems

#### Protocol Types Are Duplicated

The same protocol concepts are repeated in:

- `packages/core/src/types.ts`
- `packages/hosting/src/types.ts`
- `packages/optimizer-gepa/src/types.ts`
- `packages/cloudflare/src/types.ts`
- dashboard response types in `apps/dashboard/src/lib/dashboard.functions.ts`

Examples:

- `RunTrace`
- `ComponentTrace`
- `ModelCallTrace`
- `ToolCallTrace`
- `CompiledArtifact`
- `JsonSchema`
- `TextParam`
- `ModelMessage`
- project/agent/rpc/mcp structural shapes

The copies have already drifted. For example, optimizer traces exclude `"rlm"` while core traces include it.

Recommendation:

- Create `@superobjective/protocol` or `packages/protocol`.
- Move pure JSON-compatible interfaces there: traces, artifacts, text candidates, model messages, tool calls, corpus descriptors, hosted project descriptors, error shape.
- Have core extend/use these protocol types.
- Have hosting, cloudflare, optimizer, and dashboard import from the protocol package.
- Keep Zod-bearing executable types in core, not protocol.

#### `packages/cloudflare/src/worker.ts` Is Too Large

`worker.ts` is about `2770` lines and mixes:

- dynamic imports for Cloudflare-only modules
- active worker registration
- generic fallback dispatch
- kernel forwarding
- RLM runtime host
- hosted RLM session manager
- SQL kernel persistence
- Durable Object/Agent host classes
- Think integration
- MCP integration
- deprecated aliases
- test hooks

Recommendation:

Split it into:

- `registration.ts`
- `routes/worker-fetch.ts`
- `routes/rpc.ts`
- `routes/mcp.ts`
- `hosts/module-kernel.ts`
- `hosts/rpc-host.ts`
- `hosts/agent-route-host.ts`
- `hosts/mcp-route-host.ts`
- `hosts/rlm-runtime-host.ts`
- `persistence/sqlite-kernel-persistence.ts`
- `rlm/facet-session-manager.ts`
- `internal/test-hooks.ts`

The public `worker.ts` should mostly compose these pieces.

#### `packages/cloudflare/src/kernel.ts` Is Also Too Large

`kernel.ts` is about `2015` lines and mixes:

- persistence interfaces
- in-memory persistence
- trace/artifact store adapters
- chat state
- tool result state
- target execution
- all `/kernel/*` route handling
- corpora routes
- artifact routes
- RLM routes

Recommendation:

Split around state domains:

- `kernel/persistence.ts`
- `kernel/memory-persistence.ts`
- `kernel/runtime.ts`
- `kernel/execute-target.ts`
- `kernel/routes/run.ts`
- `kernel/routes/chat.ts`
- `kernel/routes/tools.ts`
- `kernel/routes/artifacts.ts`
- `kernel/routes/corpora.ts`
- `kernel/routes/rlm.ts`

#### Generic Hosting Dispatch And Cloudflare Kernel Dispatch Overlap

Files:

- `packages/hosting/src/dispatch.ts`
- `packages/cloudflare/src/worker.ts`
- `packages/cloudflare/src/kernel.ts`

There are two route execution systems:

- generic `dispatchHostedRequest()`
- Cloudflare kernel execution and route forwarding

`createCloudflareWorker.fetch()` intercepts `/rpc/*` and `/mcp/*` through the kernel, but lets other routes fall through to generic dispatch. Agent routes can go through durable host, Think host, generic dispatch, or kernel-backed tool calls depending on path/binding.

Impact:

- Trace behavior can differ for the same conceptual target.
- Request parsing and validation are duplicated.
- The "real" route model is hard to explain to users.

Recommendation:

- Pick the Cloudflare kernel as the canonical Cloudflare execution path.
- Keep generic hosting as a non-stateful fallback for other deployment targets.
- Make the Cloudflare worker's dispatch rules explicit in docs and tests.

## Knip Findings

Knip found:

- `46` unused files.
- unused dependency groups in root, dashboard, and optimizer package manifests.
- unused dev dependency groups.
- unlisted dependencies/binaries.
- `27` groups of unused exports.
- `5` groups of unused exported types.
- `7` duplicate exports.

Not all Knip findings should be deleted blindly. Several are generated files, public APIs, framework-discovered server functions, or deliberate alias exports. The useful split is below.

### High-Confidence Dead Or Removable Files

- `packages/core/src/bridge.ts`
  - It only re-exports aliases from `runtime.ts`.
  - No source imports it.
  - Delete it unless it is a planned public subpath. The package does not export `./bridge`, so it is not currently public.

- `scripts/compile-triage.ts`
  - README says it is the manual GEPA fixture script, but no root script references it.
  - Either add a root script such as `compile:triage` or remove it.

- `examples/superobjective-demo/src/triage.ts`
- `examples/superobjective-demo/src/triage.examples.ts`
- `examples/superobjective-demo/src/triage.metric.ts`
  - These are only useful if `scripts/compile-triage.ts` remains.
  - Keep with an npm script, or move into tests/fixtures, or delete.

- `apps/dashboard/src/components/ai-elements/suggestion.tsx`
  - Not used by the current dashboard.
  - Delete unless the playground is about to use suggestions.

### Generated Or Intentional Inventory Files

- `apps/cloudflare-worker/src/env.d.ts`
  - Generated by `pnpm types:cloudflare`.
  - Knip flags it because no source imports it directly.
  - Keep but configure Knip to ignore generated worker types.

- Many `apps/dashboard/src/components/ui/*.tsx` files.
  - These look like a shadcn-style component inventory.
  - The current dashboard uses only a subset.
  - If the goal is super clean repo size, delete unused UI components and unused matching dependencies.
  - If the goal is rapid dashboard iteration, keep them and add Knip ignores.

### High-Confidence Dead Or Internal-Only Exports

- `apps/cloudflare-worker/src/workers-ai.ts`
  - `extractWorkersAiText`
  - `parseWorkersAiJson`
  - Both are used only inside the file. Remove `export`.

- `apps/cloudflare-worker/src/triage.ts`
  - `TriageTicket` is not imported outside the file. Remove export unless examples/tests should import it.

- `apps/cloudflare-worker/src/trace-probe.ts`
  - `TraceProbeIntake`
  - `TraceProbeRisk`
  - `TraceProbeResolution`
  - These look internal to module creation. Remove exports if not meant as public fixtures.

- `apps/cloudflare-worker/src/project.ts`
  - `supportAgent`
  - `traceProbeAgent`
  - `supportRpc`
  - `traceProbeRpc`
  - `supportMcp`
  - Only `project` is imported by the worker. Remove exports unless tests or docs need them.

- `apps/dashboard/src/lib/dashboard.functions.ts`
  - `getDashboardProjectGraph`
  - `getDashboardTraces`
  - `getDashboardArtifacts`
  - `getDashboardArtifact`
  - `getDashboardBlobs`
  - `runPlaygroundAgentTurn`
  - Current routes only use `getDashboardSnapshot`, `getDashboardTrace`, and `runDashboardAction`; playground uses `runPlaygroundTurn` from a separate file. Delete or wire these functions into pages.

- `packages/cloudflare/src/worker.ts`
  - `__getActiveWorkerRegistration`
  - `__stableStringify`
  - These are test/internal hooks. Move to `internal/test-hooks.ts` or remove if no tests use them.
  - Status after the latest refactor pass: fixed. Both unused public hooks were removed.

### Public API Decisions, Not Automatic Deletions

Knip flags many exports from package entrypoints:

- `packages/core/src/runtime.ts` re-exported DSL constructors.
- `packages/cloudflare/src/runtime.ts` classes such as `WorkersAIModelHandle`, `AiSdkStructuredBridge`, `BoundR2BlobStore`.
- `packages/cloudflare/src/stores.ts` store classes.
- `packages/core/src/schema.ts` helpers.
- `packages/core/src/candidate.ts` candidate helpers.

For a library, Knip cannot know what is public API. Decide intentionally:

- If users should import only from `so` or package root, stop exporting low-level internals.
- If low-level classes are public extension points, keep them and configure Knip with public entrypoints/ignore exports.

### Duplicate Exports

Knip flags these duplicate aliases:

- `xmlAdapter` and `xml`
- `jsonAdapter` and `json`
- `nativeStructuredAdapter` and `nativeStructured`
- `so` and `superobjective`
- `standardPIIRedactor` and `standardPII`
- `memoryStore` and `memory`
- `filesystemStore` and `filesystem`

These may be deliberate ergonomic aliases, but too many aliases make the API feel less settled. Recommendation:

- Keep the shortest user-facing names under `so.adapters.xml()`, `so.stores.memory()`, etc.
- Keep long names only when they are public extension points.
- Document aliases or remove them before `1.0`.

### Dependency Findings

High-confidence cleanup:

- Root `chess.js` appears unused.
- `packages/optimizer-gepa/package.json` depends on `superobjective`, but optimizer source uses structural types and does not import it. Remove unless planned.
- `tests/cloudflare-rlm.test.ts` imports Acorn from `../packages/cloudflare/node_modules/acorn`; this is brittle. Import `acorn` normally and add it to the relevant root/test dependency if needed.

Needs Knip config, likely not real dependency issue:

- `cloudflare` unlisted dependency is from `cloudflare:workers` virtual imports. Configure Knip to ignore this virtual module.
- `uv` unlisted binary is used by benchmark scripts. Either document `uv` as a system prerequisite, add a setup note, or remove these scripts from the root package.

Dashboard:

- The dashboard manifest includes many dependencies that correspond to unused shadcn/UI inventory: `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `recharts`, `vaul`, etc.
- If unused components are removed, remove their dependencies too.
- Dashboard testing deps are currently unused because there are no dashboard tests.

## Deprecated Code

### Explicitly Deprecated Public Aliases

Files:

- `packages/cloudflare/src/worker.ts`
- `packages/cloudflare/src/index.ts`
- `packages/cloudflare/src/hosts/index.ts`
- `apps/cloudflare-worker/src/worker.ts`
- `wrangler.jsonc`
- `SPEC.md`

Status after the next refactor pass: fixed. The deprecated aliases were removed from the package exports and the first-party worker export. `wrangler.jsonc` still contains historical `renamed_classes` migration entries so existing Durable Object state can move from the old class names to the canonical class names.

Previously deprecated:

- `AgentHost` -> prefer `RpcHost`
- `ThinkHost` -> prefer `HostedAgentRouteHost`
- `McpHost` -> prefer `HostedMcpRouteHost`

### Deprecated SQLite Store Helpers

Files:

- `packages/cloudflare/src/stores.ts`
- `packages/cloudflare/src/runtime.ts`

Status after the first refactor pass: fixed. These aliases were deleted from `stores.ts` and removed from `cloudflare`.

Previously deprecated:

- `createSqliteTraceStore`
- `createSqliteArtifactStore`
- `InMemorySqliteTraceStore`
- `InMemorySqliteArtifactStore`

### Misleading `createR2BlobStore`

File:

- `packages/cloudflare/src/stores.ts`

Status after the first refactor pass: fixed. The internal fallback factory is now `createMemoryBlobStore()`, while `cloudflare.r2BlobStore()` remains the public R2-bound wrapper.

## DRY Review

### Candidate Helpers Are Duplicated

Files:

- `packages/core/src/candidate.ts`
- `packages/core/src/utils.ts`
- `packages/core/src/schema.ts`

There are overlapping helpers for:

- candidate path construction
- `mergeCandidates` (fixed in the first refactor pass)
- signature instruction/field paths
- text param resolution

Recommendation:

- Put all text candidate path helpers in one module.
- Make `schema.ts` schema-only.
- Make `candidate.ts` own `TextParam`, candidate extraction, merge/hash, and path helpers.

### Trace/Artifact Types Are Duplicated

This is the largest DRY issue. See the protocol package recommendation above.

### Request Parsing Is Duplicated

Files:

- `packages/hosting/src/dispatch.ts`
- `packages/cloudflare/src/kernel.ts`
- `packages/cloudflare/src/worker.ts`

`parseRequestInput()` exists in multiple forms.

Status after the second refactor pass: fixed for Cloudflare kernel and worker dispatch. Both now call the hosting parser.

Status after the latest refactor pass: fixed more broadly for hosted agent routes and RPC trace input capture as well. `packages/cloudflare/src/worker.ts` no longer carries a second parser implementation.

Recommendation:

- Keep one parser in hosting or protocol utilities.
- Cloudflare kernel should call the shared parser.

### Stable Stringify / Serialize Error / Create ID Are Duplicated

Files:

- `packages/core/src/utils.ts`
- `packages/hosting/src/project.ts`
- `packages/cloudflare/src/app.ts`
- `packages/cloudflare/src/state-agent.ts`
- `packages/optimizer-gepa/src/utils.ts`

Recommendation:

- Move pure helpers to a shared internal utility package or protocol utilities.
- Avoid copying serialization behavior because trace/artifact hashes depend on stable output.

Status after the second refactor pass: partially fixed. Cloudflare kernel, app host, and state agent now reuse hosting `createId` / `stableStringify`; core and optimizer still keep local helpers because they intentionally avoid a direct hosting dependency.

### Cloudflare Request And R2 Detection Helpers Were Repeated

Files:

- `packages/cloudflare/src/worker.ts`
- `packages/cloudflare/src/kernel.ts`
- `packages/cloudflare/src/app.ts`
- `packages/cloudflare/src/runtime.ts`
- `packages/cloudflare/src/stores.ts`

Status after the latest refactor pass: fixed for the low-risk cases. `getPathSegments()` now owns Cloudflare route segment splitting, and `asR2Bucket()` now owns R2 binding detection. R2 key listing is also centralized through `listR2Keys()` with pagination support.

### RLM Runtime Helper Code Is Duplicated Several Times

Files:

- `packages/cloudflare/src/rlm.ts`
- `packages/cloudflare/src/rlm-hosted-step.ts`
- `packages/cloudflare/src/rlm-facet-source.ts`

Duplicated helpers:

- `sanitizeToolName`
- `pathMatchForCorpus`
- `readTextSlice`
- `searchWithinText`
- step runner source generation
- text resource reading semantics
- corpus helper semantics

`rlm-facet-source.ts` embeds a separate `buildStepRunnerSource` string that mirrors `buildHostedRlmStepWorkerSource()` with small differences. This is high-risk duplication.

Recommendation:

- Generate both hosted and facet step runner source from one builder.
- Keep only a small wrapper difference for inline aliases or facet storage.
- Add snapshot tests for generated worker source.

### App State Backends Duplicate Manifest Logic

Files:

- `packages/cloudflare/src/app.ts`
- `packages/cloudflare/src/state-agent.ts`

Both implement:

- app manifest shape
- storage config normalization
- stable stringify
- state entries
- storage object metadata
- traces

Recommendation:

- Extract shared app state protocol and manifest utilities.
- Keep only persistence-specific code in bucket vs SQL/Agent implementations.

### Example Triage Is Duplicated

Files:

- `apps/cloudflare-worker/src/triage.ts`
- `examples/superobjective-demo/src/triage.ts`

These are nearly identical. If the example fixture must stay, either:

- import the shared triage definition from one source, or
- deliberately keep examples self-contained and add a comment plus Knip ignore.

### Probe Adapter Is Duplicated

Files:

- `apps/cloudflare-worker/src/rlm-probe.ts`
- `apps/cloudflare-worker/src/longcot-probe.ts`

Both define a local `relaxedXmlAdapter`.

Recommendation:

- Extract `createRelaxedXmlAdapter()` to `apps/cloudflare-worker/src/adapters.ts` or use a proper option on the core XML adapter if this is broadly useful.

## Package And Build Issues

### Published Package Entrypoints Point At `src`

Packages expose TypeScript source as `main` and `types`:

```json
{
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

This works in the current workspace/Vite setup, but it is not a normal npm publishing shape.

Recommendation before publishing:

- Add package-level builds to emit `dist`.
- Export `dist/index.js` and `dist/index.d.ts`.
- Decide whether internal imports need `.js` consistently.

Status after the latest refactor pass: partially fixed. Each package now has a `build` script and root `pnpm build` runs the package builds before the dashboard. Package exports still intentionally point at `src`, so the npm publishing shape remains a separate decision.

### Inconsistent Internal Import Extensions

Some packages use `.js` in TypeScript imports; others do not. Examples:

- `packages/core/src/adapters.ts` imports `./candidate` and `./schema`.
- `packages/core/src/schema.ts` imports `./candidate` and `./utils`.
- many Cloudflare/hosting files import extensionless.

This works with bundler resolution and source exports, but it becomes risky if packages emit ESM.

Recommendation:

- Standardize based on the final build target.
- If emitting ESM to `dist`, prefer `.js` extensions in source imports.

### Root Typecheck Did Not Cover Apps/Tests

Root `tsconfig` references packages, while tests and apps are validated through Vite+ scripts. This is acceptable if intentional, but it means `pnpm typecheck` does not mean "everything in the repo was typechecked" in the normal `tsc -b` sense.

Status after the latest refactor pass: fixed for the current repo. `pnpm typecheck` now runs package project references, `tests/tsconfig.json`, `apps/cloudflare-worker/tsconfig.json`, and `apps/dashboard/tsconfig.json`.

Recommendation:

- Either document that Vite+ owns app/test validation, or add project references for apps/tests if they can be cleanly typechecked.

## Dashboard Review

The dashboard is useful as an operator surface, but it is currently one large route file.

Files:

- `apps/dashboard/src/routes/-dashboard.tsx` is about `2697` lines.

It contains:

- layout
- sidebar
- navigation state
- overview
- traces list
- trace detail
- optimization view
- agent view
- waterfall construction
- formatting utilities

Recommendation:

- Split into route-level view components:
  - `DashboardLayout`
  - `OverviewView`
  - `TraceListView`
  - `TraceDetailView`
  - `OptimizationView`
  - `AgentView`
  - `TraceWaterfall`
  - `ProjectGraph`
- Keep route files thin.
- Add a shared dashboard API type module.

The production build warning is real. The dashboard bundle includes a large route chunk. Splitting route components and using dynamic imports for trace/detail-heavy views should reduce the first-load payload.

## Cloudflare Runtime Notes

### Store Naming

`prototypeTraceStore()` and `prototypeArtifactStore()` currently produce R2-backed stores with fallback behavior. The name "prototype" matches README status but is vague as API.

Recommendation:

- Prefer names that say storage and fallback behavior:
  - `cloudflare.r2TraceStore()`
  - `cloudflare.r2ArtifactStore()`
  - `cloudflare.memoryTraceStore()`
  - `cloudflare.memoryArtifactStore()`

### R2 Listing Is Not Paginated

Files:

- `packages/cloudflare/src/stores.ts`
- `packages/cloudflare/src/app.ts`
- `packages/cloudflare/src/corpora.ts`

Several list methods read one `bucket.list({ prefix })` response and do not handle cursors. This is acceptable for prototype stores but not for production-scale traces, artifacts, corpora, or app storage.

Recommendation:

- Add pagination support in the R2 bucket adapter layer.
- Keep higher-level list methods limit-aware.

### Global Mutable Worker Registration

File:

- `packages/cloudflare/src/worker.ts`

The worker stores active registration and local kernel persistence in module globals. This is understandable for a single Worker module, but it increases test coupling and can surprise multi-worker test setups.

Recommendation:

- Encapsulate globals in a registration object.
- Keep test hooks internal.
- Avoid public `__*` exports.

## Spec / Implementation Drift

`SPEC.md` is valuable, but several implementation details have drifted:

- The spec says GEPA optimizes only explicit `TextCandidate` string values; current project/RLM candidate extraction includes some text without checking `optimize`.
- The spec describes Cloudflare host classes with deprecated aliases in places.
- RLM exists in runtime paths but not in artifact/optimizer target type unions.
- Structured output is enforced, but fallback parsing is not robust.

Recommendation:

- Treat this audit as a punch list for a spec refresh.
- Add a "currently implemented" section separate from aspirational design.

## Suggested Cleanup Sequence

### Phase 0: Make Dead-Code Auditing Repeatable

1. Add a root script:

   ```json
   "knip": "knip"
   ```

2. Add `knip.json` with deliberate ignores:

   - generated Worker `env.d.ts`
   - `cloudflare:workers` virtual module
   - package public exports that are intentionally public
   - shadcn component inventory if keeping it
   - benchmark `uv` if keeping Python benchmarks

3. Keep Knip failing in CI only after the config reflects intended public API.

### Phase 1: Low-Risk Deletions

1. Delete `packages/core/src/bridge.ts`.
2. Remove internal-only exports in app files.
3. Remove unused dashboard server functions or wire them into views.
4. Remove dashboard UI components and dependencies that are not part of an intentional component inventory.
5. Remove root `chess.js` if no benchmark or planned example uses it.
6. Remove optimizer package dependency on `superobjective` if still unused.
7. Fix the brittle Acorn test import.

### Phase 2: Correct Optimization Semantics

1. Centralize candidate extraction and respect `optimize`.
2. Fix RLM candidate paths.
3. Add RLM artifact target support or document exclusion.
4. Add GEPA trace capture for default execution.
5. Add tests for candidate application changing rendered prompts.

### Phase 3: Harden Runtime Behavior

1. Fix XML fallback boolean parsing.
2. Add fallback parser tests.
3. Expose and enforce RLM `maxQueryCalls`.
4. Record fallback model calls in predict traces.
5. Add pagination to R2-backed list operations.

### Phase 4: Restructure Packages

1. Add `packages/protocol`.
2. Move trace/artifact/model-message/corpus/project JSON contracts into protocol.
3. Split Cloudflare `worker.ts` and `kernel.ts`.
4. Split dashboard mega-route.
5. Clarify the app state/storage API as separate from the core DSPy-like module API.

## File-Level Notes

### `packages/core/src/types.ts`

Strength: gives a complete view of the public model.

Problems:

- Too many concepts in one file.
- `CompiledArtifact.target.kind` excludes `"rlm"`.
- `AnyRunnable`, `AnyTarget`, `ModuleKind`, `RunTrace.targetKind`, and optimizer target kinds are not perfectly aligned.
- `MessagePart`, `FieldMap`, and `CompileOptions` are Knip-unused exported types.

Recommendation:

- Split into `model.ts`, `schema.ts`, `trace.ts`, `artifact.ts`, `runtime.ts`, `project.ts`, `rlm.ts`.
- Move JSON-compatible pieces to protocol.

### `packages/core/src/candidate.ts`

Strength: good typed signature builder and text candidate helpers.

Problems:

- `inputField()` and `outputField()` are dead public exports.
- Some candidate path helpers are duplicated elsewhere.
- `mergeCandidates()` overlaps with `utils.mergeCandidates()`.

### `packages/core/src/schema.ts`

Strength: central Zod/JSON schema derivation.

Problems:

- Exports dead helpers according to Knip.
- Duplicates path helpers.
- Imports extensionless while nearby files use `.js`.

### `packages/core/src/adapters.ts`

Strength: adapters are simple and easy to reason about.

Problems:

- XML fallback boolean bug.
- XML tag regex does not escape field names.
- XML input rendering uses raw input keys as tags.
- Duplicate alias exports should be intentionally documented or reduced.

### `packages/core/src/predict.ts`

Strength: strongest core implementation file.

Problems:

- Fallback completion calls are not recorded in trace model calls.
- `parseStructured()` does not receive the candidate; if future adapters use candidate-aware parsing, the signature is insufficient.

### `packages/core/src/program.ts`

Strength: `ctx.call()` is the right abstraction.

Problem:

- Tool execution inside programs may not apply inherited candidate/artifact to wrapped modules in all paths. Verify with tests if optimized tool descriptions or module children are meant to affect runtime behavior.

### `packages/core/src/project.ts`

Strength: explicit tools/agents/RPC/MCP project graph is a good library direction.

Problems:

- Tool and agent candidate extraction ignores `optimize`.
- Duplicate RPC handler checks cannot catch duplicate object keys after object creation.
- `surfaces` export is Knip-dead.

### `packages/core/src/rlm.ts`

Strength: act/extract split is conceptually clean, and traces include programmable steps.

Problems:

- Candidate paths need redesign.
- No `inspectPrompt()` equivalent for RLM.
- No user-settable query budget.
- Formatting is uneven enough to justify adding a formatter.

### `packages/core/src/runtime.ts`

Strength: clean runtime configuration and bridges.

Problems:

- `lazyGepaFactory` dynamically imports `@superobjective/optimizer-gepa`, but core package does not depend on it. For published core, `so.optimizers.gepa()` can fail unless the optimizer is a peer/optional dependency.
- `toAiMessages()` drops `name`, `toolName`, `toolCallId`, and metadata.
- The runtime object re-exports many DSL constructors, increasing API surface duplication.

### `packages/optimizer-gepa`

Strength: compact GEPA implementation and useful reflection model interface.

Problems:

- Default traces are synthetic.
- `"pareto"` candidate selection is not actually Pareto; it is best unexpanded by aggregate score.
- `"weighted"` aggregation is mean until weights exist.
- `sha256()` is not SHA-256; it is a custom non-cryptographic hash.
- Target and trace types exclude RLM. Fixed in the first refactor pass.
- Dependency on `superobjective` appears unused. Fixed in the first refactor pass.

### `packages/hosting`

Strength: useful structural host layer for non-core runtimes.

Problems:

- Duplicates protocol types.
- Duplicates request parsing and trace creation. Request parsing is fixed in the second refactor pass; trace creation still overlaps.
- `applyFieldOptions()` calls `.describe()` before optional/default wrapping, while core schema code comments suggest descriptions should be applied last.
- Generic dispatch and Cloudflare kernel dispatch overlap.

### `packages/cloudflare/src/runtime.ts`

Strength: clean env-binding model and useful Workers AI handle.

Problems:

- Public classes are Knip-unused internally; decide whether they are public API or implementation details.
- `BoundR2BlobStore` fallback name flows through `createR2BlobStore()`, which is misleading. Fixed in the first refactor pass.
- Core and Cloudflare AI SDK bridges differ slightly (`output: "object"` in Cloudflare bridge only).

### `packages/cloudflare/src/stores.ts`

Strength: simple memory/R2 stores and compatibility aliases.

Problems:

- Deprecated SQLite helpers still exported. Fixed in the first refactor pass.
- `createR2BlobStore()` returns memory. Fixed in the first refactor pass.
- R2 list helpers do not paginate. Fixed in the first refactor pass.

### `packages/cloudflare/src/worker.ts`

Strength: proves the whole Cloudflare deployment story can work.

Problem:

- It is doing too much. Split it before adding more features.

### `packages/cloudflare/src/kernel.ts`

Strength: kernel is the right abstraction for stateful edge execution.

Problems:

- It is too large and mixes route, persistence, runtime, and execution.
- `createKernelTraceStore().listTraces()` returns only persistence traces, while `loadTrace()` falls back to delegate. This asymmetry may surprise users.
- Route parser and error handling are duplicated with hosting.

### `packages/cloudflare/src/rlm*.ts`

Strength: ambitious and functional RLM-on-Cloudflare design.

Problems:

- Generated runner source is duplicated.
- Query budget is not user-configurable from core.
- The code needs formatter enforcement.

### `apps/cloudflare-worker`

Strength: useful live integration fixture.

Problems:

- Uses deprecated Cloudflare host aliases.
- Runtime worker also owns dashboard API routes.
- Triage fixture duplicates example triage.
- RLM probe adapters duplicate local relaxed XML logic.
- Several exports are only internal.

### `apps/dashboard`

Strength: useful operator surface over traces/artifacts.

Problems:

- Huge route file and large build chunks.
- Many unused component files/dependencies.
- Several unused server functions and response types.

## Bottom Line

The repo is on a good technical path, but the cleanup work should focus less on local style and more on contract ownership:

1. Make text-candidate optimization semantics correct.
2. Make RLM a first-class target or explicitly not one.
3. Extract a protocol layer to stop type drift.
4. Split Cloudflare worker/kernel files.
5. Configure Knip, then delete the low-risk dead code.

Once those are done, the repo will feel much closer to a clean library rather than a successful prototype with several working vertical slices.
