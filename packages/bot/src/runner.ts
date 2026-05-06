import WebSocket from "ws";
import type { Intent, MatchView } from "@browserciv/shared";
import type { Brain } from "./brain.js";
import { Logger } from "./logger.js";

export interface RunnerOptions {
  serverUrl: string;
  matchId: string;
  playerId: string;
  token: string;
  brain: Brain;
  /** If set, log (state, intent, reward) lines to this file. */
  logPath?: string;
  /** Episode number written to the log (useful when running many games). */
  episode?: number;
  verbose?: boolean;
}

interface WireMessage {
  type: string;
  [k: string]: unknown;
}

function wsUrl(serverUrl: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.searchParams.set("token", token);
  return u.toString();
}

/**
 * Connects to the game server as a bot player, drives turns using the
 * supplied brain, and optionally logs training data.
 *
 * Resolves when the match finishes (status === "finished") or the WS closes.
 */
export async function runBot(opts: RunnerOptions): Promise<void> {
  const log = opts.verbose
    ? (...args: unknown[]) => console.log("[bot]", ...args)
    : () => undefined;

  const logger = opts.logPath
    ? new Logger(opts.logPath, opts.episode ?? 0, opts.playerId)
    : null;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(opts.serverUrl, opts.token));
    let clientSeq = 1;
    let latestState: MatchView | null = null;
    let busy = false; // prevent overlapping brain calls

    function send(msg: WireMessage): void {
      ws.send(JSON.stringify(msg));
    }

    function isMyTurn(state: MatchView): boolean {
      return (
        state.status === "in_progress" &&
        state.players[state.currentPlayerIndex]?.id === opts.playerId
      );
    }

    async function takeTurn(state: MatchView): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        // Keep calling the brain until it returns EndTurn or null.
        // null means "I have nothing to do right now; wait for next snapshot."
        let intent: Intent | null = await opts.brain(state, opts.playerId);
        while (intent !== null) {
          log(`sending intent: ${intent.type}`);
          logger?.log(state, intent);
          const seq = clientSeq++;
          send({ type: "Intent", clientSeq: seq, intent });
          if (intent.type === "EndTurn") break;
          // Wait for the ack / next snapshot before continuing.
          // We pause here and let the message handler call takeTurn again.
          break;
        }
      } finally {
        busy = false;
      }
    }

    ws.on("open", () => {
      log(`connected, joining match ${opts.matchId}`);
      send({ type: "Hello", matchId: opts.matchId, playerId: opts.playerId, lastSeq: 0 });
    });

    ws.on("message", (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(String(raw)) as WireMessage;
      } catch {
        return;
      }

      if (msg.type === "Snapshot") {
        const state = msg.state as MatchView;
        latestState = state;
        log(`snapshot received — turn ${state.turnNumber}, status=${state.status}`);

        if (state.status === "finished") {
          const winner = state.players.find((p) => p.id === state.winnerId);
          log(`match finished — winner: ${winner?.name ?? "none"}`);
          ws.close();
          resolve();
          return;
        }

        if (isMyTurn(state)) {
          void takeTurn(state);
        }
      }

      if (msg.type === "IntentAck") {
        // After ack, call brain again with the latest state in case more moves remain.
        if (latestState && isMyTurn(latestState)) {
          void takeTurn(latestState);
        }
      }

      if (msg.type === "IntentReject") {
        console.warn(`[bot] intent rejected: ${msg.code} — ${msg.message}`);
        // On rejection, still try to end the turn to avoid getting stuck.
        if (latestState && isMyTurn(latestState)) {
          send({ type: "Intent", clientSeq: clientSeq++, intent: { type: "EndTurn", actorId: opts.playerId } });
        }
      }

      if (msg.type === "Error") {
        console.error(`[bot] server error: ${msg.code} — ${msg.message}`);
      }
    });

    ws.on("close", () => {
      log("connection closed");
      resolve();
    });

    ws.on("error", (err) => {
      reject(err);
    });
  });
}
