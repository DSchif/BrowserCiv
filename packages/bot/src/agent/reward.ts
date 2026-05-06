import type { MatchView } from "@browserciv/shared";
import type { RewardEntry } from "./agent-config.js";

export type RewardFn = (prev: MatchView, next: MatchView, playerId: string) => number;

/**
 * City + unit maximisation reward.
 *
 * Each new city is worth 5 points; each new unit is worth 1 point.
 * A small per-step penalty (-0.02) encourages the agent to move quickly
 * rather than idling.
 */
export const cityAndUnitReward: RewardFn = (
  prev: MatchView,
  next: MatchView,
  playerId: string,
): number => {
  const prevCities = prev.cities.filter((c) => c.ownerId === playerId).length;
  const nextCities = next.cities.filter((c) => c.ownerId === playerId).length;
  const prevUnits = prev.units.filter((u) => u.ownerId === playerId).length;
  const nextUnits = next.units.filter((u) => u.ownerId === playerId).length;

  return (nextCities - prevCities) * 5 + (nextUnits - prevUnits) * 1 - 0.02;
};

/** Sparse terminal reward: +100 for winning, -100 for losing, 0 draw. */
export const winLoseReward: RewardFn = (
  _prev: MatchView,
  next: MatchView,
  playerId: string,
): number => {
  if (next.status !== "finished") return 0;
  if (next.winnerId === playerId) return 100;
  if (next.winnerId === null) return 0;
  return -100;
};

/** Combine two reward functions (sum). */
export function combineRewards(...fns: RewardFn[]): RewardFn {
  return (prev, next, playerId) =>
    fns.reduce((sum, fn) => sum + fn(prev, next, playerId), 0);
}

/**
 * Build a configurable reward function from a list of (signal, weight) entries.
 * Each named signal is computed and multiplied by its weight; the results are summed.
 */
export function buildRewardFn(entries: RewardEntry[]): RewardFn {
  return (prev: MatchView, next: MatchView, playerId: string): number => {
    let total = 0;
    for (const entry of entries) {
      let value = 0;
      switch (entry.signal) {
        case "cities_owned_delta": {
          value = next.cities.filter((c) => c.ownerId === playerId).length
                - prev.cities.filter((c) => c.ownerId === playerId).length;
          break;
        }
        case "units_owned_delta": {
          value = next.units.filter((u) => u.ownerId === playerId).length
                - prev.units.filter((u) => u.ownerId === playerId).length;
          break;
        }
        case "tiles_discovered_delta": {
          const prevSeen = prev.map?.tiles.filter((t) => t.visibility !== "unseen").length ?? 0;
          const nextSeen = next.map?.tiles.filter((t) => t.visibility !== "unseen").length ?? 0;
          value = nextSeen - prevSeen;
          break;
        }
        case "enemy_units_killed": {
          const prevEnemyIds = new Set(
            prev.units.filter((u) => u.ownerId !== playerId).map((u) => u.id),
          );
          const nextEnemyIds = new Set(
            next.units.filter((u) => u.ownerId !== playerId).map((u) => u.id),
          );
          for (const id of prevEnemyIds) {
            if (!nextEnemyIds.has(id)) value++;
          }
          break;
        }
        case "hp_damage_dealt": {
          const prevHpMap = new Map(
            prev.units.filter((u) => u.ownerId !== playerId).map((u) => [u.id, u.hp]),
          );
          for (const unit of next.units.filter((u) => u.ownerId !== playerId)) {
            const prevHp = prevHpMap.get(unit.id);
            if (prevHp !== undefined) value += Math.max(0, prevHp - unit.hp);
          }
          break;
        }
        case "turn_survived": {
          value = 1;
          break;
        }
        case "win": {
          value = next.status === "finished" && next.winnerId === playerId ? 1 : 0;
          break;
        }
        case "lose": {
          value = next.status === "finished"
            && next.winnerId !== null
            && next.winnerId !== undefined
            && next.winnerId !== playerId ? -1 : 0;
          break;
        }
      }
      total += value * entry.weight;
    }
    return total;
  };
}
