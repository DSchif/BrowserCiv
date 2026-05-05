import type { ContentPack, Tech } from "../schemas/index.js";
import type { Player } from "./state.js";

/** Earliest era id by `order` field — fallback when player has researched nothing. */
export function defaultEra(content: ContentPack): string {
  const sorted = [...content.eras].sort((a, b) => a.order - b.order);
  return (sorted[0]?.id as unknown as string) ?? "ancient";
}

/** Compute the era a player belongs in based on their highest researched tech. */
export function computeEra(player: Player, content: ContentPack): string {
  const eraOrder = new Map<string, number>(
    content.eras.map((e) => [e.id as unknown as string, e.order]),
  );
  const baseEra = defaultEra(content);
  let bestId = baseEra;
  let bestOrder = eraOrder.get(baseEra) ?? 0;
  for (const techId of player.researchedTechs) {
    const tech = content.techs.find((t) => (t.id as unknown as string) === techId);
    if (!tech) continue;
    const eraId = tech.era as unknown as string;
    const order = eraOrder.get(eraId);
    if (order === undefined) continue;
    if (order > bestOrder) {
      bestOrder = order;
      bestId = eraId;
    }
  }
  return bestId;
}

/** Lookup a tech def, returning typed result. */
export function lookupTech(content: ContentPack, techId: string): Tech | undefined {
  return content.techs.find((t) => (t.id as unknown as string) === techId);
}

/** Tech tree id assigned to this player's civ, or null if civ unknown. */
export function playerTechTreeId(player: Player, content: ContentPack): string | null {
  if (!player.civId) return null;
  const civ = content.civilizations.find((c) => (c.id as unknown as string) === player.civId);
  return (civ?.tech_tree_id as unknown as string) ?? null;
}

/** Whether `tech` is researchable now: prereqs satisfied, tree matches, not already done. */
export function canResearch(
  player: Player,
  tech: Tech,
  content: ContentPack,
): { ok: boolean; reason?: string } {
  const treeId = playerTechTreeId(player, content);
  if (!treeId) return { ok: false, reason: "NO_CIV" };
  if ((tech.tree_id as unknown as string) !== treeId)
    return { ok: false, reason: "WRONG_TREE" };
  if (player.researchedTechs.includes(tech.id as unknown as string))
    return { ok: false, reason: "ALREADY_RESEARCHED" };
  for (const p of tech.prereqs) {
    if (!player.researchedTechs.includes(p as unknown as string))
      return { ok: false, reason: "MISSING_PREREQ" };
  }
  return { ok: true };
}

/**
 * Apply science earned this turn toward the player's current research. Returns
 * updated player + zero-or-more "tech completed" log strings. Multiple techs
 * cannot complete in a single tick (the player must select the next).
 */
export function applyResearchTick(
  player: Player,
  content: ContentPack,
): { player: Player; logs: string[] } {
  const logs: string[] = [];
  if (!player.currentTech) return { player, logs };
  const tech = lookupTech(content, player.currentTech);
  if (!tech) return { player: { ...player, currentTech: null }, logs };
  if (player.science < tech.cost) return { player, logs };

  const finishedId = player.currentTech;
  const remainingScience = player.science - tech.cost;
  const newResearched = [...player.researchedTechs, finishedId];
  const newPlayer: Player = {
    ...player,
    researchedTechs: newResearched,
    science: remainingScience,
    currentTech: null,
  };
  const era = computeEra(newPlayer, content);
  const eraChanged = era !== newPlayer.era;
  const finalPlayer: Player = { ...newPlayer, era };

  logs.push(
    `${player.name} discovered ${tech.name}` + (eraChanged ? ` — entered the ${eraName(content, era)} era` : ""),
  );
  return { player: finalPlayer, logs };
}

function eraName(content: ContentPack, eraId: string): string {
  const e = content.eras.find((x) => (x.id as unknown as string) === eraId);
  return e?.name ?? eraId;
}
