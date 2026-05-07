import WebSocket from "ws";
import type { Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import type { ContentPack } from "@browserciv/shared";
import type { HierAgent } from "./agent2/hier-agent.js";
import type { EpisodeResult } from "./train-runner.js";
import { snapTurn, type TurnSnap } from "./dump.js";

export interface StepController {
  shouldPause(): boolean;
  waitForResume(): Promise<void>;
  getDelayMs?(): number;
}

function wsUrl(serverUrl: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.searchParams.set("token", token);
  return u.toString();
}

export async function runHierTrainingEpisode(opts: {
  serverUrl: string;
  matchId: string;
  agentToken: string;
  playerId: string;
  agent: HierAgent;
  content: ContentPack;
  verbose?: boolean;
  stallTimeoutMs?: number;
  /** Pause/step control from sim-server */
  stepController?: StepController;
  /** Delay (ms) at the start of each of our turns (0 = max speed) */
  stepDelayMs?: number;
  /** Called once per unique turn with live metrics */
  onTurnSnap?: (snap: TurnSnap) => void;
  /** End episode after this many turns (0 or undefined = no limit) */
  maxTurns?: number;
}): Promise<EpisodeResult> {
  const {
    serverUrl, matchId, agentToken, playerId,
    agent, content, verbose,
    stallTimeoutMs = 3 * 60 * 1000,
    stepController,
    stepDelayMs = 0,
    onTurnSnap,
    maxTurns = 0,
  } = opts;

  const log = verbose
    ? (...args: unknown[]) => console.log("  [hier-runner]", ...args)
    : () => undefined;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(serverUrl, agentToken));
    let clientSeq = 1;
    let pendingPrev: MatchView | null = null;
    let pendingIntent: Intent | null = null;
    let agentReward = 0;
    let agentSteps = 0;
    let totalKills = 0;
    let totalCitiesCaptured = 0;
    let settled = false;
    const turnDumps = new Map<number, TurnSnap>();
    let lastSnapshotAt = Date.now();
    let lastIntentActionSeq = -1;
    let lastDelayedTurn = -1;

    const stallTimer = setInterval(() => {
      if (settled) { clearInterval(stallTimer); return; }
      const stalled = Date.now() - lastSnapshotAt;
      if (stalled > stallTimeoutMs) {
        clearInterval(stallTimer);
        console.log(`  [hier-runner] no snapshot for ${Math.round(stalled / 1000)}s — episode timed out`);
        finish({ agentReward, agentSteps, turns: 0, winner: undefined, timedOut: true, kills: totalKills, citiesCaptured: totalCitiesCaptured, dump: [...turnDumps.values()].sort((a, b) => a.turn - b.turn) });
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
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
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
      const rewardFn = agent.getCurrentRewardFn();
      const reward = rewardFn(pendingPrev, safeNext, playerId);
      agent.stepUpdate(pendingPrev, pendingIntent, reward, nextView, playerId);
      agentReward += reward;
      agentSteps++;

      // Count kills by checking whether the specific targeted unit was destroyed.
      // Avoid counting fog changes (enemy units leaving vision) as kills.
      if (pendingIntent.type === "RangedAttack" || pendingIntent.type === "CityRangedAttack") {
        const targetId = pendingIntent.targetUnitId;
        if (targetId && !safeNext.units.some((u) => u.id === targetId)) {
          totalKills++;
        }
      } else if (pendingIntent.type === "MoveUnit") {
        const t = pendingIntent.target;
        const enemy = pendingPrev.units.find(
          (u) => u.ownerId !== playerId && u.position.q === t.q && u.position.r === t.r,
        );
        if (enemy && !safeNext.units.some((u) => u.id === enemy.id)) {
          totalKills++;
        }
      }

      // Count city captures: opponent-owned cities whose ownership changed to ours.
      // Explicitly excludes FoundCity (which also increases our city count).
      const capturedCities = pendingPrev.cities.filter(
        (c) =>
          c.ownerId !== playerId &&
          safeNext.cities.some((sc) => sc.id === c.id && sc.ownerId === playerId),
      );
      totalCitiesCaptured += capturedCities.length;

      pendingPrev = null;
      pendingIntent = null;
    }

    ws.on("open", () => {
      log(`connected to match ${matchId}`);
      send({ type: "Hello", matchId, playerId, lastSeq: 0 });
    });

    ws.on("message", (raw) => {
      void (async () => {
        let msg: { type: string; state?: MatchView; [k: string]: unknown };
        try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

        if (msg.type === "Snapshot") {
          lastSnapshotAt = Date.now();
          const state = msg.state as MatchView;
          log(`turn=${state.turnNumber} status=${state.status} myTurn=${isMyTurn(state)} goal=${agent.getCurrentGoal()}`);

          // Capture turn snapshot; notify caller on first snapshot per turn
          const isNewTurn = !turnDumps.has(state.turnNumber);
          const snap = snapTurn(state, playerId, totalKills, totalCitiesCaptured);
          turnDumps.set(state.turnNumber, snap);
          if (isNewTurn && onTurnSnap) onTurnSnap(snap);

          if (pendingPrev && pendingIntent) {
            completeTransition(state.status === "finished" ? null : state);
          }

          if (state.status === "finished") {
            finish({ agentReward, agentSteps, turns: state.turnNumber, winner: state.winnerId ?? null, kills: totalKills, citiesCaptured: totalCitiesCaptured, dump: [...turnDumps.values()].sort((a, b) => a.turn - b.turn) });
            return;
          }

          if (maxTurns > 0 && state.turnNumber >= maxTurns) {
            finish({ agentReward, agentSteps, turns: state.turnNumber, winner: undefined, timedOut: true, kills: totalKills, citiesCaptured: totalCitiesCaptured, dump: [...turnDumps.values()].sort((a, b) => a.turn - b.turn) });
            return;
          }

          if (isMyTurn(state) && state.actionSeq > lastIntentActionSeq) {
            // At the start of each of our turns: apply pause/speed controls
            if (state.turnNumber !== lastDelayedTurn) {
              lastDelayedTurn = state.turnNumber;
              if (stepController?.shouldPause()) {
                await stepController.waitForResume();
              }
              const delay = stepController?.getDelayMs?.() ?? stepDelayMs;
              if (delay > 0) {
                await new Promise<void>((r) => setTimeout(r, delay));
              }
            }
            if (settled) return;

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
          lastIntentActionSeq = -1;
          if (msg.code === "NOT_YOUR_TURN") {
            send({ type: "Hello", matchId, playerId, lastSeq: 0 });
          } else {
            send({ type: "Intent", clientSeq: clientSeq++, intent: { type: "EndTurn", actorId: playerId } });
          }
        }

        if (msg.type === "Error") {
          log(`server error: ${String(msg.code)} — ${String(msg.message)}`);
        }
      })();
    });

    ws.on("close", () => {
      finish({ agentReward, agentSteps, turns: 0, winner: undefined, kills: totalKills, citiesCaptured: totalCitiesCaptured, dump: [...turnDumps.values()].sort((a, b) => a.turn - b.turn) });
    });

    ws.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}
