# Dashboard

TanStack Start dashboard for Superobjective/Zupa operators.

## Run locally

```bash
vp run types:dashboard
vp run dev:dashboard
```

## What it shows

- Configured agents, programs, RPC surfaces, and MCP tools from the current project graph
- Runtime traces captured by the current Worker-backed dashboard session
- Compiled artifacts and frontier metadata as the current optimization view
- Live surface invocation against the Superobjective Cloudflare worker path

## Cloudflare bindings

- `AI`
- `SO_ARTIFACTS`

The dashboard uses server functions plus `cloudflare:workers`, so bindings stay server-only and are not exposed through isomorphic route loaders.
