import { getLegalIntents, type ContentPack, type Intent, type MatchView } from "@browserciv/shared";
import type { Brain } from "../brain.js";

/**
 * Reference brain: picks uniformly at random from all legal intents.
 * Requires the content pack for terrain passability checks.
 *
 * If no content pack is provided (e.g. server-side in BotDriver), falls back
 * to the heuristic random behaviour from before getLegalIntents existed.
 */
export function makeRandomBrain(content: ContentPack): Brain {
  return (view: MatchView, playerId: string): Intent | null => {
    const legal = getLegalIntents(view, playerId, content);
    if (legal.length === 0) return null;
    return legal[Math.floor(Math.random() * legal.length)]!;
  };
}

/**
 * Heuristic random brain — no content pack needed.
 * Used by the in-process BotDriver in the server where we don't want to pass
 * content around, and as the default standalone bot strategy.
 */
import { Hex } from "@browserciv/shared";

const LAND_TERRAINS = new Set([
  "grassland", "plains", "hills", "forest", "jungle",
  "desert", "tundra", "snow", "mountain",
]);

function pick<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const randomBrain: Brain = (state: MatchView, playerId: string): Intent | null => {
  const myUnits = state.units.filter((u) => u.ownerId === playerId && u.movementLeft > 0);
  const tiles = new Map((state.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]));
  const occupiedKeys = new Set(state.units.map((u) => `${u.position.q},${u.position.r}`));
  const cityKeys = new Set(state.cities.map((c) => `${c.position.q},${c.position.r}`));

  if (Math.random() < 0.5) {
    const settler = myUnits.find((u) => u.defId === "unit.settler");
    if (settler && !cityKeys.has(`${settler.position.q},${settler.position.r}`)) {
      return { type: "FoundCity", actorId: playerId, unitId: settler.id };
    }
  }

  const unit = pick(myUnits);
  if (unit) {
    const candidates = Hex.neighbors(unit.position).filter((n) => {
      const k = `${n.q},${n.r}`;
      const tile = tiles.get(k);
      if (!tile || occupiedKeys.has(k)) return false;
      if (unit.defId === "unit.settler" || unit.defId === "unit.worker") {
        return LAND_TERRAINS.has(tile.terrain) && tile.terrain !== "mountain";
      }
      return LAND_TERRAINS.has(tile.terrain);
    });
    const target = pick(candidates);
    if (target) return { type: "MoveUnit", actorId: playerId, unitId: unit.id, target };
  }

  const idleCity = state.cities.find((c) => c.ownerId === playerId && !c.productionItem);
  if (idleCity) {
    return {
      type: "SetCityProduction",
      actorId: playerId,
      cityId: idleCity.id,
      item: { kind: "unit", defId: "unit.worker" },
    };
  }

  const me = state.players.find((p) => p.id === playerId);
  if (me && !me.currentTech) {
    return { type: "SetResearch", actorId: playerId, techId: "tech.bronze_working" };
  }

  return { type: "EndTurn", actorId: playerId };
};
