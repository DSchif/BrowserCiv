import type { MatchView } from "@browserciv/shared";
import type { HierRewardEntry, HierRewardSignal } from "./config.js";

export type HierRewardFn = (
  prev: MatchView,
  next: MatchView,
  playerId: string,
) => number;

function computeSignal(
  signal: HierRewardSignal,
  prev: MatchView,
  next: MatchView,
  playerId: string,
): number {
  switch (signal) {
    case "cities_owned_delta": {
      const prevCount = prev.cities.filter((c) => c.ownerId === playerId).length;
      const nextCount = next.cities.filter((c) => c.ownerId === playerId).length;
      return nextCount - prevCount;
    }
    case "units_owned_delta": {
      const prevCount = prev.units.filter((u) => u.ownerId === playerId).length;
      const nextCount = next.units.filter((u) => u.ownerId === playerId).length;
      return nextCount - prevCount;
    }
    case "tiles_discovered_delta": {
      const prevSeen = (prev.map?.tiles ?? []).filter((t) => t.visibility !== "unseen").length;
      const nextSeen = (next.map?.tiles ?? []).filter((t) => t.visibility !== "unseen").length;
      return nextSeen - prevSeen;
    }
    case "enemy_units_killed": {
      const prevEnemy = prev.units.filter((u) => u.ownerId !== playerId).length;
      const nextEnemy = next.units.filter((u) => u.ownerId !== playerId).length;
      return Math.max(0, prevEnemy - nextEnemy);
    }
    case "hp_damage_dealt": {
      const prevHp: Record<string, number> = {};
      for (const u of prev.units) {
        if (u.ownerId !== playerId) prevHp[u.id] = u.hp;
      }
      let damage = 0;
      for (const u of next.units) {
        if (u.ownerId !== playerId && prevHp[u.id] !== undefined) {
          damage += Math.max(0, prevHp[u.id]! - u.hp);
        }
      }
      return damage;
    }
    case "turn_survived":
      return next.turnNumber > prev.turnNumber ? 1 : 0;
    case "win":
      return next.winnerId === playerId ? 1 : 0;
    case "lose":
      return next.winnerId !== undefined && next.winnerId !== playerId ? 1 : 0;
    case "tech_researched": {
      const prevTechs = prev.players.find((p) => p.id === playerId)?.researchedTechs.length ?? 0;
      const nextTechs = next.players.find((p) => p.id === playerId)?.researchedTechs.length ?? 0;
      return Math.max(0, nextTechs - prevTechs);
    }
    case "improvement_built": {
      const prevImps = (prev.map?.tiles ?? []).filter((t) => t.improvement).length;
      const nextImps = (next.map?.tiles ?? []).filter((t) => t.improvement).length;
      return Math.max(0, nextImps - prevImps);
    }
    case "city_grew": {
      const prevPop: Record<string, number> = {};
      for (const c of prev.cities) {
        if (c.ownerId === playerId) prevPop[c.id] = c.population;
      }
      let grew = 0;
      for (const c of next.cities) {
        if (c.ownerId === playerId && prevPop[c.id] !== undefined) {
          if (c.population > prevPop[c.id]!) grew++;
        }
      }
      return grew;
    }
    case "gold_per_turn_delta": {
      const prevGold = prev.cities
        .filter((c) => c.ownerId === playerId)
        .reduce((s, c) => s + (c.perTurnYields.gold ?? 0), 0);
      const nextGold = next.cities
        .filter((c) => c.ownerId === playerId)
        .reduce((s, c) => s + (c.perTurnYields.gold ?? 0), 0);
      return nextGold - prevGold;
    }
    case "gold_delta": {
      const prevGold = prev.players.find((p) => p.id === playerId)?.gold ?? 0;
      const nextGold = next.players.find((p) => p.id === playerId)?.gold ?? 0;
      return nextGold - prevGold;
    }
  }
}

export function buildHierRewardFn(entries: HierRewardEntry[]): HierRewardFn {
  return (prev, next, playerId) => {
    let total = 0;
    for (const { signal, weight } of entries) {
      total += weight * computeSignal(signal, prev, next, playerId);
    }
    return total;
  };
}
