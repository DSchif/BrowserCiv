import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z, ZodError, type ZodTypeAny } from "zod";
import {
  Building,
  Civilization,
  ContentPack,
  DiplomacyAction,
  Domain,
  Era,
  Effectiveness,
  Improvement,
  PackManifest,
  Resource,
  Tech,
  TypeDef,
  TechTree,
  Terrain,
  Trait,
  UnitDef,
  VictoryCondition,
  Wonder,
} from "@browserciv/shared";

export interface ValidationIssue {
  file?: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  pack?: z.infer<typeof ContentPack>;
  issues: ValidationIssue[];
}

const DIR_TO_SCHEMA: Record<string, ZodTypeAny> = {
  domains: Domain,
  traits: Trait,
  terrains: Terrain,
  resources: Resource,
  improvements: Improvement,
  types: TypeDef,
  effectiveness: Effectiveness,
  eras: Era,
  tech_trees: TechTree,
  techs: Tech,
  units: UnitDef,
  buildings: Building,
  wonders: Wonder,
  civilizations: Civilization,
  diplomacy: DiplomacyAction,
  victory: VictoryCondition,
};

const DIR_TO_BUCKET: Record<string, keyof z.infer<typeof ContentPack>> = {
  domains: "domains",
  traits: "traits",
  terrains: "terrains",
  resources: "resources",
  improvements: "improvements",
  types: "types",
  effectiveness: "effectiveness",
  eras: "eras",
  tech_trees: "tech_trees",
  techs: "techs",
  units: "units",
  buildings: "buildings",
  wonders: "wonders",
  civilizations: "civilizations",
  diplomacy: "diplomacy_actions",
  victory: "victory_conditions",
};

async function readJsonFile(file: string): Promise<unknown> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".json")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out.sort();
}

