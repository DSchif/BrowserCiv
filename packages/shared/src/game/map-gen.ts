import type { AxialCoord } from "../hex.js";
import { distance, key as hexKey } from "../hex.js";
import type { ContentPack, UnitDef } from "../schemas/index.js";
import { unitCanEnter } from "./path.js";
import * as Rng from "./rng.js";
import type { GameMap, MapSize, Tile } from "./state.js";

/**
 * Map sizes — chosen for legibility and rendering performance. The values
 * are (cols, rows) pairs in offset coordinates; each cell is one hex.
 */
export const MAP_DIMENSIONS: Record<MapSize, { width: number; height: number }> = {
  small: { width: 32, height: 20 },
  medium: { width: 48, height: 32 },
  large: { width: 64, height: 40 },
};

/** Convert an offset coord (col, row) to axial (q, r) using "odd-r" offset for pointy-top hexes. */
export function offsetToAxial(col: number, row: number): AxialCoord {
  const q = col - ((row - (row & 1)) >> 1);
  return { q, r: row };
}

/** Inverse of offsetToAxial. */
export function axialToOffset(c: AxialCoord): { col: number; row: number } {
  const col = c.q + ((c.r - (c.r & 1)) >> 1);
  return { col, row: c.r };
}

/**
 * Procedural map generator. Returns a rectangular map of pointy-top hexes;
 * terrain comes from FBM value-noise + edge falloff. If `content` is provided,
 * resources from the pack are placed deterministically on matching terrain.
 *
 * Water/structure bands (by height):
 *   < 0.28 → deep_ocean   (impassable)
 *   < 0.40 → ocean
 *   < 0.60 → low land     (biome assigned from temperature × moisture)
 *   < 0.75 → hills
 *   else   → mountain     (impassable)
 *
 * Biome assignment for low land combines latitude-derived temperature with a
 * second moisture noise field. Hot+dry → desert, hot+wet → jungle, polar →
 * tundra/snow, and the temperate band fills with grassland/plains/forest.
 */
export function generateMap(
  rngStateIn: Rng.RngState,
  size: MapSize,
  content?: ContentPack,
): { map: GameMap; rngState: Rng.RngState } {
  const { width, height } = MAP_DIMENSIONS[size];
  const seedDraw = Rng.next(rngStateIn);
  const noiseSeed = Math.floor(seedDraw.value * 0xffffffff) >>> 0;
  const moistSeed = (noiseSeed ^ 0x9e3779b9) >>> 0;

  const baseFreq = 1 / (8 + Math.max(width, height) / 16);
  const moistFreq = 1 / (6 + Math.max(width, height) / 24);

  const tiles: Tile[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const { q, r } = offsetToAxial(col, row);
      const h = sampleHeight(col, row, width, height, baseFreq, noiseSeed);
      const m = fbm(col * moistFreq, row * moistFreq, moistSeed, 3);
      const lat = Math.abs(row - (height - 1) / 2) / ((height - 1) / 2);
      tiles.push({ q, r, terrain: terrainFor(h, lat, m) });
    }
  }

  // Coast post-pass: any ocean tile adjacent to a land tile becomes coast.
  applyCoastPass(tiles);

  let state = seedDraw.state;
  if (content) {
    state = placeResources(tiles, content, state);
  }

  return { map: { width, height, tiles }, rngState: state };
}

