import type { AxialCoord } from "../hex.js";
import { distance, key as hexKey, neighbors } from "../hex.js";
import type { ContentPack, Yields } from "../schemas/index.js";
import type {
  City,
  GameMap,
  MatchState,
  Player,
  Tile,
  Unit,
} from "./state.js";
import { applyResearchTick } from "./tech.js";

/** Initial city footprint radius. */
export const CITY_RADIUS = 2;

/** Each population point eats this much food per turn. */
export const FOOD_PER_POP = 2;

/** Food required for first growth. Each subsequent pop costs +6 more. */
export const FOOD_TO_GROW_BASE = 10;

/** Bonus yields the city center contributes regardless of terrain. */
export const CITY_CENTER_BONUS: Yields = { food: 2, production: 1 };

/** Initial culture threshold for the first border expansion. */
export const CULTURE_TO_EXPAND_BASE = 10;
/** Each tile claimed bumps the threshold by this factor. */
export const CULTURE_THRESHOLD_RAMP = 1.5;
/** Max distance from city center a tile can be claimed via expansion. */
export const MAX_CITY_RADIUS = 5;

const ZERO_YIELDS: Yields = {};

/** Hexes within `CITY_RADIUS` of `center` that are on the map. */
export function cityFootprint(map: GameMap, center: AxialCoord): string[] {
  const out: string[] = [];
  for (const tile of map.tiles) {
    if (distance(center, { q: tile.q, r: tile.r }) <= CITY_RADIUS)
      out.push(hexKey({ q: tile.q, r: tile.r }));
  }
  return out;
}

/** Tiles workable by `city` (its owned set minus the center). */
function workableTiles(city: City): string[] {
  const center = hexKey(city.position);
  return city.ownedTiles.filter((k) => k !== center);
}

function tileYields(tile: Tile, content: ContentPack): Yields {
  const def = content.terrains.find((t) => (t.id as unknown as string) === tile.terrain);
  let y = def?.base_yields ?? ZERO_YIELDS;
  if (tile.improvement) {
    const imp = content.improvements.find((i) => (i.id as unknown as string) === tile.improvement);
    if (imp) y = addYields(y, imp.yield_bonus);
  }
  if (tile.resource) {
    const res = content.resources.find((r) => (r.id as unknown as string) === tile.resource);
    if (res) {
      const requiredImps = (res.harvested_by ?? []).map((i) => i as unknown as string);
      const harvested =
        requiredImps.length === 0 ||
        (tile.improvement !== undefined && requiredImps.includes(tile.improvement));
      if (harvested) y = addYields(y, res.yields);
    }
  }
  return y;
}

function totalYieldScore(y: Yields): number {
  return (
    (y.food ?? 0) +
    (y.production ?? 0) +
    (y.gold ?? 0) +
    (y.science ?? 0) +
    (y.culture ?? 0)
  );
}

function addYields(a: Yields, b: Yields): Yields {
  return {
    food: (a.food ?? 0) + (b.food ?? 0),
    production: (a.production ?? 0) + (b.production ?? 0),
    gold: (a.gold ?? 0) + (b.gold ?? 0),
    science: (a.science ?? 0) + (b.science ?? 0),
    culture: (a.culture ?? 0) + (b.culture ?? 0),
  };
}

function trim(y: Yields): Yields {
  const out: Yields = {};
  if (y.food) out.food = y.food;
  if (y.production) out.production = y.production;
  if (y.gold) out.gold = y.gold;
  if (y.science) out.science = y.science;
  if (y.culture) out.culture = y.culture;
  return out;
}

/**
 * For one city, choose which tiles its population works (auto-assignment) and
 * compute resulting per-turn yields.
 */
