import {
  CreateMatchRequest,
  GameRuleError,
  JoinMatchRequest,
  pickAvailableCiv,
} from "@browserciv/shared";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { issueToken } from "../auth.js";
import { BotDriver, STRATEGIES } from "../bot-driver.js";
import { getContentPack } from "../content.js";
import { getMatch, listLobbies, putMatch } from "../match-store.js";
import { MatchRuntime } from "../runtime.js";

export async function registerMatchRoutes(app: FastifyInstance): Promise<void> {
  app.post("/matches", async (request, reply) => {
    const parsed = CreateMatchRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", issues: parsed.error.issues });
    }
    const body = parsed.data;
    const content = getContentPack();
    const matchId = nanoid(12);
    const playerId = nanoid(16);
    const seed = body.seed ?? Math.floor(Math.random() * 0x7fffffff);

    const hostCiv = content.civilizations[0];
    if (!hostCiv) return reply.code(500).send({ error: "NO_CIVS_IN_PACK" });

    const rt = new MatchRuntime({} as never, content);
    rt.applyBootstrap({
      type: "MatchCreate",
      matchId,
      hostId: playerId,
      hostName: body.hostName,
      hostCivId: hostCiv.id as unknown as string,
      contentPackId: content.manifest.id as unknown as string,
      seed,
      mapSize: body.mapSize,
      maxPlayers: body.maxPlayers,
      createdAt: new Date().toISOString(),
    });
    putMatch(rt);

    const cred = issueToken(playerId, matchId);
    return reply.send({ match: rt.summary(), credential: cred });
  });

  app.get("/matches", async () => {
    return { matches: listLobbies().map((m) => m.summary()) };
  });

  app.post<{ Params: { id: string } }>(
    "/matches/:id/join",
    async (request, reply) => {
      const matchId = request.params.id;
      const rt = getMatch(matchId);
      if (!rt) return reply.code(404).send({ error: "NOT_FOUND" });

      const parsed = JoinMatchRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "BAD_REQUEST", issues: parsed.error.issues });
      }
      const { name } = parsed.data;

      const civId = pickAvailableCiv(rt.state, rt.content);
      if (!civId) {
        return reply.code(409).send({ error: "NO_CIVS_AVAILABLE" });
      }

      const playerId = nanoid(16);
      try {
        rt.apply({ type: "PlayerJoin", playerId, name, civId });
      } catch (e) {
        if (e instanceof GameRuleError) {
          return reply.code(409).send({ error: e.code, message: e.message });
        }
        throw e;
      }
      rt.broadcastSnapshot();

      const cred = issueToken(playerId, matchId);
      return reply.send({ match: rt.summary(), credential: cred });
    },
  );

  app.get<{ Params: { id: string } }>("/matches/:id", async (request, reply) => {
    const rt = getMatch(request.params.id);
    if (!rt) return reply.code(404).send({ error: "NOT_FOUND" });
    return { match: rt.summary() };
  });

  app.post<{ Params: { id: string } }>(
    "/matches/:id/bots",
    async (request, reply) => {
      const matchId = request.params.id;
      const rt = getMatch(matchId);
      if (!rt) return reply.code(404).send({ error: "NOT_FOUND" });
      if (rt.state.status !== "lobby") {
        return reply.code(409).send({ error: "MATCH_ALREADY_STARTED" });
      }

      const body = (request.body ?? {}) as { strategy?: string };
      const strategy = typeof body.strategy === "string" ? body.strategy : "random";
      if (!STRATEGIES[strategy]) {
        return reply.code(400).send({ error: "UNKNOWN_STRATEGY", available: Object.keys(STRATEGIES) });
      }

      const civId = pickAvailableCiv(rt.state, rt.content);
      if (!civId) return reply.code(409).send({ error: "NO_CIVS_AVAILABLE" });

      const playerId = nanoid(16);
      const botName = `Bot (${strategy})`;
      try {
        rt.apply({ type: "PlayerJoin", playerId, name: botName, civId });
      } catch (e) {
        if (e instanceof GameRuleError) {
          return reply.code(409).send({ error: e.code, message: e.message });
        }
        throw e;
      }

      // Driver attaches itself to the runtime and drives turns autonomously.
      new BotDriver(rt, playerId, strategy);
      rt.broadcastSnapshot();

      return reply.send({ playerId, name: botName, strategy });
    },
  );
}
