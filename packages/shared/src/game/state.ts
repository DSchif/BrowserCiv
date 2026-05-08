import type { AxialCoord } from "../hex.js";
import type { Yields } from "../schemas/common.js";
import type { RngState } from "./rng.js";

export type MatchStatus = "lobby" | "in_progress" | "finished";

export type VictoryReason = "domination" | "time" | "abandoned";

export interface Player {
  id: string;
  name: string;
  primary_color: string;
  secondary_color: string;
  civId: string | null;
  connected: boolean;
  startingHex: AxialCoord | null;
  /** Treasuries — accumulated over the game. */
  gold: number;
  /** Science accumulated toward the currently selected tech (resets when one completes). */
  science: number;
  culture: number;

  // ---------- Tech state ----------
  /** Tech IDs the player has researched (in completion order). */
  researchedTechs: string[];
  /** Tech currently being researched, or null if none selected. */
  currentTech: string | null;
  /** Current era id, derived from researched techs. */
  era: string;
  /** Available resource pool keyed by resource id (produced by worked tiles − consumed by living units). */
  availableResources: Record<string, number>;
}

export interface Tile {
  q: number;
  r: number;
  terrain: string;
  /** Optional resource id present on this tile. */
  resource?: string;
  /** Built improvement on this tile (e.g. "improvement.farm"). */
  improvement?: string;
  /** Worker currently building an improvement on this tile. */
  workInProgress?: {
    unitId: string;
    improvementId: string;
    turnsLeft: number;
  };
}

export type MapSize = "small" | "medium" | "large";

export interface GameMap {
  width: number;
  height: number;
  tiles: Tile[];
}

export interface Unit {
  id: string;
  ownerId: string;
  defId: string;
  position: AxialCoord;
  movementMax: number;
  movementLeft: number;
  hp: number;
  hpMax: number;
  /** Whether the unit is fortified (defensive stance). Cleared on move/attack. */
  fortified?: boolean;
  /** Whether the unit attacked this turn (blocks healing this round). */
  attackedThisTurn?: boolean;
  /** Per-attack cooldowns: attackId → turns remaining until usable again. */
  attackCooldowns?: Record<string, number>;
  /** Per-attack charges already used (for one-shot attacks with `charges` set). */
  attackChargesUsed?: Record<string, number>;
  /** Queued movement waypoints — consumed at start of owner's turn. */
  pendingPath?: AxialCoord[];
  /** When boarded on a ship, this is the ship's unit id. Position mirrors the ship. */
  boardedOn?: string;
}

export type ProductionItem =
  | { kind: "unit"; defId: string }
  | { kind: "building"; defId: string }
  | { kind: "wonder"; defId: string };

export interface City {
  id: string;
  ownerId: string;
  name: string;
  position: AxialCoord;
  population: number;
  food: number;
  foodToGrow: number;
  production: number;
  productionItem: ProductionItem | null;
  buildings: string[];
  /** Wonders constructed in this city (e.g. "wonder.pyramids"). */
  wonders: string[];
  /** Hex keys this city is currently working — denormalized so the client can render them. */
  workedTiles: string[];
  /** All hex keys this city owns (initially radius-2 footprint, grows via culture). */
  ownedTiles: string[];
  perTurnYields: Yields;
  hp: number;
  hpMax: number;
  foundedTurn: number;
  /** Culture accumulated toward next border expansion. */
  cultureAccumulated: number;
  /** Threshold for next expansion (rises after each tile claim). */
  cultureToExpand: number;
  /** Whether the city has used its ranged strike this turn (cleared at owner's turn start). */
  hasFiredThisTurn?: boolean;
}

export interface MatchState {
  id: string;
  seed: number;
  rng: RngState;
  status: MatchStatus;
  hostId: string;
  contentPackId: string;
  players: Player[];
  currentPlayerIndex: number;
  turnNumber: number;
  map: GameMap | null;
  units: Unit[];
  cities: City[];
  /** Hex key → cityId. Determines whose tiles are whose. */
  tileOwnership: Record<string, string>;
  /** Tiles each player has ever seen. */
  seenTiles: Record<string, string[]>;
  actionSeq: number;
  createdAt: string;
  startedAt: string | null;
  log: MatchLogEntry[];
  /** Diplomatic relations keyed by sorted "playerA:playerB"; only "war" is stored. Absence = peace. */
  diplomacy: Record<string, "war">;
  /** Map of wonderId → cityId that built it. One per match. */
  wondersBuilt: Record<string, string>;
  /** Set when the match has finished — winner id + reason, or null if no winner (timeout draw). */
  winnerId?: string | null;
  victoryReason?: VictoryReason;
  nextUnitId: number;
  nextCityId: number;
  /** Per-civ city counter, used for naming. */
  cityCounters: Record<string, number>;
  /** Map size chosen at match creation. */
  mapSize: MapSize;
  /** When true, all tiles are always visible to all players (no fog of war). */
  noFog: boolean;
}

export interface MatchLogEntry {
  turn: number;
  actionSeq: number;
  text: string;
}

export interface MatchSummary {
  id: string;
  status: MatchStatus;
  hostId: string;
  hostName: string;
  /** Account username of the player who created the match. */
  createdByAccount?: string;
  playerCount: number;
  maxPlayers: number;
  turnNumber: number;
  createdAt: string;
}

// ---------- Per-player view ----------

export type TileVisibility = "unseen" | "seen" | "visible";

export interface TileView extends Tile {
  visibility: TileVisibility;
  /** cityId of the owner if any, only filled for tiles the viewer can see. */
  ownerCityId?: string;
  /** Resource is filled only when the viewer's tech allows seeing this resource. */
  resource?: string;
  /** Improvement on this tile, only set when the viewer can see it. */
  improvement?: string;
}

export interface MapView {
  width: number;
  height: number;
  tiles: TileView[];
}

export interface MatchView {
  id: string;
  status: MatchStatus;
  hostId: string;
  contentPackId: string;
  viewerId: string;
  players: Player[];
  currentPlayerIndex: number;
  turnNumber: number;
  map: MapView | null;
  units: Unit[];
  cities: City[];
  /** Diplomatic relations involving the viewer. */
  diplomacy: Record<string, "war">;
  /** Map of wonderId → cityId that built it. */
  wondersBuilt: Record<string, string>;
  /** Winner of a finished match. */
  winnerId?: string | null;
  victoryReason?: VictoryReason;
  actionSeq: number;
  createdAt: string;
  startedAt: string | null;
  log: MatchLogEntry[];
}