export function recomputeCity(
  map: GameMap,
  city: City,
  content: ContentPack,
  excludedTiles: Set<string>,
): { workedTiles: string[]; perTurnYields: Yields } {
  const tilesByKey = new Map(
    map.tiles.map((t) => [hexKey({ q: t.q, r: t.r }), t]),
  );

  const candidates = workableTiles(city)
    .filter((k) => !excludedTiles.has(k))
    .map((k) => ({ key: k, tile: tilesByKey.get(k)! }))
    .filter((x) => !!x.tile);

  candidates.sort((a, b) => {
    const ay = totalYieldScore(tileYields(a.tile, content));
    const by = totalYieldScore(tileYields(b.tile, content));
    if (ay !== by) return by - ay;
    const ad = distance(city.position, { q: a.tile.q, r: a.tile.r });
    const bd = distance(city.position, { q: b.tile.q, r: b.tile.r });
    return ad - bd;
  });

  const workCount = Math.min(city.population, candidates.length);
  const workedTiles = candidates.slice(0, workCount).map((c) => c.key);

  let yields: Yields = { ...CITY_CENTER_BONUS };
  for (const k of workedTiles) {
    const t = tilesByKey.get(k)!;
    yields = addYields(yields, tileYields(t, content));
  }
  for (const bId of city.buildings) {
    const def = content.buildings.find((b) => (b.id as unknown as string) === bId);
    if (def?.city_yields) yields = addYields(yields, def.city_yields);
    if (def?.maintenance_gold)
      yields = addYields(yields, { gold: -def.maintenance_gold });
  }
  // Wonders built in this city contribute their city_yields here.
  for (const wId of city.wonders ?? []) {
    const def = content.wonders.find((w) => (w.id as unknown as string) === wId);
    if (def?.city_yields) yields = addYields(yields, def.city_yields);
  }

  // Each citizen produces 1 science.
  yields = addYields(yields, { science: city.population });

  return { workedTiles, perTurnYields: trim(yields) };
}

/** Apply each wonder's empire_yields to every city of the wonder owner. */
export function applyWonderEmpireYields(
  state: MatchState,
  content: ContentPack,
): MatchState {
  if (!state.cities.length) return state;
  const cityById = new Map(state.cities.map((c) => [c.id, c]));
  const empire: Record<string, Yields> = {};
  for (const [wId, cId] of Object.entries(state.wondersBuilt ?? {})) {
    const oc = cityById.get(cId);
    if (!oc) continue;
    const def = content.wonders.find((w) => (w.id as unknown as string) === wId);
    if (!def?.empire_yields) continue;
    empire[oc.ownerId] = addYields(empire[oc.ownerId] ?? {}, def.empire_yields);
  }
  if (!Object.keys(empire).length) return state;
  const cities = state.cities.map((c) => {
    const bonus = empire[c.ownerId];
    return bonus ? { ...c, perTurnYields: trim(addYields(c.perTurnYields, bonus)) } : c;
  });
  return { ...state, cities };
}

/** Healing applied at start of `playerId`'s turn. */
export function applyHealing(state: MatchState, playerId: string): MatchState {
  const cityOwnerByCityId = new Map(state.cities.map((c) => [c.id, c.ownerId]));
  const units = state.units.map((u) => {
    if (u.ownerId !== playerId) return u;
    if (u.attackedThisTurn) return { ...u, attackedThisTurn: false };
    if (u.hp >= u.hpMax) return u;
    const k = `${u.position.q},${u.position.r}`;
    const ownerCity = state.tileOwnership[k];
    let heal = 8;
    if (ownerCity) {
      const owner = cityOwnerByCityId.get(ownerCity);
      heal = owner === playerId ? 15 : 3;
    }
    return { ...u, hp: Math.min(u.hpMax, u.hp + heal) };
  });
  return { ...state, units };
}

/** Buildable wonders for a player: tech-gated and not yet built anywhere. */
export function buildableWonders(
  content: ContentPack,
  player: Player,
  wondersBuilt: Record<string, string>,
): typeof content.wonders {
  const researched = new Set(player.researchedTechs);
  return content.wonders.filter((w) => {
    if (w.prereq_tech && !researched.has(w.prereq_tech as unknown as string)) return false;
    if (wondersBuilt[w.id as unknown as string]) return false;
    return true;
  });
}

