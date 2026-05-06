import {
  CreateMatchRequest,
  GameRuleError,
  JoinMatchRequest,
  pickAvailableCiv,
} from "@browserciv/shared";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { issueSpectatorToken, issueToken, lookupToken } from "../auth.js";
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

  /** Issue a spectator token for any match (no player slot required). */
  app.post<{ Params: { id: string } }>(
    "/matches/:id/spectate",
    async (request, reply) => {
      const rt = getMatch(request.params.id);
      if (!rt) return reply.code(404).send({ error: "NOT_FOUND" });
      const cred = issueSpectatorToken(request.params.id);
      return reply.send({ credential: cred });
    },
  );

  /**
   * Start a match as a spectator: starts the match, assigns a bot to every
   * human player slot (so turns advance automatically), and returns a
   * spectator token so the caller can watch without participating.
   *
   * Body: { token: string, strategy?: string, noFog?: boolean }
   * `token` must be the host's player token.
   */
  app.post<{ Params: { id: string } }>(
    "/matches/:id/bot-start",
    async (request, reply) => {
      const matchId = request.params.id;
      const rt = getMatch(matchId);
      if (!rt) return reply.code(404).send({ error: "NOT_FOUND" });
      if (rt.state.status !== "lobby") {
        return reply.code(409).send({ error: "MATCH_ALREADY_STARTED" });
      }

      const body = (request.body ?? {}) as { token?: string; strategy?: string; noFog?: boolean };
      const cred = body.token ? lookupToken(body.token) : null;
      if (!cred || cred.matchId !== matchId) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      if (rt.state.hostId !== cred.playerId) {
        return reply.code(403).send({ error: "NOT_HOST" });
      }
      if (rt.state.players.length < 2) {
        return reply.code(409).send({ error: "TOO_FEW_PLAYERS" });
      }

      const strategy = typeof body.strategy === "string" && STRATEGIES[body.strategy]
        ? body.strategy
        : "passive";

      // Start the match.
      rt.apply({
        type: "MatchStart",
        actorId: cred.playerId,
        startedAt: new Date().toISOString(),
        noFog: body.noFog ?? true,
      });

      // Assign a bot driver to every player slot so turns advance automatically.
      for (const p of rt.state.players) {
        new BotDriver(rt, p.id, strategy);
      }

      rt.broadcastSnapshot();

      const spectatorCred = issueSpectatorToken(matchId);
      return reply.send({ credential: spectatorCred });
    },
  );

  /**
   * Create a ready-to-play training episode: a started 2-player match where
   * the opponent is already driven by an in-process bot.  Returns tokens for
   * the agent player and a spectator so the caller can watch in the browser.
   *
   * Body: { strategy?: string, mapSize?: string, noFog?: boolean }
   */
  app.post("/train-episode", async (request, reply) => {
    const body = (request.body ?? {}) as {
      strategy?: string;
      mapSize?: string;
      noFog?: boolean;
    };

    const content = getContentPack();
    const matchId = nanoid(12);
    const agentId = nanoid(16);
    const opponentId = nanoid(16);
    const seed = Math.floor(Math.random() * 0x7fffffff);
    const now = new Date().toISOString();
    const mapSize = (["small", "medium", "large"].includes(body.mapSize ?? "")
      ? body.mapSize
      : "small") as "small" | "medium" | "large";
    const strategy =
      typeof body.strategy === "string" && STRATEGIES[body.strategy]
        ? body.strategy
        : "random";

    const rt = new MatchRuntime({} as never, content);
    rt.applyBootstrap({
      type: "MatchCreate",
      matchId,
      hostId: agentId,
      hostName: "Agent",
      hostCivId: content.civilizations[0]!.id as unknown as string,
      contentPackId: content.manifest.id as unknown as string,
      seed,
      mapSize,
      maxPlayers: 2,
      createdAt: now,
    });

    const opponentCivId = pickAvailableCiv(rt.state, content);
    if (!opponentCivId) return reply.code(500).send({ error: "NO_CIVS" });
    rt.apply({
      type: "PlayerJoin",
      playerId: opponentId,
      name: `Bot (${strategy})`,
      civId: opponentCivId,
    });

    rt.apply({
      type: "MatchStart",
      actorId: agentId,
      startedAt: now,
      noFog: body.noFog ?? true,
    });

    new BotDriver(rt, opponentId, strategy);
    putMatch(rt);

    const agentToken = issueToken(agentId, matchId);
    const spectatorToken = issueSpectatorToken(matchId);

    return reply.send({ matchId, agentToken, spectatorToken });
  });
}
