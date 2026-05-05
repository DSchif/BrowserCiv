# Single-stage build: monorepo install, build the SPA, run the server. The
# server serves both the API and the built SPA from the same origin so the
# ALB only needs one listener and there's no mixed-content / CORS dance.
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

WORKDIR /app

# Install dependencies first so this layer is cached when only source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/content-validator/package.json packages/content-validator/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy sources and the content pack.
COPY packages/shared packages/shared
COPY packages/content-validator packages/content-validator
COPY packages/server packages/server
COPY packages/client packages/client
COPY content content

# Build the client SPA (production bundle) — server will serve dist/ statically.
RUN pnpm --filter @browserciv/client run build

# Server runs via tsx (no separate compile step needed).
ENV PORT=8787
ENV HOST=0.0.0.0
ENV CLIENT_DIST=/app/packages/client/dist

EXPOSE 8787

# Health endpoint at /health is the ALB target group probe.
CMD ["pnpm", "--filter", "@browserciv/server", "run", "serve"]
