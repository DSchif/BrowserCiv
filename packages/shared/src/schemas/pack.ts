import { z } from "zod";
import { Building } from "./building.js";
import { Civilization } from "./civilization.js";
import { Improvement } from "./improvement.js";
import { DisplayText, SemVer } from "./common.js";
import { Effectiveness, TypeDef } from "./type.js";
import { DiplomacyAction } from "./diplomacy.js";
import { Domain } from "./domain.js";
import { Era } from "./era.js";
import { PackId } from "./ids.js";
import { Resource } from "./resource.js";
import { Tech, TechTree } from "./tech.js";
import { Terrain } from "./terrain.js";
import { Trait } from "./trait.js";
import { UnitDef } from "./unit.js";
import { VictoryCondition } from "./victory.js";
import { Wonder } from "./wonder.js";

export const PackManifest = z
  .object({
    id: PackId,
    name: DisplayText,
    version: SemVer,
    description: DisplayText.optional(),
    author: DisplayText.optional(),
    depends_on: z.array(PackId).default([]),
    /** Subdirectories the validator should scan for content json files. */
    content_dirs: z
      .array(z.string().min(1))
      .default([
        "domains",
        "traits",
        "terrains",
        "resources",
        "improvements",
        "types",
        "effectiveness",
        "eras",
        "tech_trees",
        "techs",
        "units",
        "buildings",
        "wonders",
        "civilizations",
        "diplomacy",
        "victory",
      ]),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifest>;

/**
 * The fully-loaded pack, after the validator has read every JSON file
 * in the pack directory and grouped them by type.
 */
export const ContentPack = z
  .object({
    manifest: PackManifest,
    domains: z.array(Domain).default([]),
    traits: z.array(Trait).default([]),
    terrains: z.array(Terrain).default([]),
    resources: z.array(Resource).default([]),
    improvements: z.array(Improvement).default([]),
    types: z.array(TypeDef).default([]),
    effectiveness: z.array(Effectiveness).default([]),
    eras: z.array(Era).default([]),
    tech_trees: z.array(TechTree).default([]),
    techs: z.array(Tech).default([]),
    units: z.array(UnitDef).default([]),
    buildings: z.array(Building).default([]),
    wonders: z.array(Wonder).default([]),
    civilizations: z.array(Civilization).default([]),
    diplomacy_actions: z.array(DiplomacyAction).default([]),
    victory_conditions: z.array(VictoryCondition).default([]),
  })
  .strict();
export type ContentPack = z.infer<typeof ContentPack>;
