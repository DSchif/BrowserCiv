import { Hex, buildView, type ContentPack, type Intent, type MatchView } from "@browserciv/shared";
import type { MatchRuntime } from "./runtime.js";

type Brain = (state: MatchView, playerId: string, content: ContentPack) => Intent | null;

// ── Strategies ───────────────────────────────────────────────────────────────

const LAND_TERRAINS = new Set([
  "grassland", "plains", "hills", "forest", "jungle",
  "desert", "tundra", "snow", "mountain",
]);

function pick<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

const randomBrain: Brain = (state: MatchView, playerId: string, content: ContentPack): Intent | null => {
  const myUnits = state.units.filter((u) => u.ownerId === playerId && u.movementLeft > 0);
  const tiles = new Map((state.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]));
  const occupiedKeys = new Set(state.units.map((u) => `${u.position.q},${u.position.r}`));
  const cityKeys = new Set(state.cities.map((c) => `${c.position.q},${c.position.r}`));

  if (Math.random() < 0.5) {
    const settler = myUnits.find((u) => u.defId === "unit.settler");
    if (settler && !cityKeys.has(`${settler.position.q},${settler.position.r}`)) {
      return { type: "FoundCity", actorId: playerId, unitId: settler.id };
    }
  }

  const unit = pick(myUnits);
  if (unit) {
    const candidates = Hex.neighbors(unit.position).filter((n) => {
      const k = `${n.q},${n.r}`;
      const tile = tiles.get(k);
      if (!tile || occupiedKeys.has(k) || cityKeys.has(k)) return false;
      const terrain = content.terrains.find((t) => (t.id as unknown as string) === tile.terrain);
      if (!terrain) return false;
      const cost = (terrain as Record<string, unknown>).movement_cost as number ?? 1;
      if (cost > unit.movementLeft) return false;
      if (unit.defId === "unit.settler" || unit.defId === "unit.worker") {
        return LAND_TERRAINS.has(tile.terrain) && tile.terrain !== "mountain";
      }
      return LAND_TERRAINS.has(tile.terrain);
    });
    const target = pick(candidates);
    if (target) return { type: "MoveUnit", actorId: playerId, unitId: unit.id, target };
  }

  const idleCity = state.cities.find((c) => c.ownerId === playerId && !c.productionItem);
  if (idleCity) {
    return {
      type: "SetCityProduction",
      actorId: playerId,
      cityId: idleCity.id,
      item: { kind: "unit", defId: "unit.worker" },
    };
  }

  const me = state.players.find((p) => p.id === playerId);
  if (me && !me.currentTech) {
    const researched = new Set(me.researchedTechs);
    const next = ["tech.agriculture", "tech.mining", "tech.pottery", "tech.archery", "tech.bronze_working"]
      .find((t) => !researched.has(t));
    if (next) return { type: "SetResearch", actorId: playerId, techId: next };
  }

  return { type: "EndTurn", actorId: playerId };
};

const passiveBrain: Brain = (_state, playerId, _content) =>
  ({ type: "EndTurn", actorId: playerId });

/**
 * Greedy brain: maximize cities and units.
 * Priority order:
 *   1. Found city with any settler that isn't already on a city
 *   2. Move settler toward nearest unclaimed, passable tile
 *   3. Set idle city production → settler (if fewer settlers than cities) else warrior
 *   4. Set research if none active
 *   5. End turn
 */
