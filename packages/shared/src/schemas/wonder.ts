import { z } from "zod";
import { AbilityRef } from "./ability.js";
import { Cost, DisplayText, Yields } from "./common.js";
import { EraId, TechId, WonderId } from "./ids.js";

export const Wonder = z
  .object({
    id: WonderId,
    name: DisplayText,
    description: DisplayText.optional(),
    cost: Cost,
    prereq_tech: TechId.optional(),
    era_required: EraId.optional(),
    /** Empire-wide yield bonus. */
    empire_yields: Yields.default({}),
    /** Bonus to the city it is built in. */
    city_yields: Yields.default({}),
    abilities: z.array(AbilityRef).default([]),
  })
  .strict();

export type Wonder = z.infer<typeof Wonder>;
