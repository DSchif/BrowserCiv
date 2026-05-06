import {
  ClientMessage,
  GameRuleError,
  type ServerMessage,
} from "@browserciv/shared";
import type { FastifyInstance } from "fastify";
import { lookupToken } from "./auth.js";
import { getMatch } from "./match-store.js";
import type { WsLike } from "./runtime.js";

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WsLike & {
    on: (ev: "message" | "close", cb: (raw?: unknown) => void) => void;
    close: () => void;
  }, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const cred = token ? lookupToken(token) : null;
    if (!cred) {
      sendError(socket, "AUTH_FAILED", "missing or invalid token");
      socket.close();
      return;
    }

    const rt = getMatch(cred.matchId);
    if (!rt) {
      sendError(socket, "NOT_FOUND", "match not found");
      socket.close();
      return;
    }

    // Spectators get full-visibility snapshots and cannot send intents.
    if (cred.spectator) {
      const detach = rt.attachSpectator(socket);
      socket.on("message", (raw: unknown) => {
        const parsed = JSON.parse(String(raw)) as { type?: string };
        if (parsed?.type === "Hello") rt.sendSpectatorSnapshot(socket);
      });
      socket.on("close", () => detach());
      return;
    }

    const detach = rt.attach(cred.playerId, socket);

    socket.on("message", (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        sendError(socket, "BAD_JSON", "could not parse message");
        return;
      }
      const msg = ClientMessage.safeParse(parsed);
      if (!msg.success) {
        sendError(socket, "BAD_MESSAGE", msg.error.message);
        return;
      }
      const m = msg.data;

      switch (m.type) {
        case "Hello":
          rt.sendSnapshot(socket, cred.playerId);
          return;
        case "Ping":
          rt.send(socket, { type: "Pong", ts: m.ts });
          return;
        case "Intent":
          try {
            rt.applyIntent(cred.playerId, m.intent);
            rt.send(socket, {
              type: "IntentAck",
              clientSeq: m.clientSeq,
              actionSeq: rt.state.actionSeq,
            });
            rt.broadcastSnapshot();
          } catch (e) {
            const code = e instanceof GameRuleError ? e.code : "INTERNAL";
            const message = e instanceof Error ? e.message : "unknown";
            rt.send(socket, {
              type: "IntentReject",
              clientSeq: m.clientSeq,
              code,
              message,
            });
          }
          return;
      }
    });

    socket.on("close", () => detach());
  });
}

function sendError(socket: WsLike, code: string, message: string): void {
  const msg: ServerMessage = { type: "Error", code, message };
  socket.send(JSON.stringify(msg));
}