export function recomputeAllCities(
  state: MatchState,
  content: ContentPack,
): MatchState {
  if (!state.map) return state;
  const sorted = state.cities
    .map((c, i) => ({ c, i }))
    .sort((a, b) => cityIdNum(a.c.id) - cityIdNum(b.c.id));
  const claimed = new Set<string>();
  for (const { c } of sorted) claimed.add(hexKey(c.position));
  const updated = state.cities.slice();
  for (const { c, i } of sorted) {
    const excluded = new Set<string>(claimed);
    excluded.delete(hexKey(c.position));
    for (const other of state.cities) {
      if (other.id !== c.id) excluded.add(hexKey(other.position));
    }
    const r = recomputeCity(state.map, c, content, excluded);
    for (const k of r.workedTiles) claimed.add(k);
    updated[i] = { ...c, workedTiles: r.workedTiles, perTurnYields: r.perTurnYields };
  }
  return { ...state, cities: updated };
}

function cityIdNum(id: string): number {
  const n = parseInt(id.replace(/[^0-9]/g, ""), 10);
  return isFinite(n) ? n : 0;
}

/** Find the unowned hex closest to a city's center, within MAX_CITY_RADIUS. Returns null if none. */
function nextExpansionTile(
  state: MatchState,
  city: City,
): string | null {
  if (!state.map) return null;
  const owned = new Set(Object.keys(state.tileOwnership));
  let best: { key: string; dist: number } | null = null;
  for (const tile of state.map.tiles) {
    const d = distance(city.position, { q: tile.q, r: tile.r });
    if (d === 0 || d > MAX_CITY_RADIUS) continue;
    const k = hexKey({ q: tile.q, r: tile.r });
    if (owned.has(k)) continue;
    if (!best || d < best.dist) best = { key: k, dist: d };
  }
  return best?.key ?? null;
}

/**
 * Process one player's economy at the start of their turn:
 * - per city: yields → treasury, food → growth, production → completion,
 *   culture → border expansion, worker improvements tick
 */
