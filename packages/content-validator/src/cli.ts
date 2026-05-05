#!/usr/bin/env node
import * as path from "node:path";
import { validatePack } from "./load.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const arg = args[0];
  if (!arg) {
    console.error("usage: browserciv-validate <pack-dir>");
    process.exit(2);
  }
  const dir = path.resolve(arg);
  const result = await validatePack(dir);

  if (result.ok && result.pack) {
    const p = result.pack;
    console.log(`OK  ${p.manifest.id}@${p.manifest.version} — ${p.manifest.name}`);
    console.log(
      `    ${p.civilizations.length} civs, ${p.units.length} units, ` +
        `${p.techs.length} techs across ${p.tech_trees.length} trees, ` +
        `${p.resources.length} resources, ${p.terrains.length} terrains, ` +
        `${p.domains.length} domains, ${p.traits.length} traits, ` +
        `${p.eras.length} eras, ${p.buildings.length} buildings, ` +
        `${p.wonders.length} wonders, ${p.diplomacy_actions.length} diplomacy actions, ` +
        `${p.victory_conditions.length} victory conditions`,
    );
    process.exit(0);
  }

  console.error(`FAIL  ${dir}`);
  for (const issue of result.issues) {
    const where = [issue.file, issue.path].filter(Boolean).join(":");
    console.error(`  ${where ? where + " — " : ""}${issue.message}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
