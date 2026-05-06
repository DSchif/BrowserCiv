import type { MatchView } from "@browserciv/shared";

export const FEATURE_SIZE = 10;

/**
 * Converts a MatchView into a fixed-length numeric feature vector.
 * All values are normalised to roughly [0, 1] so gradient updates are stable.
 *
 * Index  Meaning
 * ─────  ───────────────────────────────────────────────
 *   0    turn / 100
 *   1    my city count / 10
 *   2    my unit count / 10
 *   3    my settler count / 5
 *   4    my idle cities (no production) / 5
 *   5    1 if research is active, else 0
 *   6    my gold / 200
 *   7    fraction of map tiles I own
 *   8    fraction of map tiles seen (visibility !== "unseen")
 *   9    bias = 1.0
 */
export function extractFeatures(view: MatchView, playerId: string): number[] {
  const me = view.players.find((p) => p.id === playerId);
  const myUnits = view.units.filter((u) => u.ownerId === playerId);
  const myCities = view.cities.filter((c) => c.ownerId === playerId);
  const totalTiles = view.map?.tiles.length ?? 1;
  const ownedTiles = view.map?.tiles.filter((t) => t.ownerCityId &&
    myCities.some((c) => c.id === t.ownerCityId)).length ?? 0;
  const seenTiles = view.map?.tiles.filter((t) => t.visibility !== "unseen").length ?? 0;

  return [
    view.turnNumber / 100,
    myCities.length / 10,
    myUnits.length / 10,
    myUnits.filter((u) => u.defId === "unit.settler").length / 5,
    myCities.filter((c) => !c.productionItem).length / 5,
    me?.currentTech ? 1 : 0,
    (me?.gold ?? 0) / 200,
    ownedTiles / totalTiles,
    seenTiles / totalTiles,
    1.0,
  ];
}

/**
 * One-hot encoding of the intent's action type category.
 * Used to give the Q-function a signal about what kind of action is being scored.
 *
 * Index  Category
 * ─────  ────────────────────────
 *   0    EndTurn
 *   1    MoveUnit
 *   2    FoundCity
 *   3    SetCityProduction
 *   4    SetResearch
 *   5    (other)
 */
export const ACTION_CATEGORIES = [
  "EndTurn", "MoveUnit", "FoundCity", "SetCityProduction", "SetResearch",
] as const;
export const NUM_ACTION_CATEGORIES = ACTION_CATEGORIES.length + 1; // +1 for "other"

export function actionCategoryFeatures(intentType: string): number[] {
  const vec = new Array<number>(NUM_ACTION_CATEGORIES).fill(0);
  const idx = ACTION_CATEGORIES.indexOf(intentType as typeof ACTION_CATEGORIES[number]);
  vec[idx === -1 ? ACTION_CATEGORIES.length : idx] = 1;
  return vec;
}

/** Full feature vector = state features ++ action-category one-hot */
export function intentFeatures(view: MatchView, playerId: string, intentType: string): number[] {
  return [...extractFeatures(view, playerId), ...actionCategoryFeatures(intentType)];
}

export const TOTAL_FEATURE_SIZE = FEATURE_SIZE + NUM_ACTION_CATEGORIES;