const greedyBrain: Brain = (state: MatchView, playerId: string, content: ContentPack): Intent | null => {
  const myUnits = state.units.filter((u) => u.ownerId === playerId);
  const myCities = state.cities.filter((c) => c.ownerId === playerId);
  const tiles = new Map((state.map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t]));
  const cityKeys = new Set(state.cities.map((c) => `${c.position.q},${c.position.r}`));
  const occupiedKeys = new Set(state.units.map((u) => `${u.position.q},${u.position.r}`));

  const moveCost = (terrainId: string): number => {
    const t = content.terrains.find((t) => (t.id as unknown as string) === terrainId);
    return (t as Record<string, unknown>)?.movement_cost as number ?? 1;
  };

  // 1. Found city with idle settler not already on a city tile
  const idleSettler = myUnits.find(
    (u) => u.defId === "unit.settler" &&
      u.movementLeft > 0 &&
      !cityKeys.has(`${u.position.q},${u.position.r}`),
  );
  if (idleSettler) {
    return { type: "FoundCity", actorId: playerId, unitId: idleSettler.id };
  }

  // 2. Move any settler with movement left toward unclaimed passable land
  const movableSettler = myUnits.find(
    (u) => u.defId === "unit.settler" && u.movementLeft > 0,
  );
  if (movableSettler) {
    const candidates = Hex.neighbors(movableSettler.position).filter((n) => {
      const k = `${n.q},${n.r}`;
      const tile = tiles.get(k);
      if (!tile || occupiedKeys.has(k) || cityKeys.has(k)) return false;
      if (tile.ownerCityId) return false;
      if (moveCost(tile.terrain) > movableSettler.movementLeft) return false;
      return LAND_TERRAINS.has(tile.terrain) && tile.terrain !== "mountain";
    });
    const target = pick(candidates);
    if (target) {
      return { type: "MoveUnit", actorId: playerId, unitId: movableSettler.id, target };
    }
  }

  // 3. Set production on idle cities
  const idleCity = myCities.find((c) => !c.productionItem);
  if (idleCity) {
    const settlersCount = myUnits.filter((u) => u.defId === "unit.settler").length;
    const wantSettler = settlersCount < myCities.length + 1;
    return {
      type: "SetCityProduction",
      actorId: playerId,
      cityId: idleCity.id,
      item: { kind: "unit", defId: wantSettler ? "unit.settler" : "unit.warrior" },
    };
  }

  // 4. Set research if none active
  const me = state.players.find((p) => p.id === playerId);
  if (me && !me.currentTech) {
    const researched = new Set(me.researchedTechs);
    const next = ["tech.agriculture", "tech.mining", "tech.pottery", "tech.archery", "tech.bronze_working"]
      .find((t) => !researched.has(t));
    if (next) return { type: "SetResearch", actorId: playerId, techId: next };
  }

  return { type: "EndTurn", actorId: playerId };
};

export const STRATEGIES: Record<string, Brain> = {
  random: randomBrain,
  passive: passiveBrain,
  greedy: greedyBrain,
};

// ── BotDriver ────────────────────────────────────────────────────────────────

/**
 * Drives a bot player in-process. Subscribes to runtime state changes and
 * applies intents directly — no WebSocket round-trip.
 */
export class BotDriver {
  private busy = false;
  private readonly detach: () => void;

  constructor(
    private readonly rt: MatchRuntime,
    private readonly playerId: string,
    strategy: string,
  ) {
    const brain = STRATEGIES[strategy] ?? randomBrain;
    this.detach = rt.addStateListener(() => this.tick(brain));
    // Trigger immediately in case the match is already in-progress.
    this.tick(brain);
  }

  private tick(brain: Brain): void {
    if (this.busy) return;
    const s = this.rt.state;
    if (s.status !== "in_progress") return;
    if (s.players[s.currentPlayerIndex]?.id !== this.playerId) return;

    this.busy = true;
    // Use setImmediate so the current apply() call stack unwinds first,
    // preventing recursive apply → listener → apply chains.
    setImmediate(() => {
      try {
        this.driveUntilDone(brain);
      } finally {
        this.busy = false;
      }
    });
  }

  private driveUntilDone(brain: Brain): void {
    // Keep applying intents until EndTurn or brain returns null.
    for (let i = 0; i < 200; i++) {
      const s = this.rt.state;
      if (s.status !== "in_progress") break;
      if (s.players[s.currentPlayerIndex]?.id !== this.playerId) break;

      const view = buildView(s, this.playerId, this.rt.content);
      const intent = brain(view, this.playerId, this.rt.content);
      if (!intent) break;

      try {
        this.rt.applyIntent(this.playerId, intent);
      } catch (err) {
        console.error(`[bot:${this.playerId}] intent rejected (${intent.type}):`, err instanceof Error ? err.message : err);
        // Force end-turn to avoid getting stuck.
        try {
          this.rt.applyIntent(this.playerId, { type: "EndTurn", actorId: this.playerId });
        } catch { /* ignore */ }
        break;
      }

      if (intent.type === "EndTurn") break;
    }
    // Single broadcast after the entire turn, not after each intent.
    this.rt.broadcastSnapshot();
  }

  destroy(): void {
    this.detach();
  }
}