export async function loadPack(packDir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  const manifestPath = path.join(packDir, "pack.json");
  let manifest;
  try {
    manifest = PackManifest.parse(await readJsonFile(manifestPath));
  } catch (e) {
    if (e instanceof ZodError) {
      for (const issue of e.issues) {
        issues.push({
          file: manifestPath,
          path: issue.path.join("."),
          message: issue.message,
        });
      }
    } else {
      issues.push({
        file: manifestPath,
        message: (e as Error).message,
      });
    }
    return { ok: false, issues };
  }

  const buckets: Record<string, unknown[]> = {
    domains: [],
    traits: [],
    terrains: [],
    resources: [],
    improvements: [],
    types: [],
    effectiveness: [],
    eras: [],
    tech_trees: [],
    techs: [],
    units: [],
    buildings: [],
    wonders: [],
    civilizations: [],
    diplomacy_actions: [],
    victory_conditions: [],
  };

  for (const dir of manifest.content_dirs) {
    const schema = DIR_TO_SCHEMA[dir];
    const bucket = DIR_TO_BUCKET[dir];
    if (!schema || !bucket) {
      issues.push({ message: `unknown content_dir "${dir}"` });
      continue;
    }
    const files = await listJsonFiles(path.join(packDir, dir));
    for (const file of files) {
      let raw: unknown;
      try {
        raw = await readJsonFile(file);
      } catch (e) {
        issues.push({ file, message: (e as Error).message });
        continue;
      }
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const parsed = schema.safeParse(item);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            issues.push({
              file,
              path: issue.path.join("."),
              message: issue.message,
            });
          }
        } else {
          buckets[bucket]!.push(parsed.data);
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const packParsed = ContentPack.safeParse({ manifest, ...buckets });
  if (!packParsed.success) {
    for (const issue of packParsed.error.issues) {
      issues.push({ path: issue.path.join("."), message: issue.message });
    }
    return { ok: false, issues };
  }

  return { ok: true, pack: packParsed.data, issues: [] };
}

export async function validatePack(packDir: string): Promise<ValidationResult> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok || !loaded.pack) return loaded;

  const issues: ValidationIssue[] = [];
  const pack = loaded.pack;

  const traitIds = new Set(pack.traits.map((t) => t.id));
  const domainIds = new Set(pack.domains.map((d) => d.id));
  const terrainIds = new Set(pack.terrains.map((t) => t.id));
  const resourceIds = new Set(pack.resources.map((r) => r.id));
  const eraIds = new Set(pack.eras.map((e) => e.id));
  const techTreeIds = new Set(pack.tech_trees.map((t) => t.id));
  const techIds = new Set(pack.techs.map((t) => t.id));
  const unitIds = new Set(pack.units.map((u) => u.id));
  const buildingIds = new Set(pack.buildings.map((b) => b.id));
  const wonderIds = new Set(pack.wonders.map((w) => w.id));
  const civIds = new Set(pack.civilizations.map((c) => c.id));

  function check<T extends string>(
    set: Set<T>,
    id: T | undefined | null,
    where: string,
    label: string,
  ): void {
    if (id === undefined || id === null) return;
    if (!set.has(id)) {
      issues.push({
        path: where,
        message: `references unknown ${label} "${id}"`,
      });
    }
  }

  for (const t of pack.terrains) {
    for (const trait of t.passable_by_traits)
      check(traitIds, trait, `terrain[${t.id}].passable_by_traits`, "trait");
    for (const d of t.domains) check(domainIds, d, `terrain[${t.id}].domains`, "domain");
  }

  for (const r of pack.resources) {
    for (const trait of r.harvestable_by_traits)
      check(traitIds, trait, `resource[${r.id}].harvestable_by_traits`, "trait");
    for (const terr of r.appears_on_terrains)
      check(terrainIds, terr, `resource[${r.id}].appears_on_terrains`, "terrain");
    for (const dom of r.appears_in_domains)
      check(domainIds, dom, `resource[${r.id}].appears_in_domains`, "domain");
    if (typeof r.usable_by_civs === "object") {
      if ("civs" in r.usable_by_civs) {
        for (const c of r.usable_by_civs.civs)
          check(civIds, c, `resource[${r.id}].usable_by_civs.civs`, "civilization");
      } else if ("has_trait" in r.usable_by_civs) {
        check(
          traitIds,
          r.usable_by_civs.has_trait,
          `resource[${r.id}].usable_by_civs.has_trait`,
          "trait",
        );
      }
    }
  }

  for (const tech of pack.techs) {
    check(techTreeIds, tech.tree_id, `tech[${tech.id}].tree_id`, "tech_tree");
    check(eraIds, tech.era, `tech[${tech.id}].era`, "era");
    for (const p of tech.prereqs)
      check(techIds, p, `tech[${tech.id}].prereqs`, "tech");
    for (const u of tech.unlocks.units)
      check(unitIds, u, `tech[${tech.id}].unlocks.units`, "unit");
    for (const b of tech.unlocks.buildings)
      check(buildingIds, b, `tech[${tech.id}].unlocks.buildings`, "building");
    for (const w of tech.unlocks.wonders)
      check(wonderIds, w, `tech[${tech.id}].unlocks.wonders`, "wonder");
    for (const r of tech.unlocks.resources_visible)
      check(resourceIds, r, `tech[${tech.id}].unlocks.resources_visible`, "resource");
  }

  for (const u of pack.units) {
    check(domainIds, u.domain, `unit[${u.id}].domain`, "domain");
    for (const d of u.passable_domains)
      check(domainIds, d, `unit[${u.id}].passable_domains`, "domain");
    if (u.prereq_tech)
      check(techIds, u.prereq_tech, `unit[${u.id}].prereq_tech`, "tech");
    check(eraIds, u.era_required, `unit[${u.id}].era_required`, "era");
    if (u.evolves_to) check(unitIds, u.evolves_to, `unit[${u.id}].evolves_to`, "unit");
    for (const t of u.traits) check(traitIds, t, `unit[${u.id}].traits`, "trait");
    for (const t of u.harvest_traits)
      check(traitIds, t, `unit[${u.id}].harvest_traits`, "trait");
    for (const terr of u.movement_rules.ignores_terrain_cost)
      check(terrainIds, terr, `unit[${u.id}].movement_rules.ignores_terrain_cost`, "terrain");
  }

  for (const b of pack.buildings) {
    if (b.prereq_tech) check(techIds, b.prereq_tech, `building[${b.id}].prereq_tech`, "tech");
    if (b.era_required) check(eraIds, b.era_required, `building[${b.id}].era_required`, "era");
    for (const tb of b.terrain_yield_bonus)
      check(terrainIds, tb.terrain, `building[${b.id}].terrain_yield_bonus.terrain`, "terrain");
  }

  for (const w of pack.wonders) {
    if (w.prereq_tech) check(techIds, w.prereq_tech, `wonder[${w.id}].prereq_tech`, "tech");
    if (w.era_required) check(eraIds, w.era_required, `wonder[${w.id}].era_required`, "era");
  }

  for (const c of pack.civilizations) {
    check(domainIds, c.home_domain, `civilization[${c.id}].home_domain`, "domain");
    check(techTreeIds, c.tech_tree_id, `civilization[${c.id}].tech_tree_id`, "tech_tree");
    for (const u of c.starting_units)
      check(unitIds, u, `civilization[${c.id}].starting_units`, "unit");
    for (const t of c.starting_techs)
      check(techIds, t, `civilization[${c.id}].starting_techs`, "tech");
    for (const u of c.unique_units)
      check(unitIds, u, `civilization[${c.id}].unique_units`, "unit");
    for (const b of c.unique_buildings)
      check(buildingIds, b, `civilization[${c.id}].unique_buildings`, "building");
    for (const w of c.unique_wonders)
      check(wonderIds, w, `civilization[${c.id}].unique_wonders`, "wonder");
    for (const t of c.traits)
      check(traitIds, t, `civilization[${c.id}].traits`, "trait");
    if (Array.isArray(c.resource_access.can_use)) {
      for (const r of c.resource_access.can_use)
        check(resourceIds, r, `civilization[${c.id}].resource_access.can_use`, "resource");
    }
    if (Array.isArray(c.resource_access.can_harvest)) {
      for (const r of c.resource_access.can_harvest)
        check(resourceIds, r, `civilization[${c.id}].resource_access.can_harvest`, "resource");
    }
  }

  for (const era of pack.eras) {
    for (const t of era.unlocked_by_techs)
      check(techIds, t, `era[${era.id}].unlocked_by_techs`, "tech");
  }

  return { ok: issues.length === 0, pack, issues };
}
