import { z } from "zod";

const Coord = z.object({
  q: z.number().int(),
  r: z.number().int(),
});

const ProductionItemSchema = z.union([
  z.object({ kind: z.literal("unit"), defId: z.string().min(1) }),
  z.object({ kind: z.literal("building"), defId: z.string().min(1) }),
  z.object({ kind: z.literal("wonder"), defId: z.string().min(1) }),
]);

export const MapSizeSchema = z.enum(["small", "medium", "large"]);

export const ActionMatchCreate = z.object({
  type: z.literal("MatchCreate"),
  matchId: z.string().min(1),
  hostId: z.string().min(1),
  hostName: z.string().min(1).max(40),
  hostCivId: z.string().min(1),
  contentPackId: z.string().min(1),
  seed: z.number().int(),
  mapSize: MapSizeSchema,
  maxPlayers: z.number().int().min(2).max(8),
  createdAt: z.string(),
});

export const ActionPlayerJoin = z.object({
  type: z.literal("PlayerJoin"),
  playerId: z.string().min(1),
  name: z.string().min(1).max(40),
  civId: z.string().min(1),
});

export const ActionPlayerLeave = z.object({
  type: z.literal("PlayerLeave"),
  playerId: z.string().min(1),
});

export const ActionSetConnected = z.object({
  type: z.literal("SetConnected"),
  playerId: z.string().min(1),
  connected: z.boolean(),
});

export const ActionMatchStart = z.object({
  type: z.literal("MatchStart"),
  actorId: z.string().min(1),
  startedAt: z.string(),
});

export const ActionEndTurn = z.object({
  type: z.literal("EndTurn"),
  actorId: z.string().min(1),
});

export const ActionMoveUnit = z.object({
  type: z.literal("MoveUnit"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
  target: Coord,
  /** Optional melee attack id to use if the move resolves into an attack. */
  attackId: z.string().min(1).optional(),
});

export const ActionFoundCity = z.object({
  type: z.literal("FoundCity"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
});

export const ActionSetCityProduction = z.object({
  type: z.literal("SetCityProduction"),
  actorId: z.string().min(1),
  cityId: z.string().min(1),
  item: ProductionItemSchema.nullable(),
});

export const ActionSetResearch = z.object({
  type: z.literal("SetResearch"),
  actorId: z.string().min(1),
  techId: z.string().min(1).nullable(),
});

export const ActionUpgradeUnit = z.object({
  type: z.literal("UpgradeUnit"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
});

export const ActionDeclareWar = z.object({
  type: z.literal("DeclareWar"),
  actorId: z.string().min(1),
  targetPlayerId: z.string().min(1),
});

export const ActionMakePeace = z.object({
  type: z.literal("MakePeace"),
  actorId: z.string().min(1),
  targetPlayerId: z.string().min(1),
});

export const ActionRangedAttack = z.object({
  type: z.literal("RangedAttack"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
  targetUnitId: z.string().min(1),
  /** Optional attack id to use; defaults to first available ranged attack. */
  attackId: z.string().min(1).optional(),
});

export const ActionBuildImprovement = z.object({
  type: z.literal("BuildImprovement"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
  improvementId: z.string().min(1),
});

export const ActionFortify = z.object({
  type: z.literal("Fortify"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
});

export const ActionBuyProduction = z.object({
  type: z.literal("BuyProduction"),
  actorId: z.string().min(1),
  cityId: z.string().min(1),
});

export const ActionCityRangedAttack = z.object({
  type: z.literal("CityRangedAttack"),
  actorId: z.string().min(1),
  cityId: z.string().min(1),
  targetUnitId: z.string().min(1),
  attackId: z.string().min(1).optional(),
});

export const ActionBoardShip = z.object({
  type: z.literal("BoardShip"),
  actorId: z.string().min(1),
  unitId: z.string().min(1),
  shipId: z.string().min(1),
});

export const ActionDisembark = z.object({
  type: z.literal("Disembark"),
  actorId: z.string().min(1),
  shipId: z.string().min(1),
  unitId: z.string().min(1),
  target: Coord,
});

export const Action = z.discriminatedUnion("type", [
  ActionMatchCreate,
  ActionPlayerJoin,
  ActionPlayerLeave,
  ActionSetConnected,
  ActionMatchStart,
  ActionEndTurn,
  ActionMoveUnit,
  ActionFoundCity,
  ActionSetCityProduction,
  ActionSetResearch,
  ActionUpgradeUnit,
  ActionDeclareWar,
  ActionMakePeace,
  ActionRangedAttack,
  ActionBuildImprovement,
  ActionFortify,
  ActionBuyProduction,
  ActionCityRangedAttack,
  ActionBoardShip,
  ActionDisembark,
]);

export type Action = z.infer<typeof Action>;

export const Intent = z.discriminatedUnion("type", [
  ActionMatchStart.pick({ type: true, actorId: true }),
  ActionEndTurn.pick({ type: true, actorId: true }),
  ActionMoveUnit.pick({ type: true, actorId: true, unitId: true, target: true, attackId: true }),
  ActionFoundCity.pick({ type: true, actorId: true, unitId: true }),
  ActionSetCityProduction.pick({
    type: true,
    actorId: true,
    cityId: true,
    item: true,
  }),
  ActionSetResearch.pick({ type: true, actorId: true, techId: true }),
  ActionUpgradeUnit.pick({ type: true, actorId: true, unitId: true }),
  ActionDeclareWar.pick({ type: true, actorId: true, targetPlayerId: true }),
  ActionMakePeace.pick({ type: true, actorId: true, targetPlayerId: true }),
  ActionRangedAttack.pick({ type: true, actorId: true, unitId: true, targetUnitId: true, attackId: true }),
  ActionBuildImprovement.pick({ type: true, actorId: true, unitId: true, improvementId: true }),
  ActionFortify.pick({ type: true, actorId: true, unitId: true }),
  ActionBuyProduction.pick({ type: true, actorId: true, cityId: true }),
  ActionCityRangedAttack.pick({ type: true, actorId: true, cityId: true, targetUnitId: true, attackId: true }),
  ActionBoardShip.pick({ type: true, actorId: true, unitId: true, shipId: true }),
  ActionDisembark.pick({ type: true, actorId: true, shipId: true, unitId: true, target: true }),
]);

export type Intent = z.infer<typeof Intent>;
