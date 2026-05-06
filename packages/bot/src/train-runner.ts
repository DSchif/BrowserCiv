import WebSocket from "ws";
import type { Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import type { ContentPack } from "@browserciv/shared";
import { makeTransition } from "./agent/q-agent.js";
import type { QAgent } from "./agent/q-agent.js";
import type { RewardFn } from "./agent/reward.js";

export interface EpisodeResult {
  agentReward: number;
  agentSteps: number;
  turns: number;
  winner: string | null | undefined;
}

function wsUrl(serverUrl: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.searchParams.set("token", token);
  return u.toString();
}

/**
 * Plays one training episode via WebSocket, updating the Q-agent online.
 *
 * For each action taken:
 *   - Records (prevView, intent)
 *   - When the next Snapshot arrives, completes the transition with reward and nextView
 *   - Calls agent.update() immediately (online TD learning)
 *
 * Returns after the match finishes. Caller should call agent.endEpisode() for ε decay.
 */
export async function runTrainingEpisode(opts: {
  serverUrl: string;
  matchId: string;
  agentToken: string;
  playerId: string;
  agent: QAgent;
  content: ContentPack;
  rewardFn: RewardFn;
  verbose?: boolean;
}): Promise<EpisodeResult> {
  const { serverUrl, matchId, agentToken, playerId, agent, content, rewardFn, verbose } = opts;
  const log = verbose
    ? (...args: unknown[]) => console.log("[train-runner]", ...args)
    : () => undefined;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(serverUrl, agentToken));
    let clientSeq = 1;
    let pendingPrev: MatchView | null = null;
    let pendingIntent: Intent | null = null;
    let agentReward = 0;
    let agentSteps = 0;
    let settled = false;

    function finish(result: EpisodeResult): void {
      if (settled) return;
      settled = true;
      ws.close();
      resolve(result);
    }

    function send(msg: object): void {
      ws.send(JSON.stringify(msg));
    }

    function isMyTurn(state: MatchView): boolean {
      return (
        state.status === "in_progress" &&
        state.players[state.currentPlayerIndex]?.id === playerId
      );
    }

    /** Complete the pending (prevView, intent) → (reward, nextView) transition. */
    function completeTransition(nextView: MatchView | null): void {
      if (!pendingPrev || !pendingIntent) return;
      const safeNext = nextView ?? pendingPrev; // fallback for reward calc
      const reward = rewardFn(pendingPrev, safeNext, playerId);
      const transition = makeTransition(
        pendingPrev,
        playerId,
        pendingIntent,
        reward,
        nextView,
        content,
      );
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
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "Snapshot") {
        const state = msg.state as MatchView;
        log(`turn=${state.turnNumber} status=${state.status} myTurn=${isMyTurn(state)}`);

        // Complete pending transition now that we have the next state
        if (pendingPrev && pendingIntent) {
          completeTransition(state.status === "finished" ? null : state);
        }

        if (state.status === "finished") {
          finish({
            agentReward,
            agentSteps,
            turns: state.turnNumber,
            winner: state.winnerId ?? null,
          });
          return;
        }

        if (isMyTurn(state)) {
          const legal = getLegalIntents(state, playerId, content);
          if (legal.length === 0) return;
          const intent = agent.selectIntent(legal, state, playerId, true /* training */);
          pendingPrev = state;
          pendingIntent = intent;
          send({ type: "Intent", clientSeq: clientSeq++, intent });
        }
      }

      if (msg.type === "IntentReject") {
        if (settled) return;
        log(`intent rejected: ${msg.code}`);
        pendingPrev = null;
        pendingIntent = null;
        // NOT_YOUR_TURN means we're out of sync — sending EndTurn would also be
        // rejected, causing an infinite loop.  Just wait for the next snapshot.
        if (msg.code !== "NOT_YOUR_TURN") {
          send({
            type: "Intent",
            clientSeq: clientSeq++,
            intent: { type: "EndTurn", actorId: playerId },
          });
        }
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