function applyCoastPass(tiles: Tile[]): void {
  const tilesByKey = new Map<string, Tile>();
  for (const t of tiles) tilesByKey.set(`${t.q},${t.r}`, t);
  const LAND = new Set([
    "plains",
    "hills",
    "mountain",
    "grassland",
    "forest",
    "desert",
    "jungle",
    "tundra",
    "snow",
  ]);
  const NEIGH: Array<[number, number]> = [
    [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
  ];
  for (const t of tiles) {
    if (t.terrain !== "ocean") continue;
    for (const [dq, dr] of NEIGH) {
      const nb = tilesByKey.get(`${t.q + dq},${t.r + dr}`);
      if (nb && LAND.has(nb.terrain)) {
        t.terrain = "coast";
        break;
      }
    }
  }
}

/** Sprinkle resources onto matching terrain tiles. Deterministic per RNG state. */
function placeResources(
  tiles: Tile[],
  content: ContentPack,
  rngStateIn: Rng.RngState,
): Rng.RngState {
  let state = rngStateIn;
  const probabilityFor: Record<string, number> = {
    bonus: 0.10,
    luxury: 0.08,
    strategic: 0.06,
    special: 0.04,
  };
  for (const resource of content.resources) {
    const onTerrains = new Set(
      resource.appears_on_terrains.map((t) => t as unknown as string),
    );
    const p = probabilityFor[resource.category] ?? 0.05;
    for (const tile of tiles) {
      if (tile.resource) continue; // one resource per tile
      if (!onTerrains.has(tile.terrain)) continue;
      const draw = Rng.next(state);
      state = draw.state;
      if (draw.value < p) {
        tile.resource = resource.id as unknown as string;
      }
    }
  }
  return state;
}

/**
 * Pick a biome for low-land. Inputs:
 *   lat: 0 (equator) → 1 (pole)
 *   moisture: 0 (arid) → 1 (wet)
 */
function biomeFor(lat: number, moisture: number): string {
  if (lat > 0.95) return "snow";
  if (lat > 0.88) return moisture > 0.55 ? "tundra" : "snow";
  if (lat > 0.80) return "tundra";
  if (lat < 0.30) {
    if (moisture < 0.32) return "desert";
    if (moisture > 0.55) return "jungle";
    return "plains";
  }
  if (moisture < 0.32) return "desert";
  if (moisture > 0.58) return "forest";
  if (moisture > 0.42) return "grassland";
  return "plains";
}

function terrainFor(h: number, lat: number, moisture: number): string {
  if (h < 0.28) return "deep_ocean";
  if (h < 0.40) return "ocean";
  if (h < 0.60) return biomeFor(lat, moisture);
  if (h < 0.75) return "hills";
  return "mountain";
}

function sampleHeight(
  x: number,
  y: number,
  width: number,
  height: number,
  baseFreq: number,
  seed: number,
): number {
  const raw = fbm(x * baseFreq, y * baseFreq, seed, 4);
  const e = edgeFalloff(x, y, width, height);
  // Combine raw noise (75%) with edge-based elevation (25%). The interior
  // gets a +0.25 baseline so it tends to be land; edges drop to 0..0.75 so
  // they tend toward water without forcing all coastlines into deep ocean.
  return clamp01(raw * 0.75 + e * 0.25);
}

function edgeFalloff(x: number, y: number, w: number, h: number): number {
  // 0 at any edge, ~1 in the deep interior. Smooth-clamped.
  const dx = Math.min(x, w - 1 - x) / (w / 2);
  const dy = Math.min(y, h - 1 - y) / (h / 2);
  const e = Math.min(dx, dy);
  // soft S-curve so the falloff isn't too aggressive
  return clamp01(e * e * (3 - 2 * e));
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let value = 0;
  let amp = 1;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * valueNoise(x * freq, y * freq, seed + i * 1013);
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return max === 0 ? 0 : value / max;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = hash01(x0, y0, seed);
  const v10 = hash01(x0 + 1, y0, seed);
  const v01 = hash01(x0, y0 + 1, seed);
  const v11 = hash01(x0 + 1, y0 + 1, seed);
  const sx = fade(fx);
  const sy = fade(fy);
  return lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
}

function hash01(x: number, y: number, seed: number): number {
  // 2D integer hash → [0,1). Deterministic, fast, no deps.
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ (seed | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Pick `count` starting positions, deterministic given the RNG state. Each
 * candidate tile must be enterable by every unit in `requiredUnits`. Falls
 * back through progressively relaxed spacing tiers so an unfavorable noise
 * seed never returns fewer positions than asked for.
 */
export function pickStartingPositions(
  rngStateIn: Rng.RngState,
  map: GameMap,
  count: number,
  content: ContentPack,
  requiredUnits: UnitDef[],
): { positions: AxialCoord[]; rngState: Rng.RngState } {
  let state = rngStateIn;
  const minDim = Math.min(map.width, map.height);
  // Min spacing must exceed unit sight so players don't see each other on
  // turn 1. Sight radius is 2 → minSafe = 5. Above that, scale with map size.
  const MIN_SAFE_SPACING = 5;
  const baseSpacing = Math.max(
    MIN_SAFE_SPACING,
    Math.floor(minDim / Math.max(1, count)),
  );

  const terrainsById = new Map(
    content.terrains.map((t) => [t.id as unknown as string, t]),
  );

  // A tile is acceptable if every required unit can enter it.
  const acceptable = (terrainId: string): boolean => {
    const terrain = terrainsById.get(terrainId);
    if (!terrain) return false;
    if (requiredUnits.length === 0) return true;
    return requiredUnits.every((u) => unitCanEnter(u, terrain) !== null);
  };

  const candidates = map.tiles.filter((t) => acceptable(t.terrain));

  const tiers: Array<{ pool: typeof map.tiles; spacing: number }> = [
    { pool: candidates, spacing: baseSpacing },
    { pool: candidates, spacing: MIN_SAFE_SPACING },
    // Last-resort: if there really aren't enough enterable tiles spaced ≥
    // MIN_SAFE_SPACING apart, allow any tile but still respect the safe
    // spacing so players never spawn within sight of each other.
    { pool: map.tiles, spacing: MIN_SAFE_SPACING },
    // Final fallback (should be unreachable on any reasonable map): drop
    // spacing entirely. Better to spawn close than to fail to start.
    { pool: map.tiles, spacing: 1 },
  ];

  let chosen: AxialCoord[] = [];
  for (const { pool, spacing } of tiers) {
    if (pool.length === 0) continue;
    chosen = [];
    let safety = 0;
    while (chosen.length < count && safety++ < 5000) {
      const p = Rng.nextInt(state, pool.length);
      state = p.state;
      const cand = pool[p.value]!;
      const c: AxialCoord = { q: cand.q, r: cand.r };
      if (chosen.some((other) => hexKey(other) === hexKey(c))) continue;
      if (spacing > 0 && chosen.some((other) => distance(other, c) < spacing)) continue;
      chosen.push(c);
    }
    if (chosen.length === count) break;
  }

  return { positions: chosen, rngState: state };
}
