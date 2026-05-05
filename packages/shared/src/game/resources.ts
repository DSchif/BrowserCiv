import { key as hexKey } from "../hex.js";
import type { ContentPack } from "../schemas/index.js";
import type { City, MatchState, Player, Tile } from "./state.js";

/**
 * Set of resource ids the player can currently see on the map. A resource
 * with no tech unlock is always visible. Otherwise it's visible only after
 * researching the tech that lists it in `unlocks.resources_visible`.
 */
export function visibleResourcesFor(
  player: Player,
  content: ContentPack,
): Set<string> {
  const out = new Set<string>();
  // Default: every resource is visible. Then we hide ones gated by tech.
  for (const r of content.resources) out.add(r.id as unknown as string);

  const gating = new Map<string, string[]>();
  for (const tech of content.techs) {
    for (const rId of tech.unlocks.resources_visible) {
      const id = rId as unknown as string;
      const arr = gating.get(id) ?? [];
      arr.push(tech.id as unknown as string);
      gating.set(id, arr);
    }
  }

  for (const [resourceId, requiredTechs] of gating) {
    // If any tech that gates this resource requires unlock, hide unless
    // player has researched at least one of them.
    const hasAny = requiredTechs.some((t) => player.researchedTechs.includes(t));
    if (!hasAny) out.delete(resourceId);
  }
  return out;
}

/**
 * How many units one tile of resource `r` contributes when properly worked.
 * Civ V gives strategic tiles 2 per source by default; luxury/bonus give 1.
 */
function copiesPerSource(r: { category: string }): number {
  return r.category === "strategic" ? 2 : 1;
}

/**
 * Whether a tile actually yields its resource: if the resource has
 * `harvested_by` improvements declared, the tile's improvement must match;
 * otherwise the resource is always-on (bonus tiles like wheat-on-grassland
 * predate the harvest gate, so they default to always-on).
 */
function isHarvested(
  tile: Tile,
  resource: { harvested_by?: ReadonlyArray<unknown> } | undefined,
): boolean {
  if (!resource) return false;
  const required = (resource.harvested_by ?? []).map((i) => i as unknown as string);
  if (required.length === 0) return true;
  return tile.improvement !== undefined && required.includes(tile.improvement);
}

/**
 * Strategic & luxury resources accessible to the player from tiles owned by
 * cities they control. A resource only contributes when its harvest
 * improvement is built (matches Civ V: a horse-tile gives nothing without
 * a Pasture). Strategic tiles give 2 per source.
 */
export function rawResourceProduction(
  state: MatchState,
  playerId: string,
  content: ContentPack,
): Record<string, number> {
  const tilesByKey = new Map<string, Tile>();
  if (state.map) {
    for (const t of state.map.tiles) tilesByKey.set(hexKey({ q: t.q, r: t.r }), t);
  }
  const resourcesById = new Map(
    content.resources.map((r) => [r.id as unknown as string, r]),
  );
  const out: Record<string, number> = {};
  for (const city of state.cities) {
    if (city.ownerId !== playerId) continue;
    // Owned tiles are scanned (broader than worked, so resources outside the
    // worked set still grant access — the city has the resource even if a
    // citizen isn't manning that exact tile, as long as it's improved).
    for (const k of city.ownedTiles) {
      const t = tilesByKey.get(k);
      if (!t?.resource) continue;
      const r = resourcesById.get(t.resource);
      if (!r) continue;
      if (!isHarvested(t, r)) continue;
      out[t.resource] = (out[t.resource] ?? 0) + copiesPerSource(r);
    }
  }
  return out;
}

/** Sum of resource costs across the player's currently-living units. */
export function resourcesUsedByPlayer(
  state: MatchState,
  playerId: string,
  content: ContentPack,
): Record<string, number> {
  const unitDefs = new Map(content.units.map((u) => [u.id as unknown as string, u]));
  const used: Record<string, number> = {};
  for (const u of state.units) {
    if (u.ownerId !== playerId) continue;
    const def = unitDefs.get(u.defId);
    if (!def?.cost.resources) continue;
    for (const [rid, n] of Object.entries(def.cost.resources)) {
      used[rid] = (used[rid] ?? 0) + n;
    }
  }
  return used;
}

/** Available = produced − used. Negative entries clamped to 0 (overdraft is just "0 spare"). */
export function computeAvailable(
  state: MatchState,
  playerId: string,
  content: ContentPack,
): Record<string, number> {
  const produced = rawResourceProduction(state, playerId, content);
  const used = resourcesUsedByPlayer(state, playerId, content);
  const out: Record<string, number> = {};
  for (const [rid, n] of Object.entries(produced)) {
    out[rid] = Math.max(0, n - (used[rid] ?? 0));
  }
  // Also include 0 entries for resources used but not produced (so UI shows "needs iron").
  for (const rid of Object.keys(used)) {
    if (!(rid in out)) out[rid] = 0;
  }
  return out;
}

/** Recompute & write `availableResources` onto every player. Call after any city change. */
export function recomputeAllResources(
  state: MatchState,
  content: ContentPack,
): MatchState {
  const players = state.players.map((p) => ({
    ...p,
    availableResources: computeAvailable(state, p.id, content),
  }));
  return { ...state, players };
}

/** Validation helper for SetCityProduction: does the player have enough? */
export function checkResourceCost(
  player: Player,
  cost: Record<string, number> | undefined,
): { ok: boolean; missing: string[] } {
  if (!cost) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const [rid, n] of Object.entries(cost)) {
    if ((player.availableResources[rid] ?? 0) < n) missing.push(rid);
  }
  return { ok: missing.length === 0, missing };
}

/** Helper for the city panel: subtract a buildable item's resource cost from available pool to check buildability. */
export function canAffordUnit(
  player: Player,
  unitDef: { cost: { resources?: Record<string, number> } },
): boolean {
  return checkResourceCost(player, unitDef.cost.resources).ok;
}

/** Stub re-export so dependents can grab type from index. */
export type ResourceMap = Record<string, number>;

/** Convenience type alias used in city/visibility/etc. */
export type _City = City;
