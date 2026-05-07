import { Hex } from "@browserciv/shared";
import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import type { GoalId, IntentFeaturesConfig } from "./config.js";

type AxialCoord = Hex.AxialCoord;
const { neighbors, distance } = Hex;

// ── Intent type one-hot (13 slots) ───────────────────────────────────────────

export const INTENT_TYPES = [
  "EndTurn",
  "MoveUnit",
  "FoundCity",
  "SetCityProduction",
  "SetResearch",
  "UpgradeUnit",
  "DeclareWar",
  "MakePeace",
  "RangedAttack",
  "BuildImprovement",
  "Fortify",
  "BuyProduction",
  "Other", // MatchStart, CityRangedAttack, BoardShip, Disembark
] as const;

export const NUM_INTENT_TYPES = INTENT_TYPES.length; // 13

export function intentTypeOneHot(intentType: string): number[] {
  const vec = new Array<number>(NUM_INTENT_TYPES).fill(0);
  const idx = (INTENT_TYPES as readonly string[]).indexOf(intentType);
  vec[idx === -1 ? NUM_INTENT_TYPES - 1 : idx] = 1;
  return vec;
}

// ── Goal one-hot ─────────────────────────────────────────────────────────────

export const ALL_GOAL_IDS: GoalId[] = [
  "explore", "expand", "attack", "defend", "develop", "tech",
];

export function goalOneHot(goalId: GoalId, enabledGoalIds: GoalId[]): number[] {
  return enabledGoalIds.map((g) => (g === goalId ? 1 : 0));
}

// ── Per-intent specific features (MAX 8, zero-padded) ────────────────────────

export const MAX_INTENT_FEATURE_SIZE = 8;

