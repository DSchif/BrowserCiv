import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { Cost, DisplayText, Yields } from "./common.js";
import { BuildingId, EraId, ResourceId, TechId, TerrainId } from "./ids.js";

export const Building = z
  .object({
    id: BuildingId,
    name: DisplayText,
    description: DisplayText.optional(),
    cost: Cost,
    prereq_tech: TechId.optional(),
    era_required: EraId.optional(),
    /** Yields applied to the city this is built in. */
    city_yields: Yields.default({}),
    /** Yields added to specific terrain types worked by the city. */
    terrain_yield_bonus: z
      .array(
        z
          .object({
            terrain: TerrainId,
            yields: Yields,
          })
          .strict(),
      )
      .default([]),
    abilities: z.array(AbilityRef).default([]),
    maintenance_gold: z.number().int().nonnegative().default(0),
    /**
     * Resource ids that must be present on at least one tile owned by the
     * city for this building to be constructable. Empty = no resource gate.
     */
    requires_resources: z.array(ResourceId).default([]),
  })
  .strict();

export type Building = z.infer<typeof Building>;
