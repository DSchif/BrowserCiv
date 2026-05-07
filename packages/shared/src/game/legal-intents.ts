import { neighbors } from "../hex.js";
import type { ContentPack } from "../schemas/index.js";
import type { Intent } from "./actions.js";
import { unitCanEnter } from "./path.js";
import type { MatchView } from "./state.js";

/**
 * Enumerate every legal intent for `playerId` given the current view.
 *
 * This is the action space for any learning agent.  The list always contains
 * at least EndTurn; every other entry has passed a lightweight legality check
 * (terrain passability, occupancy, tech prereqs).  The reducer is still
 * authoritative — a returned intent may occasionally be rejected for subtle
 * reasons (e.g. stacking rules) but the vast majority will succeed.
 */
export function getLegalIntents(
  view: MatchView,
  playerId: string,
  content: ContentPack,
): Intent[] {
  const intents: Intent[] = [];

  // ── EndTurn is always available ──────────────────────────────────────────
  intents.push({ type: "EndTurn", actorId: playerId });

  const tiles = new Map(
    (view.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]),
  );
  const occupiedKeys = new Set(
    view.units.map((u) => `${u.position.q},${u.position.r}`),
  );
  const cityKeys = new Set(
    view.cities.map((c) => `${c.position.q},${c.position.r}`),
  );

  const me = view.players.find((p) => p.id === playerId);
  const researchedTechs = new Set(me?.researchedTechs ?? []);

  // ── Unit actions ─────────────────────────────────────────────────────────
  for (const unit of view.units) {
    if (unit.ownerId !== playerId) continue;
    if (unit.movementLeft <= 0) continue;

    const unitDef = content.units.find(
      (u) => (u.id as unknown as string) === unit.defId,
    );

    // FoundCity — settler on a non-city tile
    if (unit.defId === "unit.settler") {
      const k = `${unit.position.q},${unit.position.r}`;
      if (!cityKeys.has(k)) {
        intents.push({ type: "FoundCity", actorId: playerId, unitId: unit.id });
      }
    }

    // MoveUnit — each passable, unoccupied, non-city neighbour
    for (const nb of neighbors(unit.position)) {
      const k = `${nb.q},${nb.r}`;
      const tile = tiles.get(k);
      if (!tile) continue;
      if (occupiedKeys.has(k)) continue;
      if (cityKeys.has(k)) continue;
      const terrain = content.terrains.find(
        (t) => (t.id as unknown as string) === tile.terrain,
      );
      if (!terrain) continue;
      if (unitCanEnter(unitDef, terrain) === null) continue;
      intents.push({ type: "MoveUnit", actorId: playerId, unitId: unit.id, target: nb });
    }
  }

  // ── City production ───────────────────────────────────────────────────────
  for (const city of view.cities) {
    if (city.ownerId !== playerId) continue;
    if (city.productionItem) continue; // already producing something

    for (const unitDef of content.units) {
      const defId = unitDef.id as unknown as string;
      const prereq = (unitDef as Record<string, unknown>).prereq_tech as string | undefined;
      if (prereq && !researchedTechs.has(prereq)) continue;
      intents.push({
        type: "SetCityProduction",
        actorId: playerId,
        cityId: city.id,
        item: { kind: "unit", defId },
      });
    }

    for (const building of content.buildings) {
      const defId = building.id as unknown as string;
      const prereq = (building as Record<string, unknown>).prereq_tech as string | undefined;
      if (prereq && !researchedTechs.has(prereq)) continue;
      if ((city.buildings ?? []).includes(defId)) continue;
      intents.push({
        type: "SetCityProduction",
        actorId: playerId,
        cityId: city.id,
        item: { kind: "building", defId },
      });
    }
  }

  // ── Research ─────────────────────────────────────────────────────────────
  if (me && !me.currentTech) {
    const playerCiv = content.civilizations.find(
      (c) => (c.id as unknown as string) === me.civId,
    );
    const treeId = (playerCiv as Record<string, unknown>)?.tech_tree_id as string | undefined;

    for (const tech of content.techs) {
      const techId = tech.id as unknown as string;
      if (researchedTechs.has(techId)) continue;
      if (treeId && (tech as Record<string, unknown>).tree_id !== treeId) continue;
      const prereqs = (tech.prereqs as unknown as string[]) ?? [];
      if (!prereqs.every((p) => researchedTechs.has(p))) continue;
      intents.push({ type: "SetResearch", actorId: playerId, techId });
    }
  }

  return intents;
}
