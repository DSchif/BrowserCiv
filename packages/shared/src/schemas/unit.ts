import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { Cost, DisplayText } from "./common.js";
import {
  DomainId,
  EraId,
  TechId,
  TerrainId,
  TraitId,
  UnitId,
} from "./ids.js";

export const UnitCombat = z
  .object({
    strength: z.number().int().nonnegative().default(0),
    ranged_strength: z.number().int().nonnegative().optional(),
    range: z.number().int().positive().optional(),
  })
  .strict();
export type UnitCombat = z.infer<typeof UnitCombat>;

export const UnitMovementRules = z
  .object({
    ignores_terrain_cost: z.array(TerrainId).default([]),
    embark_allowed: z.boolean().default(false),
  })
  .strict();
export type UnitMovementRules = z.infer<typeof UnitMovementRules>;

export const UnitDef = z
  .object({
    id: UnitId,
    name: DisplayText,
    description: DisplayText.optional(),

    /** Primary domain the unit occupies on a tile. */
    domain: DomainId,
    /** Domains the unit may pass through. Includes its primary by default; amphibious units add others. */
    passable_domains: z.array(DomainId).default([]),

    movement: z.number().int().nonnegative().default(2),
    movement_rules: UnitMovementRules.default({
      ignores_terrain_cost: [],
      embark_allowed: false,
    }),

    combat: UnitCombat.default({ strength: 0 }),

    cost: Cost,

    /** Gold deducted from the owner's treasury each time their turn is processed. */
    maintenance_gold: z.number().int().nonnegative().default(0),

    prereq_tech: TechId.optional(),
    era_required: EraId,

    /** Era-based evolution path. null = terminal unit. */
    evolves_to: UnitId.nullable().default(null),
    upgrade_cost: Cost.default({}),

    /** Civilization-style traits applied to the unit ("mounted", "naval", "airbender", ...). */
    traits: z.array(TraitId).default([]),

    /**
     * If a resource is tagged with any of these traits in its harvestable_by_traits,
     * this unit can harvest it. Drives the cross-civ asymmetry mechanic.
     */
    harvest_traits: z.array(TraitId).default([]),

    /**
     * Per-unit terrain entry costs. 0 means the unit cannot enter that terrain.
     * If a terrain id is missing AND this map is non-empty, the terrain is
     * treated as impassable for this unit. If the map is empty (legacy units),
     * pathfinding falls back to terrain.movement_cost + terrain.impassable.
     *
     * Examples: { plains: 0.5, hills: 1, mountain: 3, ocean: 0 }.
     */
    terrain_costs: z.record(z.string(), z.number().min(0)).default({}),

    /**
     * Defensive types this unit is. Used to look up effectiveness multipliers
     * when this unit is the defender. If empty, derived from `traits`.
     */
    unit_types: z.array(z.string()).default([]),

    /** How many other units this unit (typically a ship) can carry. 0 = none. */
    transport_capacity: z.number().int().min(0).default(0),

    /**
     * Attacks this unit can use. If empty, a default melee attack is derived
     * from `combat.strength`, and a default ranged from `combat.ranged_strength`.
     */
    attacks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            types: z.array(z.string()).default([]),
            range: z.number().int().min(1).default(1),
            damage: z.number().int().min(0).default(0),
            cooldown: z.number().int().min(0).default(0),
            charges: z.number().int().positive().optional(),
            description: z.string().optional(),
          })
          .strict(),
      )
      .default([]),

    abilities: z.array(AbilityRef).default([]),
  })
  .strict();

export type UnitDef = z.infer<typeof UnitDef>;
