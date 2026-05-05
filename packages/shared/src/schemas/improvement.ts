import { z } from "zod";
import { DisplayText, Yields } from "./common.js";
import { Id, TechId, TerrainId, ResourceId } from "./ids.js";

export const ImprovementId = Id.brand<"ImprovementId">();
export type ImprovementId = z.infer<typeof ImprovementId>;

/**
 * Worker-built tile improvement (Civ V style).
 * - terrain_compat lists terrains the improvement can be built on.
 * - yield_bonus is added to the tile's yields when worked.
 * - build_turns is the number of full turns the worker must spend on the tile.
 * - prereq_tech (optional) gates availability.
 */
export const Improvement = z
  .object({
    id: ImprovementId,
    name: DisplayText,
    description: DisplayText.optional(),
    terrain_compat: z.array(TerrainId).default([]),
    /** Resources whose tile this improvement is preferred for (optional). */
    resource_compat: z.array(ResourceId).default([]),
    yield_bonus: Yields.default({}),
    build_turns: z.number().int().positive().default(5),
    prereq_tech: TechId.optional(),
  })
  .strict();

export type Improvement = z.infer<typeof Improvement>;