export function processPlayerTurn(
  state: MatchState,
  playerId: string,
  content: ContentPack,
): { state: MatchState; logs: string[] } {
  const logs: string[] = [];
  const playerIdx = state.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) return { state, logs };
  const player = state.players[playerIdx]!;

  const cities = state.cities.map((c) => ({ ...c }));
  let units = state.units.slice();
  let nextUnitId = state.nextUnitId;
  let goldDelta = 0;
  let scienceDelta = 0;
  let cultureDelta = 0;
  let tileOwnership = { ...state.tileOwnership };

  for (const city of cities) {
    if (city.ownerId !== playerId) continue;
    const y = city.perTurnYields;
    goldDelta += y.gold ?? 0;
    scienceDelta += y.science ?? 0;
    cultureDelta += y.culture ?? 0;

    // Food + growth
    const consumed = city.population * FOOD_PER_POP;
    const netFood = (y.food ?? 0) - consumed;
    city.food = Math.max(0, city.food + netFood);
    if (city.food >= city.foodToGrow) {
      city.food -= city.foodToGrow;
      city.population += 1;
      city.foodToGrow = FOOD_TO_GROW_BASE + city.population * 6;
      logs.push(`${city.name} grew to population ${city.population}`);
    }

    // Culture → border expansion
    city.cultureAccumulated += y.culture ?? 0;
    if (city.cultureAccumulated >= city.cultureToExpand) {
      // Build a temp state-ish view for the picker that reflects current ownership
      const probeState = { ...state, tileOwnership } as MatchState;
      const newTile = nextExpansionTile(probeState, city);
      if (newTile) {
        city.cultureAccumulated -= city.cultureToExpand;
        city.cultureToExpand = Math.floor(city.cultureToExpand * CULTURE_THRESHOLD_RAMP);
        city.ownedTiles = [...city.ownedTiles, newTile];
        tileOwnership[newTile] = city.id;
        logs.push(`${city.name} expanded its borders`);
      }
    }

    // Production
    if (city.productionItem) {
      city.production += y.production ?? 0;
      const cost = productionCostOf(city.productionItem, content);
      if (cost !== null && city.production >= cost) {
        city.production -= cost;
        const completed = city.productionItem;
        if (completed.kind === "unit") {
          const def = content.units.find((u) => (u.id as unknown as string) === completed.defId);
          if (def) {
            const occupied = (q: number, r: number) =>
              units.some((u) => u.position.q === q && u.position.r === r);
            let pos = city.position;
            if (occupied(pos.q, pos.r)) {
              const free = neighbors(city.position).find((n) => !occupied(n.q, n.r));
              if (free) pos = free;
            }
            units = units.concat({
              id: `u${nextUnitId++}`,
              ownerId: playerId,
              defId: completed.defId,
              position: { ...pos },
              movementMax: def.movement,
              movementLeft: 0,
              hp: 100,
              hpMax: 100,
            });
            logs.push(`${city.name} produced a ${def.name}`);
          }
        } else {
          city.buildings = [...city.buildings, completed.defId];
          const def = content.buildings.find((b) => (b.id as unknown as string) === completed.defId);
          logs.push(`${city.name} completed ${def?.name ?? completed.defId}`);
        }
        city.productionItem = null;
      }
    }
  }

  // ----- Worker improvement ticks -----
  // Walk every tile with workInProgress for this player; check whether the
  // assigned worker is still on the tile. Tick down or cancel.
  let map = state.map;
  if (map) {
    const tiles = map.tiles.map((t) => {
      if (!t.workInProgress) return t;
      const worker = units.find((u) => u.id === t.workInProgress!.unitId);
      if (!worker || worker.ownerId !== playerId) return t;
      // Only tick on the worker's owner's turn
      if (worker.position.q !== t.q || worker.position.r !== t.r) {
        // Worker moved off — cancel
        const next = { ...t };
        delete next.workInProgress;
        logs.push(`Worker abandoned improvement on (${t.q},${t.r})`);
        return next;
      }
      const left = t.workInProgress.turnsLeft - 1;
      if (left <= 0) {
        const impId = t.workInProgress.improvementId;
        const def = content.improvements.find((i) => (i.id as unknown as string) === impId);
        const next: Tile = { ...t, improvement: impId };
        delete next.workInProgress;
        logs.push(`Worker completed ${def?.name ?? impId} on (${t.q},${t.r})`);
        return next;
      }
      return { ...t, workInProgress: { ...t.workInProgress, turnsLeft: left } };
    });
    map = { ...map, tiles };
  }

  const players = state.players.slice();
  let updatedPlayer: Player = {
    ...player,
    gold: player.gold + goldDelta,
    science: player.science + scienceDelta,
    culture: player.culture + cultureDelta,
  };
  const research = applyResearchTick(updatedPlayer, content);
  updatedPlayer = research.player;
  for (const text of research.logs) logs.push(text);
  players[playerIdx] = updatedPlayer;

  return {
    state: { ...state, cities, units, nextUnitId, players, tileOwnership, map },
    logs,
  };
}

function productionCostOf(item: City["productionItem"], content: ContentPack): number | null {
  if (!item) return null;
  if (item.kind === "unit") {
    const def = content.units.find((u) => (u.id as unknown as string) === item.defId);
    return def?.cost.production ?? null;
  } else {
    const def = content.buildings.find((b) => (b.id as unknown as string) === item.defId);
    return def?.cost.production ?? null;
  }
}

export function playerYields(state: MatchState, playerId: string): Yields {
  let y: Yields = {};
  for (const c of state.cities) {
    if (c.ownerId !== playerId) continue;
    y = addYields(y, c.perTurnYields);
    y = addYields(y, { food: -(c.population * FOOD_PER_POP) });
  }
  return trim(y);
}

export function nextCityName(state: MatchState, content: ContentPack, playerId: string): string {
  const player = state.players.find((p) => p.id === playerId);
  if (!player?.civId) return "City";
  const civ = content.civilizations.find((c) => (c.id as unknown as string) === player.civId);
  const civName = civ?.name ?? player.civId;
  const counter = (state.cityCounters[player.id] ?? 0) + 1;
  return counter === 1 ? civName : `${civName} ${counter}`;
}

