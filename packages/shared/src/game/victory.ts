import type { ContentPack } from "../schemas/index.js";
import type { MatchState, VictoryReason } from "./state.js";

export const TIME_VICTORY_TURN = 500;

/** Compute a player's score (Civ V flavored). */
export function computeScore(state: MatchState, playerId: string): number {
  const cities = state.cities.filter((c) => c.ownerId === playerId);
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return 0;
  const popTotal = cities.reduce((s, c) => s + c.population, 0);
  const buildingsTotal = cities.reduce((s, c) => s + c.buildings.length, 0);
  const wondersTotal = Object.entries(state.wondersBuilt ?? {})
    .filter(([, cityId]) => cities.some((c) => c.id === cityId)).length;
  const techsTotal = me.researchedTechs.length;
  return popTotal * 5 + cities.length * 20 + buildingsTotal * 4 + wondersTotal * 50 + techsTotal * 8;
}

/**
 * Check if the match is over. Returns { winnerId, reason } if so, null otherwise.
 *
 * Domination: only one player has at least one city.
 * Time: turnNumber ≥ TIME_VICTORY_TURN → highest score wins (ties broken by lower playerId).
 */
export function checkVictory(
  state: MatchState,
  _content: ContentPack,
): { winnerId: string | null; reason: VictoryReason } | null {
  if (state.status !== "in_progress") return null;

  // Domination: first count which players still have any cities AT ALL,
  // OR have any units (a player with 0 cities + 0 units is eliminated).
  const aliveByPlayer = new Map<string, boolean>();
  for (const p of state.players) aliveByPlayer.set(p.id, false);
  for (const c of state.cities) aliveByPlayer.set(c.ownerId, true);
  // Phase-1 onlookers: also count units to give a grace period before any cities.
  for (const u of state.units) aliveByPlayer.set(u.ownerId, true);
  const aliveIds = [...aliveByPlayer.entries()]
    .filter(([, alive]) => alive)
    .map(([id]) => id);

  // Only trigger domination if SOMEONE has founded a city (otherwise turn 1 fires).
  const anyCities = state.cities.length > 0;
  if (anyCities && aliveIds.length === 1) {
    return { winnerId: aliveIds[0]!, reason: "domination" };
  }
  if (anyCities && aliveIds.length === 0) {
    return { winnerId: null, reason: "abandoned" };
  }

  // Time victory.
  if (state.turnNumber >= TIME_VICTORY_TURN) {
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const p of state.players) {
      const s = computeScore(state, p.id);
      if (s > bestScore || (s === bestScore && bestId !== null && p.id < bestId)) {
        bestScore = s;
        bestId = p.id;
      }
    }
    return { winnerId: bestId, reason: "time" };
  }

  return null;
}
