import { Hex, type Intent, type MatchView } from "@browserciv/shared";
import type { Brain } from "../brain.js";

const LAND_TERRAINS = new Set([
  "grassland", "plains", "hills", "forest", "jungle",
  "desert", "tundra", "snow", "mountain",
]);

function pick<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Reference brain: makes random but legal moves.
 * - Moves units to random passable neighbours
 * - Founds cities with settlers (random chance each turn)
 * - Sets production and research to first available option
 * - Ends turn
 */
export const randomBrain: Brain = (state: MatchView, playerId: string): Intent | null => {
  const myUnits = state.units.filter((u) => u.ownerId === playerId && u.movementLeft > 0);
  const tiles = new Map((state.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]));
  const occupiedKeys = new Set(state.units.map((u) => `${u.position.q},${u.position.r}`));
  const cityKeys = new Set(state.cities.map((c) => `${c.position.q},${c.position.r}`));

  // Try to found city with a settler (50% chance each call so it sometimes moves first)
  if (Math.random() < 0.5) {
    const settler = myUnits.find((u) => u.defId === "unit.settler");
    if (settler) {
      const key = `${settler.position.q},${settler.position.r}`;
      if (!cityKeys.has(key)) {
        return { type: "FoundCity", actorId: playerId, unitId: settler.id };
      }
    }
  }

  // Move a random unit to a random passable neighbour
  const movableUnits = myUnits.filter((u) => u.defId !== "unit.settler" || Math.random() < 0.3);
  const unit = pick(movableUnits) ?? pick(myUnits);
  if (unit) {
    const neighbours = Hex.neighbors(unit.position);
    const candidates = neighbours.filter((n) => {
      const k = `${n.q},${n.r}`;
      const tile = tiles.get(k);
      if (!tile) return false;
      if (occupiedKeys.has(k)) return false;
      // Settlers and workers avoid water; warriors/scouts can't enter ocean
      if (unit.defId === "unit.settler" || unit.defId === "unit.worker") {
        return LAND_TERRAINS.has(tile.terrain) && tile.terrain !== "mountain";
      }
      return LAND_TERRAINS.has(tile.terrain);
    });
    const target = pick(candidates);
    if (target) {
      return { type: "MoveUnit", actorId: playerId, unitId: unit.id, target };
    }
  }

  // Set city production if any city is idle
  const idleCity = state.cities.find(
    (c) => c.ownerId === playerId && !c.productionItem,
  );
  if (idleCity) {
    return {
      type: "SetCityProduction",
      actorId: playerId,
      cityId: idleCity.id,
      item: { kind: "unit", defId: "unit.worker" },
    };
  }

  // Set research if none active
  const me = state.players.find((p) => p.id === playerId);
  if (me && !me.currentTech) {
    return { type: "SetResearch", actorId: playerId, techId: "tech.bronze_working" };
  }

  return { type: "EndTurn", actorId: playerId };
};
