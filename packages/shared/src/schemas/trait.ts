import { z } from "zod";
import { DisplayText } from "./common.js";
import { TraitId } from "./ids.js";

/**
 * A trait is a tag on units, civs, tiles, and resources.
 * Traits drive ability targeting, terrain passability, harvest eligibility, etc.
 */
export const Trait = z
  .object({
    id: TraitId,
    name: DisplayText,
    description: DisplayText.optional(),
  })
  .strict();

export type Trait = z.infer<typeof Trait>;
