import { z } from "zod";

const idPattern = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(idPattern, "ids must be lowercase, dot-separated segments");

export type Id = z.infer<typeof Id>;

export const PackId = Id.brand<"PackId">();
export const CivilizationId = Id.brand<"CivilizationId">();
export const UnitId = Id.brand<"UnitId">();
export const BuildingId = Id.brand<"BuildingId">();
export const WonderId = Id.brand<"WonderId">();
export const TechId = Id.brand<"TechId">();
export const TechTreeId = Id.brand<"TechTreeId">();
export const EraId = Id.brand<"EraId">();
export const ResourceId = Id.brand<"ResourceId">();
export const TerrainId = Id.brand<"TerrainId">();
export const DomainId = Id.brand<"DomainId">();
export const TraitId = Id.brand<"TraitId">();
export const AbilityHandlerId = Id.brand<"AbilityHandlerId">();
export const DiplomacyActionId = Id.brand<"DiplomacyActionId">();
export const VictoryConditionId = Id.brand<"VictoryConditionId">();

export type PackId = z.infer<typeof PackId>;
export type CivilizationId = z.infer<typeof CivilizationId>;
export type UnitId = z.infer<typeof UnitId>;
export type BuildingId = z.infer<typeof BuildingId>;
export type WonderId = z.infer<typeof WonderId>;
export type TechId = z.infer<typeof TechId>;
export type TechTreeId = z.infer<typeof TechTreeId>;
export type EraId = z.infer<typeof EraId>;
export type ResourceId = z.infer<typeof ResourceId>;
export type TerrainId = z.infer<typeof TerrainId>;
export type DomainId = z.infer<typeof DomainId>;
export type TraitId = z.infer<typeof TraitId>;
export type AbilityHandlerId = z.infer<typeof AbilityHandlerId>;
export type DiplomacyActionId = z.infer<typeof DiplomacyActionId>;
export type VictoryConditionId = z.infer<typeof VictoryConditionId>;
