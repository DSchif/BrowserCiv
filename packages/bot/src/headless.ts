import {
  buildView,
  getLegalIntents,
  pickAvailableCiv,
  reduce,
  type ContentPack,
  type Intent,
  type MatchState,
  type MatchView,
} from "@browserciv/shared";
/** Synchronous-only brain for use in the headless runner. */
export type SyncBrain = (view: MatchView, playerId: string) => Intent | null;

export interface HeadlessOptions {
  mapSize?: "small" | "medium" | "large";
  maxTurns?: number;
  seed?: number;
  noFog?: boolean;
}

export interface StepRecord {
  turn: number;
  playerId: string;
  view: MatchView;
  intent: Intent;
  reward: number;
}

export interface GameRecord {
  steps: StepRecord[];
  finalState: MatchState;
  winner: string | null | undefined;
  turns: number;
}

type RewardFn = (prev: MatchView, next: MatchView, playerId: string) => number;

/**
 * Convert an Intent to a full Action and apply it directly to a MatchState.
 * This mirrors runtime.applyIntent() but runs without a server or WS.
 */
function applyIntent(state: MatchState, playerId: string, intent: Intent, content: ContentPack): MatchState {
  const now = new Date().toISOString();
  switch (intent.type) {
    case "MatchStart":
      return reduce(state, { type: "MatchStart", actorId: playerId, startedAt: now, noFog: intent.noFog }, content);
    case "EndTurn":
      return reduce(state, { type: "EndTurn", actorId: playerId }, content);
    case "MoveUnit":
      return reduce(state, { type: "MoveUnit", actorId: playerId, unitId: intent.unitId, target: intent.target, attackId: intent.attackId }, content);
    case "FoundCity":
      return reduce(state, { type: "FoundCity", actorId: playerId, unitId: intent.unitId }, content);
    case "SetCityProduction":
      return reduce(state, { type: "SetCityProduction", actorId: playerId, cityId: intent.cityId, item: intent.item }, content);
    case "SetResearch":
      return reduce(state, { type: "SetResearch", actorId: playerId, techId: intent.techId }, content);
    case "UpgradeUnit":
      return reduce(state, { type: "UpgradeUnit", actorId: playerId, unitId: intent.unitId }, content);
    case "BuildImprovement":
      return reduce(state, { type: "BuildImprovement", actorId: playerId, unitId: intent.unitId, improvementId: intent.improvementId }, content);
    case "Fortify":
      return reduce(state, { type: "Fortify", actorId: playerId, unitId: intent.unitId }, content);
    case "RangedAttack":
      return reduce(state, { type: "RangedAttack", actorId: playerId, unitId: intent.unitId, targetUnitId: intent.targetUnitId, attackId: intent.attackId }, content);
    case "DeclareWar":
      return reduce(state, { type: "DeclareWar", actorId: playerId, targetPlayerId: intent.targetPlayerId }, content);
    case "MakePeace":
      return reduce(state, { type: "MakePeace", actorId: playerId, targetPlayerId: intent.targetPlayerId }, content);
    case "BuyProduction":
      return reduce(state, { type: "BuyProduction", actorId: playerId, cityId: intent.cityId }, content);
    case "CityRangedAttack":
      return reduce(state, { type: "CityRangedAttack", actorId: playerId, cityId: intent.cityId, targetUnitId: intent.targetUnitId, attackId: intent.attackId }, content);
    case "BoardShip":
      return reduce(state, { type: "BoardShip", actorId: playerId, unitId: intent.unitId, shipId: intent.shipId }, content);
    case "Disembark":
      return reduce(state, { type: "Disembark", actorId: playerId, shipId: intent.shipId, unitId: intent.unitId, target: intent.target }, content);
    default:
      throw new Error(`Unknown intent type: ${(intent as Intent).type}`);
  }
}

/**
 * Run a complete game entirely in memory — no server, no WebSocket, no UI.
 * Returns a record of every (view, intent, reward) step for training.
 *
 * `brains` maps playerId → Brain.  Players are created in order and assigned
 * civs automatically.  You must pass exactly the right number of brains.
 *
 * Example: runHeadlessGame({ p1: greedyBrain, p2: passiveBrain }, content)
 */
export function runHeadlessGame(
  brains: Record<string, SyncBrain>,
  content: ContentPack,
  rewardFn: RewardFn,
  opts: HeadlessOptions = {},
): GameRecord {
  const { mapSize = "small", maxTurns = 150, seed, noFog = true } = opts;
  const playerIds = Object.keys(brains);
  if (playerIds.length < 2) throw new Error("need at least 2 brains");

  const now = new Date().toISOString();
  const seed_ = seed ?? Math.floor(Math.random() * 0x7fffffff);

  // ── Bootstrap match ──────────────────────────────────────────────────────
  let state = reduce(null, {
    type: "MatchCreate",
    matchId: `headless-${seed_}`,
    hostId: playerIds[0]!,
    hostName: playerIds[0]!,
    hostCivId: content.civilizations[0]!.id as unknown as string,
    contentPackId: content.manifest.id as unknown as string,
    seed: seed_,
    mapSize,
    maxPlayers: playerIds.length,
    createdAt: now,
  }, content)!;

  for (let i = 1; i < playerIds.length; i++) {
    const civId = pickAvailableCiv(state, content);
    if (!civId) throw new Error("ran out of civs");
    state = reduce(state, {
      type: "PlayerJoin",
      playerId: playerIds[i]!,
      name: playerIds[i]!,
      civId,
    }, content)!;
  }

  state = reduce(state, {
    type: "MatchStart",
    actorId: playerIds[0]!,
    startedAt: now,
    noFog,
  }, content)!;

  // ── Main game loop ────────────────────────────────────────────────────────
  const steps: StepRecord[] = [];

  while (state.status === "in_progress" && state.turnNumber <= maxTurns) {
    const player = state.players[state.currentPlayerIndex];
    if (!player) break;
    const brain = brains[player.id];
    if (!brain) break;

    // Drive one player's turn: keep calling brain until EndTurn or null
    for (let actionLimit = 0; actionLimit < 500; actionLimit++) {
      const view = buildView(state, player.id, content);
      const legal = getLegalIntents(view, player.id, content);
      if (legal.length === 0) break;

      const intentOrPromise = brain(view, player.id);
      const intent: Intent | null = intentOrPromise instanceof Promise ? null : intentOrPromise;
      if (!intent) break;

      const prevView = view;
      try {
        state = applyIntent(state, player.id, intent, content);
      } catch {
        // Illegal intent — force end turn
        state = reduce(state, { type: "EndTurn", actorId: player.id }, content)!;
        break;
      }

      const nextView = buildView(state, player.id, content);
      const reward = rewardFn(prevView, nextView, player.id);
      steps.push({ turn: state.turnNumber, playerId: player.id, view: prevView, intent, reward });

      if (intent.type === "EndTurn") break;
      if (state.status !== "in_progress") break;
    }
  }

  return {
    steps,
    finalState: state,
    winner: state.winnerId,
    turns: state.turnNumber,
  };
}
