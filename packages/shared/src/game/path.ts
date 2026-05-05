import type { AxialCoord } from "../hex.js";
import { distance, key as hexKey, neighbors } from "../hex.js";
import type { ContentPack, Terrain, UnitDef } from "../schemas/index.js";
import type { GameMap } from "./state.js";

export interface PathStep {
  coord: AxialCoord;
  costSoFar: number;
}

export interface PathfindResult {
  steps: PathStep[];
  totalCost: number;
}

interface Frontier {
  coord: AxialCoord;
  g: number;
  f: number;
}

export interface PathfindOptions {
  /** Per-unit terrain entry costs; 0 = impassable. Wins over terrain defaults if non-empty. */
  unitTerrainCosts?: Record<string, number>;
  /** Legacy: traits that satisfy terrain.passable_by_traits. */
  unitTraits?: string[];
}

/**
 * Returns the cost (in movement points) for `unit` to enter `terrain`. Returns
 * `null` if the unit cannot enter at all.
 */
export function entryCost(
  terrain: Terrain,
  opts: PathfindOptions,
): number | null {
  const tc = opts.unitTerrainCosts;
  if (tc && Object.keys(tc).length > 0) {
    const id = terrain.id as unknown as string;
    if (!(id in tc)) return null; // missing entry = impassable for this unit
    const c = tc[id]!;
    return c > 0 ? c : null;
  }

  // Legacy fallback: use terrain.impassable + terrain.movement_cost + traits.
  if (terrain.impassable) return null;
  if (terrain.passable_by_traits.length > 0) {
    const has = (opts.unitTraits ?? []).some((t) =>
      terrain.passable_by_traits.includes(t as never),
    );
    if (!has) return null;
  }
  return terrain.movement_cost;
}

/** Convenience: entry cost from a UnitDef. */
export function unitCanEnter(unitDef: UnitDef | undefined, terrain: Terrain): number | null {
  return entryCost(terrain, {
    unitTerrainCosts: unitDef?.terrain_costs as Record<string, number> | undefined,
    unitTraits: unitDef?.traits.map((t) => t as unknown as string),
  });
}

/** Hex A*. Returns cheapest path or null if unreachable. */
export function findPath(
  map: GameMap,
  start: AxialCoord,
  target: AxialCoord,
  content: ContentPack,
  opts: PathfindOptions = {},
): PathfindResult | null {
  if (hexKey(start) === hexKey(target))
    return { steps: [], totalCost: 0 };

  const tileIndex = buildTileIndex(map);
  const terrainIndex = buildTerrainIndex(content);

  const frontier: Frontier[] = [
    { coord: start, g: 0, f: distance(start, target) },
  ];
  const cameFrom = new Map<string, AxialCoord | null>();
  const gScore = new Map<string, number>();
  cameFrom.set(hexKey(start), null);
  gScore.set(hexKey(start), 0);

  while (frontier.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++)
      if (frontier[i]!.f < frontier[bestIdx]!.f) bestIdx = i;
    const current = frontier.splice(bestIdx, 1)[0]!;

    if (hexKey(current.coord) === hexKey(target)) {
      return reconstruct(cameFrom, gScore, target);
    }

    for (const nb of neighbors(current.coord)) {
      const tile = tileIndex.get(hexKey(nb));
      if (!tile) continue;
      const terrain = terrainIndex.get(tile.terrain);
      if (!terrain) continue;
      const cost = entryCost(terrain, opts);
      if (cost === null) continue;

      const tentativeG = current.g + cost;
      const k = hexKey(nb);
      const prevG = gScore.get(k);
      if (prevG !== undefined && tentativeG >= prevG) continue;
      cameFrom.set(k, current.coord);
      gScore.set(k, tentativeG);
      frontier.push({
        coord: nb,
        g: tentativeG,
        f: tentativeG + distance(nb, target),
      });
    }
  }
  return null;
}

function reconstruct(
  cameFrom: Map<string, AxialCoord | null>,
  gScore: Map<string, number>,
  target: AxialCoord,
): PathfindResult {
  const reverse: PathStep[] = [];
  let cur: AxialCoord | null = target;
  while (cur) {
    const k = hexKey(cur);
    const g = gScore.get(k) ?? 0;
    const prev = cameFrom.get(k) ?? null;
    if (prev !== null) {
      reverse.push({ coord: cur, costSoFar: g });
    }
    cur = prev;
  }
  reverse.reverse();
  const total = reverse.length === 0 ? 0 : reverse[reverse.length - 1]!.costSoFar;
  return { steps: reverse, totalCost: total };
}

function buildTileIndex(map: GameMap) {
  const m = new Map<string, { terrain: string }>();
  for (const t of map.tiles) m.set(hexKey({ q: t.q, r: t.r }), t);
  return m;
}

function buildTerrainIndex(content: ContentPack) {
  const m = new Map<string, Terrain>();
  for (const t of content.terrains) m.set(t.id as unknown as string, t);
  return m;
}

/** Hexes reachable from `start` whose total entry cost is ≤ `budget`. */
export function reachable(
  map: GameMap,
  start: AxialCoord,
  budget: number,
  content: ContentPack,
  opts: PathfindOptions = {},
): Map<string, number> {
  const tileIndex = buildTileIndex(map);
  const terrainIndex = buildTerrainIndex(content);

  const out = new Map<string, number>();
  out.set(hexKey(start), 0);
  const frontier: Array<{ coord: AxialCoord; cost: number }> = [
    { coord: start, cost: 0 },
  ];

  while (frontier.length > 0) {
    const cur = frontier.shift()!;
    for (const nb of neighbors(cur.coord)) {
      const tile = tileIndex.get(hexKey(nb));
      if (!tile) continue;
      const terrain = terrainIndex.get(tile.terrain);
      if (!terrain) continue;
      const cost = entryCost(terrain, opts);
      if (cost === null) continue;
      const newCost = cur.cost + cost;
      if (newCost > budget) continue;
      const k = hexKey(nb);
      const prev = out.get(k);
      if (prev !== undefined && prev <= newCost) continue;
      out.set(k, newCost);
      frontier.push({ coord: nb, cost: newCost });
    }
  }
  out.delete(hexKey(start));
  return out;
}
