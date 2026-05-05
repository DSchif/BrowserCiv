import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { DisplayText } from "./common.js";
import {
  BuildingId,
  CivilizationId,
  DomainId,
  PackId,
  ResourceId,
  TechId,
  TechTreeId,
  TraitId,
  UnitId,
  WonderId,
} from "./ids.js";

export const ResourceAccess = z
  .object({
    /** "all" or explicit list. */
    can_use: z.union([z.literal("all"), z.array(ResourceId)]).default("all"),
    /**
     * "computed" means: derive from this civ's units' harvest_traits.
     * Otherwise an explicit allow-list of resource ids.
     */
    can_harvest: z
      .union([z.literal("computed"), z.array(ResourceId)])
      .default("computed"),
  })
  .strict();
export type ResourceAccess = z.infer<typeof ResourceAccess>;

export const Civilization = z
  .object({
    id: CivilizationId,
    pack: PackId,
    name: DisplayText,
    leader_name: DisplayText,
    /** Civ V style two-color identity. Primary = territory fill / icon background.
     *  Secondary = territory border / icon glyph. */
    primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),

    /** The default domain for this civ's cities and starting units. */
    home_domain: DomainId,

    starting_units: z.array(UnitId).default([]),
    starting_techs: z.array(TechId).default([]),

    tech_tree_id: TechTreeId,

    unique_units: z.array(UnitId).default([]),
    unique_buildings: z.array(BuildingId).default([]),
    unique_wonders: z.array(WonderId).default([]),

    /** Civ-wide traits applied to the player and (optionally) propagated to all their units. */
    traits: z.array(TraitId).default([]),

    /** Civ-wide passive/active abilities. */
    abilities: z.array(AbilityRef).default([]),

    resource_access: ResourceAccess.default({
      can_use: "all",
      can_harvest: "computed",
    }),
  })
  .strict();

export type Civilization = z.infer<typeof Civilization>;