export function canFoundCityAt(state: MatchState, pos: AxialCoord): boolean {
  for (const c of state.cities) {
    if (distance(c.position, pos) < 3) return false;
  }
  return true;
}

export function cityVisibleHexes(map: GameMap, _city: Pick<City, "position">): string[] {
  return cityFootprint(map, _city.position);
}

export function playerVisibleHexes(state: MatchState, playerId: string): Set<string> {
  const out = new Set<string>();
  if (!state.map) return out;
  const SIGHT = 2;
  for (const u of state.units) {
    if (u.ownerId !== playerId) continue;
    for (const tile of state.map.tiles) {
      if (distance(u.position, { q: tile.q, r: tile.r }) <= SIGHT)
        out.add(hexKey({ q: tile.q, r: tile.r }));
    }
  }
  for (const c of state.cities) {
    if (c.ownerId !== playerId) continue;
    for (const k of cityFootprint(state.map, c.position)) out.add(k);
  }
  const me = state.players.find((p) => p.id === playerId);
  if (me?.startingHex) {
    for (const tile of state.map.tiles) {
      if (distance(me.startingHex, { q: tile.q, r: tile.r }) <= SIGHT)
        out.add(hexKey({ q: tile.q, r: tile.r }));
    }
  }
  return out;
}

export function buildableUnits(content: ContentPack, player: Player): typeof content.units {
  const researched = new Set(player.researchedTechs);
  return content.units.filter((u) => {
    if (!u.prereq_tech) return true;
    return researched.has(u.prereq_tech as unknown as string);
  });
}

export function buildableBuildings(
  content: ContentPack,
  player: Player,
  cityBuildings: string[],
  cityResources?: Set<string>,
): typeof content.buildings {
  const built = new Set(cityBuildings);
  const researched = new Set(player.researchedTechs);
  return content.buildings.filter((b) => {
    if (built.has(b.id as unknown as string)) return false;
    if (b.prereq_tech && !researched.has(b.prereq_tech as unknown as string))
      return false;
    const needs = (b.requires_resources ?? []).map((r) => r as unknown as string);
    if (needs.length > 0) {
      if (!cityResources) return false;
      for (const r of needs) if (!cityResources.has(r)) return false;
    }
    return true;
  });
}

/**
 * Resource ids accessible to a city's territory. A resource counts only when
 * its harvest improvement (if any) is on the tile — same rule as for yields,
 * so building gates match what the city can actually build improvements for.
 *
 * Accepts either GameMap or MapView — both expose tiles with q/r/resource/improvement.
 */
export function cityResources(
  map: {
    tiles: ReadonlyArray<{
      q: number;
      r: number;
      resource?: string;
      improvement?: string;
    }>;
  },
  city: City,
  content?: ContentPack,
): Set<string> {
  const owned = new Set(city.ownedTiles);
  const byId = content
    ? new Map(content.resources.map((r) => [r.id as unknown as string, r]))
    : null;
  const out = new Set<string>();
  for (const tile of map.tiles) {
    if (!tile.resource) continue;
    if (!owned.has(hexKey({ q: tile.q, r: tile.r }))) continue;
    if (byId) {
      const r = byId.get(tile.resource);
      if (!r) continue;
      const required = (r.harvested_by ?? []).map((i) => i as unknown as string);
      if (required.length > 0) {
        if (!tile.improvement || !required.includes(tile.improvement)) continue;
      }
    }
    out.add(tile.resource);
  }
  return out;
}

/** Improvements buildable by a worker on a given tile. */
export function buildableImprovementsForTile(
  content: ContentPack,
  player: Player,
  tile: Tile,
): typeof content.improvements {
  const researched = new Set(player.researchedTechs);
  return content.improvements.filter((imp) => {
    if (imp.prereq_tech && !researched.has(imp.prereq_tech as unknown as string)) return false;
    if (imp.terrain_compat.length > 0 && !imp.terrain_compat.some((t) => (t as unknown as string) === tile.terrain))
      return false;
    return true;
  });
}

export type Stub = Unit;
