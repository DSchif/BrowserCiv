import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { DisplayText } from "./common.js";
import {
  AbilityHandlerId,
  BuildingId,
  EraId,
  ResourceId,
  TechId,
  TechTreeId,
  UnitId,
  WonderId,
} from "./ids.js";

export const TechUnlocks = z
  .object({
    units: z.array(UnitId).default([]),
    buildings: z.array(BuildingId).default([]),
    wonders: z.array(WonderId).default([]),
    abilities: z.array(AbilityRef).default([]),
    resources_visible: z.array(ResourceId).default([]),
  })
  .strict();
export type TechUnlocks = z.infer<typeof TechUnlocks>;

export const Tech = z
  .object({
    id: TechId,
    tree_id: TechTreeId,
    name: DisplayText,
    description: DisplayText.optional(),
    era: EraId,
    cost: z.number().int().positive(),
    prereqs: z.array(TechId).default([]),
    unlocks: TechUnlocks.default({
      units: [],
      buildings: [],
      wonders: [],
      abilities: [],
      resources_visible: [],
    }),
  })
  .strict();
export type Tech = z.infer<typeof Tech>;

/**
 * A tech tree is just a named bag of techs. Civs reference a tree by id.
 * Trees may be entirely separate (no shared techs across trees) — fictional
 * packs (Avatar/Naruto/Pokemon) will each ship their own complete tree.
 */
export const TechTree = z
  .object({
    id: TechTreeId,
    name: DisplayText,
    description: DisplayText.optional(),
  })
  .strict();
export type TechTree = z.infer<typeof TechTree>;

export type _AbilityHandlerIdReExport = AbilityHandlerId;
