import type { MatchView } from "@browserciv/shared";

export interface PlayerSnap {
  id: string;
  cities: number;
  units: number;
  unitsByType: Record<string, number>;
  gold: number;
  goldPerTurn: number;
  sciencePerTurn: number;
  productionPerTurn: number;
  foodPerTurn: number;
  techs: number;
  currentTech: string | null;
  totalBuildings: number;
  totalPopulation: number;
  tilesOwned: number;
}

export interface TurnSnap {
  turn: number;
  seenTiles: number;
  totalTiles: number;
  cumKills: number;
  cumCaptures: number;
  cumReward?: number;
  turnDurationMs?: number;
  agent: PlayerSnap;
  opponent: PlayerSnap | null;
}

export interface EpisodeDump {
  episode: number;
  agentId: string;
  opponentId: string;
  outcome: string;
  totalReward: number;
  totalKills: number;
  totalCaptures: number;
  turns: TurnSnap[];
}

export function snapPlayer(view: MatchView, playerId: string): PlayerSnap {
  const player = view.players.find((p) => p.id === playerId);
  const cities = view.cities.filter((c) => c.ownerId === playerId);
  const units = view.units.filter((u) => u.ownerId === playerId);

  const unitsByType: Record<string, number> = {};
  for (const u of units) {
    unitsByType[u.defId] = (unitsByType[u.defId] ?? 0) + 1;
  }

  const goldPT  = cities.reduce((s, c) => s + (c.perTurnYields.gold ?? 0), 0);
  const sciPT   = cities.reduce((s, c) => s + (c.perTurnYields.science ?? 0), 0);
  const prodPT  = cities.reduce((s, c) => s + (c.perTurnYields.production ?? 0), 0);
  const foodPT  = cities.reduce((s, c) => s + (c.perTurnYields.food ?? 0), 0);
  const buildings = cities.reduce((s, c) => s + c.buildings.length, 0);
  const pop       = cities.reduce((s, c) => s + c.population, 0);
  const tilesOwned = (view.map?.tiles ?? []).filter(
    (t) => t.ownerCityId && cities.some((c) => c.id === t.ownerCityId),
  ).length;

  return {
    id: playerId,
    cities: cities.length,
    units: units.length,
    unitsByType,
    gold: player?.gold ?? 0,
    goldPerTurn: goldPT,
    sciencePerTurn: sciPT,
    productionPerTurn: prodPT,
    foodPerTurn: foodPT,
    techs: player?.researchedTechs.length ?? 0,
    currentTech: player?.currentTech ?? null,
    totalBuildings: buildings,
    totalPopulation: pop,
    tilesOwned,
  };
}

export function snapTurn(
  view: MatchView,
  agentId: string,
  cumKills: number,
  cumCaptures: number,
): TurnSnap {
  const tiles = view.map?.tiles ?? [];
  const seenTiles = tiles.filter((t) => t.visibility !== "unseen").length;
  const opponentId = view.players.find((p) => p.id !== agentId)?.id ?? null;

  return {
    turn: view.turnNumber,
    seenTiles,
    totalTiles: tiles.length || 1,
    cumKills,
    cumCaptures,
    agent: snapPlayer(view, agentId),
    opponent: opponentId ? snapPlayer(view, opponentId) : null,
  };
}
