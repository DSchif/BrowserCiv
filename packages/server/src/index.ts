import cors from "@fastify/cors";
import httpProxy from "@fastify/http-proxy";
import fastifyJwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import { allTokens, loadTokensIntoMap, setTokenChangeListener } from "./auth.js";
import { loadContentPack } from "./content.js";
import { putMatch } from "./match-store.js";
import {
  loadAllMatches,
  loadTokens,
  persistMatch,
  persistTokens,
} from "./persistence.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { setApplyListener } from "./runtime.js";
import { registerWsRoutes } from "./ws.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
});

app.decorate("authenticate", async function (request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  }
});

const content = await loadContentPack();
app.log.info(
  `loaded content pack ${content.manifest.id}@${content.manifest.version} — ` +
    `${content.civilizations.length} civs, ${content.units.length} units, ` +
    `${content.terrains.length} terrains`,
);

// Restore matches + tokens from disk before serving.
const restoredMatches = await loadAllMatches(content);
for (const rt of restoredMatches) putMatch(rt);
const restoredTokens = await loadTokens();
loadTokensIntoMap(restoredTokens);
if (restoredMatches.length || restoredTokens.length) {
  app.log.info(
    `restored ${restoredMatches.length} match(es) and ${restoredTokens.length} token(s) from disk`,
  );
}

// Persist on every apply / token mutation.
setApplyListener((rt) => {
  void persistMatch(rt);
});
setTokenChangeListener(() => {
  void persistTokens(allTokens());
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/content-pack", async () => content);

await registerAccountRoutes(app);
await registerMatchRoutes(app);
await registerWsRoutes(app);

const SIM_SERVER_URL = process.env.SIM_SERVER_URL;
if (SIM_SERVER_URL) {
  // Sim routes require auth except SSE event streams (EventSource can't set headers).
  const requireAuthUnlessEvents = async (
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    if (request.url.endsWith("/events")) return;
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  };

  for (const prefix of ["/sim", "/agents", "/runs"]) {
    await app.register(httpProxy, {
      upstream: SIM_SERVER_URL,
      prefix,
      rewritePrefix: prefix,
      preHandler: requireAuthUnlessEvents,
    });
  }
  app.log.info(`sim-server proxy → ${SIM_SERVER_URL}`);
}

// In production we ship the built SPA inside the same image and serve it
// from CLIENT_DIST. With no env var set, the JSON fallback below answers /
// so dev (vite serves the SPA) still works unchanged.
const CLIENT_DIST = process.env.CLIENT_DIST;
if (CLIENT_DIST && fs.existsSync(CLIENT_DIST)) {
  await app.register(fastifyStatic, {
    root: path.resolve(CLIENT_DIST),
    wildcard: false,
  });
  // SPA fallback: any non-API path gets index.html so client-side routing works.
  const API_PREFIXES = ["/matches", "/health", "/content-pack", "/ws", "/account", "/train", "/sim", "/agents", "/runs"];
  app.setNotFoundHandler((req, reply) => {
    if (API_PREFIXES.some((p) => req.url === p || req.url.startsWith(p + "/"))) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
  app.log.info(`serving SPA from ${CLIENT_DIST}`);
} else {
  app.get("/", async () => ({
    name: "browserciv-server",
    pack: content.manifest.id,
  }));
}

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
