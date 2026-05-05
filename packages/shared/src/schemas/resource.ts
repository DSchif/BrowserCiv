import { z } from "zod";
import { DisplayText, Yields } from "./common.js";
import {
  CivilizationId,
  DomainId,
  Id,
  ResourceId,
  TerrainId,
  TraitId,
} from "./ids.js";

const ImprovementIdRef = Id.brand<"ImprovementId">();

export const ResourceCategory = z.enum([
  "bonus",
  "luxury",
  "strategic",
  "special",
]);
export type ResourceCategory = z.infer<typeof ResourceCategory>;

/**
 * usable_by_civs:
 *   "all" — anyone can use
 *   { civs: [...] } — only listed civs
 *   { has_trait: T } — any civ with the trait
 */
export const ResourceUsage = z.union([
  z.literal("all"),
  z.object({ civs: z.array(CivilizationId).min(1) }).strict(),
  z.object({ has_trait: TraitId }).strict(),
]);
export type ResourceUsage = z.infer<typeof ResourceUsage>;

export const Resource = z
  .object({
    id: ResourceId,
    name: DisplayText,
    description: DisplayText.optional(),
    category: ResourceCategory,
    yields: Yields.default({}),
    /** Traits a unit must have to harvest this resource. Empty = any worker can. */
    harvestable_by_traits: z.array(TraitId).default([]),
    usable_by_civs: ResourceUsage.default("all"),
    appears_on_terrains: z.array(TerrainId).default([]),
    appears_in_domains: z.array(DomainId).default([]),
    /**
     * If non-empty, this resource only contributes its yields when one of
     * these improvements is on the tile. Empty = always-on (bonus tiles).
     */
    harvested_by: z.array(ImprovementIdRef).default([]),
  })
  .strict();

export type Resource = z.infer<typeof Resource>;
