import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  Building,
  Civilization,
  ContentPack,
  DiplomacyAction,
  Domain,
  Effectiveness,
  Era,
  Improvement,
  PackManifest,
  Resource,
  Tech,
  TechTree,
  Terrain,
  Trait,
  TypeDef,
  UnitDef,
  VictoryCondition,
  Wonder,
} from "../../schemas/index.js";
import type { Action, MatchState } from "../../index.js";
import { reduce } from "../reducer.js";

let cached: ContentPack | null = null;

const DIR_TO_SCHEMA: Record<string, { parse: (raw: unknown) => unknown }> = {
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

const DIR_TO_BUCKET: Record<string, keyof Omit<ContentPack, "manifest">> = {
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

async function loadPackInline(packDir: string): Promise<ContentPack> {
  const manifestText = await fs.readFile(path.join(packDir, "pack.json"), "utf8");
  const manifest = PackManifest.parse(JSON.parse(manifestText));

  const buckets: Record<string, unknown[]> = {};
  for (const k of Object.values(DIR_TO_BUCKET)) buckets[k] = [];

  for (const dir of manifest.content_dirs) {
    const schema = DIR_TO_SCHEMA[dir];
    const bucket = DIR_TO_BUCKET[dir];
    if (!schema || !bucket) continue;
    let entries;
    try {
      entries = await fs.readdir(path.join(packDir, dir), { withFileTypes: true });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      const file = path.join(packDir, dir, e.name);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) buckets[bucket]!.push(schema.parse(item));
    }
  }
  return ContentPack.parse({ manifest, ...buckets });
}

export async function getPack(): Promise<ContentPack> {
  if (cached) return cached;
  const dir = path.resolve(
    new URL(".", import.meta.url).pathname,
    "../../../../../content/core-realworld",
  );
  cached = await loadPackInline(dir);
  return cached;
}

export function play(
  prev: MatchState | null,
  actions: Action[],
  pack: ContentPack,
): MatchState {
  let s = prev;
  for (const a of actions) s = reduce(s, a, pack);
  if (!s) throw new Error("play() did not produce a state");
  return s;
}

export function lobby(pack: ContentPack, seed = 1): MatchState {
  const create: Action = {
    type: "MatchCreate",
    matchId: "m1",
    hostId: "alice",
    hostName: "Alice",
    hostCivId: "civ.romans",
    contentPackId: "core.realworld",
    seed,
    mapSize: "small",
    maxPlayers: 4,
    createdAt: "2026-01-01T00:00:00Z",
  };
  return play(null, [create, { type: "PlayerJoin", playerId: "bob", name: "Bob", civId: "civ.greeks" }], pack);
}

export function started(pack: ContentPack, seed = 1): MatchState {
  return play(
    lobby(pack, seed),
    [{ type: "MatchStart", actorId: "alice", startedAt: "2026-01-01T00:01:00Z" }],
    pack,
  );
}
