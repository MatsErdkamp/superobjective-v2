# Superobjective v0.1

TypeScript-first DSPy-like programming for explicit, typed, optimizable LLM systems.

This repository is organized as a pnpm workspace and now uses Vite+ for the
repo-level developer workflow:

- `packages/core` -> `superobjective`
- `packages/hosting` -> `@superobjective/hosting`
- `packages/optimizer-gepa` -> `@superobjective/optimizer-gepa`
- `packages/cloudflare` -> `@superobjective/cloudflare`

The implementation follows [`SPEC.md`](./SPEC.md), with these core ideas:

- `Signature` is the semantic source of truth.
- Adapters render prompts and derive structured-output schemas.
- Structured output enforcement goes through an AI SDK bridge.
- GEPA optimizes only explicit `TextCandidate` string values.
- Cloudflare hosting is an optional package over an explicit project graph.

## Workspace

```bash
vp install
vp check
vp test
vp run build
```

Root scripts that still matter:

```bash
vp run dev:cloudflare
vp run dev:dashboard
vp run deploy:cloudflare
vp run test:cloudflare-live
vp run types:cloudflare
vp run types:dashboard
```

## Core API shape

```ts
import { z } from "zod";
import { so } from "superobjective";

const TriageTicket = so
  .signature("triage_ticket")
  .withInstructions("Classify a support ticket for human routing.", {
    optimize: true,
  })
  .withInput("subject", z.string(), {
    description: "The ticket subject line.",
    optimize: true,
  })
  .withInput("body", z.string(), {
    description: "The user-written ticket body.",
    optimize: true,
  })
  .withOutput("category", z.enum(["billing", "technical", "account", "other"]), {
    description: "The support queue that should handle the request.",
    optimize: true,
  })
  .build();

const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
});
```

## Cloudflare worker

The live worker entrypoint is [`wrangler.jsonc`](./wrangler.jsonc), which serves
[`apps/cloudflare-worker/src/worker.ts`](./apps/cloudflare-worker/src/worker.ts).

That worker hosts the current Superobjective project graph on Cloudflare and
backs the dashboard surfaces for:

- agents
- RPC routes
- MCP surfaces
- traces and compiled artifacts

Run it locally with:

```bash
vp run types:cloudflare
vp run dev:cloudflare
```

## Dashboard

There is also a TanStack Start operator dashboard at
[`apps/dashboard`](./apps/dashboard/README.md).

It runs as its own Cloudflare-targeted Worker app and uses server functions to:

- read the current Superobjective project graph
- invoke the existing Cloudflare worker surfaces
- display traces and compiled artifacts from the current prototype stores

Run it with:

```bash
vp run types:dashboard
vp run dev:dashboard
```

## Optimization fixture

There is no full CLI demo in the repo anymore. The remaining files under
[`examples/superobjective-demo`](./examples/superobjective-demo) are a minimal
triage fixture used by [`scripts/compile-triage.ts`](./scripts/compile-triage.ts)
for manual GEPA artifact generation.

## Status

This is a v0.1 prototype implementation. The public API is intentionally explicit and TypeScript-first; some production integrations are thin adapters around the core runtime rather than fully managed frameworks.
