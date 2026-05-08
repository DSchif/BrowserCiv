import type { AxialCoord } from "../hex.js";
import { diskCoords, key as hexKey } from "../hex.js";
import { cityFootprint } from "./city.js";
import type { GameMap, MatchState, Unit } from "./state.js";

/** Default unit sight radius. */
export const UNIT_SIGHT = 2;

/** Currently-visible tiles for the player: union of unit sight disks + city footprints. */
export function currentlyVisibleFor(state: MatchState, playerId: string): Set<string> {
  const visible = new Set<string>();
  if (!state.map) return visible;

  // Index valid tile positions once — O(tiles) — then disk lookups are O(radius²) per unit.
  const tileSet = new Set(state.map.tiles.map((t) => hexKey({ q: t.q, r: t.r })));

  const addDisk = (center: AxialCoord, radius: number) => {
    for (const coord of diskCoords(center, radius)) {
      const k = hexKey(coord);
      if (tileSet.has(k)) visible.add(k);
    }
  };

  for (const u of state.units) {
    if (u.ownerId !== playerId) continue;
    addDisk(u.position, UNIT_SIGHT);
  }
  for (const c of state.cities) {
    if (c.ownerId !== playerId) continue;
    for (const k of cityFootprint(state.map, c.position)) visible.add(k);
  }
  // Pre-game / pre-unit safety: starting hex disk is always visible.
  const me = state.players.find((p) => p.id === playerId);
  if (me?.startingHex) addDisk(me.startingHex, UNIT_SIGHT);

  return visible;
}

/** Augment `state.seenTiles[playerId]` with currently visible. */
export function rememberVisible(state: MatchState, playerId: string): MatchState {
  const vis = currentlyVisibleFor(state, playerId);
  const prev = new Set(state.seenTiles[playerId] ?? []);
  let changed = false;
  for (const k of vis) {
    if (!prev.has(k)) {
      prev.add(k);
      changed = true;
    }
  }
  if (!changed) return state;
  return {
    ...state,
    seenTiles: { ...state.seenTiles, [playerId]: [...prev].sort() },
  };
}

export function rememberVisibleAll(state: MatchState): MatchState {
  let s = state;
  for (const p of state.players) s = rememberVisible(s, p.id);
  return s;
}

export function unitsVisibleIn(units: Unit[], tiles: Set<string>): Unit[] {
  return units.filter((u) => tiles.has(hexKey(u.position)));
}

/** Convenience: hex disk centered on `c` of radius `r` (clipped to map). */
export function hexDisk(map: GameMap, c: AxialCoord, r: number): string[] {
  const tileSet = new Set(map.tiles.map((t) => hexKey({ q: t.q, r: t.r })));
  return diskCoords(c, r).map((coord) => hexKey(coord)).filter((k) => tileSet.has(k));
}
