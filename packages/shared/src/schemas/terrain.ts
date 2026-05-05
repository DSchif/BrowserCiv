import { z } from "zod";
import { DisplayText, Yields } from "./common.js";
import { DomainId, TerrainId, TraitId } from "./ids.js";

export const Terrain = z
  .object({
    id: TerrainId,
    name: DisplayText,
    description: DisplayText.optional(),
    base_yields: Yields.default({}),
    movement_cost: z.number().nonnegative().default(1),
    impassable: z.boolean().default(false),
    /** Traits a unit must have to enter this terrain (empty = any unit). */
    passable_by_traits: z.array(TraitId).default([]),
    /** Domains that exist on this terrain by default. Land tiles include "land"; coast tiles "coast"+"ocean"; etc. */
    domains: z.array(DomainId).min(1),
  })
  .strict();

export type Terrain = z.infer<typeof Terrain>;
