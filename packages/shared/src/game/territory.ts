import type { AxialCoord } from "../hex.js";
import { key as hexKey, neighbors } from "../hex.js";
import { CITY_RADIUS, cityFootprint } from "./city.js";
import type { GameMap, MatchState } from "./state.js";

/** A tile is owned by player P if any of P's cities' footprint covers it. */
export function territoryFor(
  state: MatchState,
  playerId: string,
): Set<string> {
  const owned = new Set<string>();
  if (!state.map) return owned;
  for (const c of state.cities) {
    if (c.ownerId !== playerId) continue;
    for (const k of cityFootprint(state.map, c.position)) owned.add(k);
  }
  return owned;
}

/** Map of playerId → owned hex keys. */
export function allTerritories(
  state: MatchState,
  playerIds: string[],
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const id of playerIds) out[id] = territoryFor(state, id);
  return out;
}

export interface BorderEdge {
  coord: AxialCoord;
  edgeIndex: number;
}

export function borderEdges(
  map: GameMap | null,
  owned: Set<string>,
): BorderEdge[] {
  const out: BorderEdge[] = [];
  if (!map) return out;
  for (const tile of map.tiles) {
    const here = { q: tile.q, r: tile.r };
    if (!owned.has(hexKey(here))) continue;
    const nbs = neighbors(here);
    for (let i = 0; i < nbs.length; i++) {
      const nb = nbs[i]!;
      if (!owned.has(hexKey(nb))) {
        out.push({ coord: here, edgeIndex: i });
      }
    }
  }
  return out;
}

/** Convenience: which hexes a single city covers. Used for ownership maps. */
export function cityTerritory(map: GameMap, cityPos: AxialCoord): string[] {
  return cityFootprint(map, cityPos);
}

export { CITY_RADIUS };
