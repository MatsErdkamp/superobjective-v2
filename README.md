# Superobjective v0.1

TypeScript-first DSPy-like programming for explicit, typed, optimizable LLM systems.

This repository is organized as a pnpm workspace and now uses Vite+ for the
repo-level developer workflow:

- `packages/core` -> `superobjective`
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
vp run build
vp test
```

## Example shape

```ts
import { z } from "zod";
import { so } from "superobjective";

const TriageTicket = so.signature({
  name: "triage_ticket",
  instructions: so.text({
    value: "Classify a support ticket for human routing.",
    optimize: true,
  }),
  input: {
    subject: so.input(z.string(), {
      description: so.text({
        value: "The ticket subject line.",
        optimize: true,
      }),
    }),
    body: so.input(z.string(), {
      description: so.text({
        value: "The user-written ticket body.",
        optimize: true,
      }),
    }),
  },
  output: {
    category: so.output(z.enum(["billing", "technical", "account", "other"]), {
      description: so.text({
        value: "The support queue that should handle the request.",
        optimize: true,
      }),
    }),
  },
});

const triageTicket = so.predict(TriageTicket, {
  adapter: so.adapters.xml(),
});
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

## Status

This is a v0.1 prototype implementation. The public API is intentionally explicit and TypeScript-first; some production integrations are thin adapters around the core runtime rather than fully managed frameworks.