export function intentSpecificFeatures(
  intent: Intent,
  view: MatchView,
  playerId: string,
  cfg: IntentFeaturesConfig,
  content: ContentPack,
): number[] {
  const pad = (arr: number[]): number[] => {
    const out = arr.slice(0, MAX_INTENT_FEATURE_SIZE);
    while (out.length < MAX_INTENT_FEATURE_SIZE) out.push(0);
    return out;
  };

  switch (intent.type) {
    case "MoveUnit": {
      const c = cfg.MoveUnit;
      if (!c.enabled) return pad([]);
      const tiles = new Map(
        (view.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]),
      );
      const targetTile = tiles.get(`${intent.target.q},${intent.target.r}`);
      const terrain = targetTile
        ? content.terrains.find((t) => (t.id as unknown as string) === targetTile.terrain)
        : undefined;

      const unit = view.units.find((u) => u.id === intent.unitId);
      const neighborTiles = neighbors(intent.target);

      const unseenCount = c.unseen_neighbors_count
        ? neighborTiles.filter((nb: AxialCoord) => {
            const t = tiles.get(`${nb.q},${nb.r}`);
            return !t || t.visibility === "unseen";
          }).length / 6
        : 0;

      const terrainCost = c.terrain_cost ? (terrain?.movement_cost ?? 1) / 3 : 0;
      const hasResource = c.has_resource ? (targetTile?.resource ? 1 : 0) : 0;

      const isMeleeAttack = c.is_melee_attack ? (intent.attackId ? 1 : 0) : 0;

      const enemyUnits = new Set(
        view.units.filter((u) => u.ownerId !== playerId).map((u) => `${u.position.q},${u.position.r}`),
      );
      const friendlyUnits = new Set(
        view.units.filter((u) => u.ownerId === playerId && u.id !== intent.unitId)
          .map((u) => `${u.position.q},${u.position.r}`),
      );

      const friendliesAdj = c.num_friendlies_adjacent
        ? neighborTiles.filter((nb: AxialCoord) => friendlyUnits.has(`${nb.q},${nb.r}`)).length / 6
        : 0;
      const enemiesAdj = c.num_enemies_adjacent
        ? neighborTiles.filter((nb: AxialCoord) => enemyUnits.has(`${nb.q},${nb.r}`)).length / 6
        : 0;

      const unitHpFrac = c.unit_hp_fraction && unit ? unit.hp / unit.hpMax : 0;
      const unitMoveFrac = c.unit_movement_fraction && unit
        ? unit.movementLeft / Math.max(unit.movementMax, 1)
        : 0;

      return pad([unseenCount, terrainCost, hasResource, isMeleeAttack,
                  friendliesAdj, enemiesAdj, unitHpFrac, unitMoveFrac]);
    }

    case "RangedAttack": {
      const c = cfg.RangedAttack;
      if (!c.enabled) return pad([]);
      const target = view.units.find((u) => u.id === intent.targetUnitId);
      const attacker = view.units.find((u) => u.id === intent.unitId);

      const targetHpFrac = c.target_hp_fraction && target
        ? target.hp / target.hpMax
        : 0;

      const allStrengths = view.units.filter((u) => u.ownerId !== playerId).map((u) => u.hpMax);
      const maxStrength = allStrengths.length > 0 ? Math.max(...allStrengths) : 1;
      const targetStrengthNorm = c.target_unit_strength && target
        ? target.hpMax / maxStrength
        : 0;

      const friendliesInRange = c.friendly_units_in_range && attacker
        ? view.units.filter((u) => {
            if (u.ownerId !== playerId) return false;
            return distance(u.position, attacker.position) <= 2;
          }).length / 6
        : 0;

      return pad([targetHpFrac, targetStrengthNorm, friendliesInRange]);
    }

    case "FoundCity": {
      const c = cfg.FoundCity;
      if (!c.enabled) return pad([]);
      const unit = view.units.find((u) => u.id === intent.unitId);
      if (!unit) return pad([]);

      const tiles = new Map(
        (view.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]),
      );
      const pos = unit.position;
      const tile = tiles.get(`${pos.q},${pos.r}`);
      const terrain = tile
        ? content.terrains.find((t) => (t.id as unknown as string) === tile.terrain)
        : undefined;

      const tileYieldScore = c.tile_yield_score && terrain
        ? (Object.values(terrain.base_yields).reduce((s, v) => s + v, 0)) / 30
        : 0;

      const myCities = view.cities.filter((cty) => cty.ownerId === playerId);
      const mapWidth = view.map?.width ?? 10;
      const distToNearest = c.dist_to_nearest_city && myCities.length > 0
        ? Math.min(...myCities.map((cty) => distance(pos, cty.position))) / mapWidth
        : 1;

      const neighborTiles = neighbors(pos).flatMap((nb: AxialCoord) => {
        const t = tiles.get(`${nb.q},${nb.r}`);
        return t ? [t] : [];
      });
      const resourcesInRadius = c.resources_in_radius
        ? neighborTiles.filter((t) => !!t.resource).length / 18
        : 0;

      return pad([tileYieldScore, distToNearest, resourcesInRadius]);
    }

    case "SetResearch": {
      const c = cfg.SetResearch;
      if (!c.enabled || !intent.techId) return pad([]);
      const tech = content.techs.find((t) => (t.id as unknown as string) === intent.techId);
      if (!tech) return pad([]);

      const eraIndex = content.eras.findIndex((e) => (e.id as unknown as string) === tech.era);
      const maxEra = Math.max(content.eras.length - 1, 1);
      const techEraIndexNorm = c.tech_era_index ? Math.max(0, eraIndex) / maxEra : 0;
      const unlockUnits = c.tech_unlocks_unit_count
        ? (tech.unlocks?.units?.length ?? 0) / 3
        : 0;
      const unlockBuildings = c.tech_unlocks_building_count
        ? (tech.unlocks?.buildings?.length ?? 0) / 3
        : 0;

      return pad([techEraIndexNorm, unlockUnits, unlockBuildings]);
    }

    case "SetCityProduction": {
      const c = cfg.SetCityProduction;
      if (!c.enabled || !intent.item) return pad([]);
      const city = view.cities.find((cty) => cty.id === intent.cityId);
      const item = intent.item;

      let isUnit = 0, isBuilding = 0, isWonder = 0, itemCost = 0;
      if (item.kind === "unit") {
        isUnit = c.is_unit ? 1 : 0;
        const def = content.units.find((u) => (u.id as unknown as string) === item.defId);
        itemCost = c.item_cost ? ((def as Record<string, unknown>)?.cost as number ?? 0) / 200 : 0;
      } else if (item.kind === "building") {
        isBuilding = c.is_building ? 1 : 0;
        const def = content.buildings.find((b) => (b.id as unknown as string) === item.defId);
        itemCost = c.item_cost ? ((def as Record<string, unknown>)?.cost as number ?? 0) / 200 : 0;
      } else if (item.kind === "wonder") {
        isWonder = c.is_wonder ? 1 : 0;
        const def = content.wonders.find((w) => (w.id as unknown as string) === item.defId);
        itemCost = c.item_cost ? ((def as Record<string, unknown>)?.cost as number ?? 0) / 200 : 0;
      }

      const cityProdPerTurn = c.city_production_per_turn && city
        ? (city.perTurnYields.production ?? 0) / 20
        : 0;

      return pad([isUnit, isBuilding, isWonder, itemCost, cityProdPerTurn]);
    }

    case "DeclareWar": {
      const c = cfg.DeclareWar;
      if (!c.enabled) return pad([]);
      const myUnits = view.units.filter((u) => u.ownerId === playerId);
      const enemyUnits = view.units.filter((u) => u.ownerId === intent.targetPlayerId);
      const myStrength = myUnits.reduce((s, u) => s + u.hp, 0) || 1;
      const enemyStrength = enemyUnits.reduce((s, u) => s + u.hp, 0) || 1;

      const relStrength = c.enemy_relative_strength
        ? enemyStrength / (myStrength + enemyStrength)
        : 0;
      const enemyCityCount = c.enemy_city_count
        ? view.cities.filter((cty) => cty.ownerId === intent.targetPlayerId).length / 5
        : 0;

      return pad([relStrength, enemyCityCount]);
    }

    case "MakePeace": {
      const c = cfg.MakePeace;
      if (!c.enabled) return pad([]);
      const myUnits = view.units.filter((u) => u.ownerId === playerId);
      const enemyUnits = view.units.filter((u) => u.ownerId === intent.targetPlayerId);
      const myStrength = myUnits.reduce((s, u) => s + u.hp, 0) || 1;
      const enemyStrength = enemyUnits.reduce((s, u) => s + u.hp, 0) || 1;

      const relStrength = c.enemy_relative_strength
        ? enemyStrength / (myStrength + enemyStrength)
        : 0;
      const enemyCityCount = c.enemy_city_count
        ? view.cities.filter((cty) => cty.ownerId === intent.targetPlayerId).length / 5
        : 0;

      return pad([relStrength, enemyCityCount]);
    }

    default:
      return pad([]);
  }
}

// ── Full tactical feature vector ──────────────────────────────────────────────

export function tacticalFeatureVector(
  stateFeats: number[],
  goalVec: number[],
  intent: Intent,
  view: MatchView,
  playerId: string,
  cfg: IntentFeaturesConfig,
  content: ContentPack,
): number[] {
  const typeOneHot = intentTypeOneHot(intent.type);
  const intentFeats = intentSpecificFeatures(intent, view, playerId, cfg, content);
  return [...stateFeats, ...goalVec, ...typeOneHot, ...intentFeats];
}
