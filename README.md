# BrowserCiv

Browser-based, turn-based 4X strategy game in the lineage of Civilization V, built for extensible civilization "packs" (real-world civs at launch; fictional packs like Avatar, Naruto, Pokemon planned).

See [SPEC.md](./SPEC.md) for the full specification.

## Stack

- **Client:** Vite + PixiJS + React, TypeScript
- **Server:** Node.js + Fastify, TypeScript
- **Shared:** Zod schemas defining the content-pack format
- **Infra:** AWS CDK (TypeScript)

## Layout

```
packages/
  shared/             # Zod schemas + shared types (the expandability core)
  content-validator/  # CLI to validate content packs
  client/             # Browser client (Pixi + React)
  server/             # Authoritative game server
  infra/              # AWS CDK app
content/
  core-realworld/     # The default content pack (real-world civs)
```

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm typecheck
pnpm validate-content
pnpm dev:client     # http://localhost:5173
pnpm dev:server     # http://localhost:8787
pnpm synth          # CDK synth (no deploy)
```

## Phase 0 status

Phase 0 (skeleton) is the current scope. See SPEC.md §11 for the roadmap.
