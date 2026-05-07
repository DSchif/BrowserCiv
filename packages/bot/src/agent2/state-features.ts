import type { ContentPack, MatchView } from "@browserciv/shared";
import type { StateFeaturesConfig } from "./config.js";

export const MAX_STATE_FEATURE_SIZE = 17;

export function computeStateFeatureSize(cfg: StateFeaturesConfig): number {
  let n = 10; // base block always included
  if (cfg.enemy_units_visible_count)   n++;
  if (cfg.enemy_cities_visible_count)  n++;
  if (cfg.at_war)                      n++;
  if (cfg.era_index)                   n++;
  if (cfg.turns_since_last_city)       n++;
  if (cfg.total_production_rate)       n++;
  if (cfg.avg_city_hp_fraction)        n++;
  return n;
}

export function extractStateFeatures(
  view: MatchView,
  playerId: string,
  cfg: StateFeaturesConfig,
  content: ContentPack,
  turnsSinceLastCity: number,
): number[] {
  const me = view.players.find((p) => p.id === playerId);
  const myUnits   = view.units.filter((u) => u.ownerId === playerId);
  const myCities  = view.cities.filter((c) => c.ownerId === playerId);
  const allTiles  = view.map?.tiles ?? [];
  const totalTiles = allTiles.length || 1;

  const ownedTiles = allTiles.filter((t) =>
    t.ownerCityId && myCities.some((c) => c.id === t.ownerCityId),
  ).length;
  const seenTiles = allTiles.filter((t) => t.visibility !== "unseen").length;

  // Base 10 features (always included)
  const feats: number[] = [
    view.turnNumber / 100,
    myCities.length / 10,
    myUnits.length / 10,
    myUnits.filter((u) => u.defId === "unit.settler").length / 5,
    myCities.filter((c) => !c.productionItem).length / 5,
    me?.currentTech ? 1 : 0,
    (me?.gold ?? 0) / 200,
    ownedTiles / totalTiles,
    seenTiles / totalTiles,
    1.0, // bias
  ];

  if (cfg.enemy_units_visible_count) {
    feats.push(view.units.filter((u) => u.ownerId !== playerId).length / 10);
  }
  if (cfg.enemy_cities_visible_count) {
    feats.push(view.cities.filter((c) => c.ownerId !== playerId).length / 5);
  }
  if (cfg.at_war) {
    feats.push(Object.keys(view.diplomacy ?? {}).length > 0 ? 1 : 0);
  }
  if (cfg.era_index) {
    const maxEra = Math.max(content.eras.length - 1, 1);
    const eraOrder = content.eras.findIndex((e) => e.id === me?.era) ?? 0;
    feats.push(Math.max(0, eraOrder) / maxEra);
  }
  if (cfg.turns_since_last_city) {
    feats.push(turnsSinceLastCity / 50);
  }
  if (cfg.total_production_rate) {
    const totalProd = myCities.reduce((s, c) => s + (c.perTurnYields.production ?? 0), 0);
    feats.push(totalProd / 20);
  }
  if (cfg.avg_city_hp_fraction) {
    const avgHp = myCities.length > 0
      ? myCities.reduce((s, c) => s + c.hp / c.hpMax, 0) / myCities.length
      : 1;
    feats.push(avgHp);
  }

  return feats;
}
