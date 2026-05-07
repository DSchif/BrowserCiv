import WebSocket from "ws";
import type { Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import type { ContentPack } from "@browserciv/shared";
import { makeTransition } from "./agent/q-agent.js";
import type { QAgent } from "./agent/q-agent.js";
import type { RewardFn } from "./agent/reward.js";

import type { TurnSnap } from "./dump.js";

export interface EpisodeResult {
  agentReward: number;
  agentSteps: number;
  turns: number;
  winner: string | null | undefined;
  timedOut?: boolean;
  kills?: number;
  citiesCaptured?: number;
  dump?: TurnSnap[];
}

function wsUrl(serverUrl: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.searchParams.set("token", token);
  return u.toString();
}

export async function runTrainingEpisode(opts: {
  serverUrl: string;
  matchId: string;
  agentToken: string;
  playerId: string;
  agent: QAgent;
  content: ContentPack;
  rewardFn: RewardFn;
  verbose?: boolean;
  /** Abort episode after this many ms with no snapshot (default: 3 min) */
  stallTimeoutMs?: number;
}): Promise<EpisodeResult> {
  const {
    serverUrl, matchId, agentToken, playerId,
    agent, content, rewardFn, verbose,
    stallTimeoutMs = 3 * 60 * 1000,
  } = opts;

  const log = verbose
    ? (...args: unknown[]) => console.log("  [runner]", ...args)
    : () => undefined;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(serverUrl, agentToken));
    let clientSeq = 1;
    let pendingPrev: MatchView | null = null;
    let pendingIntent: Intent | null = null;
    let agentReward = 0;
    let agentSteps = 0;
    let settled = false;
    let lastSnapshotAt = Date.now();
    // Track actionSeq of the state we last sent an intent for — prevents
    // duplicate intents when the server re-broadcasts the same state.
    let lastIntentActionSeq = -1;

    // ── Stall watchdog ────────────────────────────────────────────────────────
    // If no snapshot arrives for stallTimeoutMs, the game is stuck — bail out.
    const stallTimer = setInterval(() => {
      if (settled) { clearInterval(stallTimer); return; }
      const stalled = Date.now() - lastSnapshotAt;
      if (stalled > stallTimeoutMs) {
        clearInterval(stallTimer);
        console.log(`  [runner] no snapshot for ${Math.round(stalled / 1000)}s — episode timed out`);
        finish({ agentReward, agentSteps, turns: 0, winner: undefined, timedOut: true });
      }
    }, 5_000);

    function finish(result: EpisodeResult): void {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    }

    function send(msg: object): void {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore if closed */ }
    }

    function isMyTurn(state: MatchView): boolean {
      return (
        state.status === "in_progress" &&
        state.players[state.currentPlayerIndex]?.id === playerId
      );
    }

    function completeTransition(nextView: MatchView | null): void {
      if (!pendingPrev || !pendingIntent) return;
      const safeNext = nextView ?? pendingPrev;
      const reward = rewardFn(pendingPrev, safeNext, playerId);
      const transition = makeTransition(pendingPrev, playerId, pendingIntent, reward, nextView, content);
      agent.update(transition);
      agentReward += reward;
      agentSteps++;
      pendingPrev = null;
      pendingIntent = null;
    }

    ws.on("open", () => {
      log(`connected to match ${matchId}`);
      send({ type: "Hello", matchId, playerId, lastSeq: 0 });
    });

    ws.on("message", (raw) => {
      let msg: { type: string; state?: MatchView; [k: string]: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

      if (msg.type === "Snapshot") {
        lastSnapshotAt = Date.now();
        const state = msg.state as MatchView;
        log(`turn=${state.turnNumber} status=${state.status} myTurn=${isMyTurn(state)}`);

        if (pendingPrev && pendingIntent) {
          completeTransition(state.status === "finished" ? null : state);
        }

        if (state.status === "finished") {
          finish({ agentReward, agentSteps, turns: state.turnNumber, winner: state.winnerId ?? null });
          return;
        }

        if (isMyTurn(state) && state.actionSeq > lastIntentActionSeq) {
          const legal = getLegalIntents(state, playerId, content);
          if (legal.length === 0) return;
          const intent = agent.selectIntent(legal, state, playerId, true);
          pendingPrev = state;
          pendingIntent = intent;
          lastIntentActionSeq = state.actionSeq;
          send({ type: "Intent", clientSeq: clientSeq++, intent });
        }
      }

      if (msg.type === "IntentReject") {
        if (settled) return;
        log(`intent rejected: ${String(msg.code)}`);
        pendingPrev = null;
        pendingIntent = null;
        // Reset so the next snapshot can trigger a fresh intent.
        lastIntentActionSeq = -1;
        if (msg.code === "NOT_YOUR_TURN") {
          // Re-sync: the server might already be on our turn waiting for us,
          // meaning we'd deadlock waiting for a snapshot that never comes.
          // Hello always triggers a fresh snapshot of the real current state.
          send({ type: "Hello", matchId, playerId, lastSeq: 0 });
        } else {
          send({ type: "Intent", clientSeq: clientSeq++, intent: { type: "EndTurn", actorId: playerId } });
        }
      }

      if (msg.type === "Error") {
        console.log(`  [runner] server error: ${String(msg.code)} — ${String(msg.message)}`);
      }
    });

    ws.on("close", () => {
      finish({ agentReward, agentSteps, turns: 0, winner: undefined });
    });

    ws.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}
