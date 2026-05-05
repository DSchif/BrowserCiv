import { z } from "zod";
import { DisplayText } from "./common.js";
import { DomainId, TraitId } from "./ids.js";

/**
 * A domain is a "layer of space" on a tile (land/ocean/air/spirit/...).
 * Multiple domains can coexist on a single tile; a unit occupies one.
 * Critical for asymmetric civs (flying cities, water-only cities, etc.).
 */
export const Domain = z
  .object({
    id: DomainId,
    name: DisplayText,
    description: DisplayText.optional(),
    layer: z.number().int(),
    default_passable_by_traits: z.array(TraitId).default([]),
  })
  .strict();

export type Domain = z.infer<typeof Domain>;
