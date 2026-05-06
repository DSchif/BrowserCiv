import { Hex, buildView, type Intent, type MatchView } from "@browserciv/shared";
import type { MatchRuntime } from "./runtime.js";

type Brain = (state: MatchView, playerId: string) => Intent | null;

// ── Strategies ───────────────────────────────────────────────────────────────

const LAND_TERRAINS = new Set([
  "grassland", "plains", "hills", "forest", "jungle",
  "desert", "tundra", "snow", "mountain",
]);

function pick<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

const randomBrain: Brain = (state: MatchView, playerId: string): Intent | null => {
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
      if (!tile || occupiedKeys.has(k)) return false;
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
    return { type: "SetResearch", actorId: playerId, techId: "tech.bronze_working" };
  }

  return { type: "EndTurn", actorId: playerId };
};

const passiveBrain: Brain = (_state, playerId) =>
  ({ type: "EndTurn", actorId: playerId });

export const STRATEGIES: Record<string, Brain> = {
  random: randomBrain,
  passive: passiveBrain,
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
      const intent = brain(view, this.playerId);
      if (!intent) break;

      try {
        this.rt.applyIntent(this.playerId, intent);
        this.rt.broadcastSnapshot();
      } catch (err) {
        console.error(`[bot:${this.playerId}] intent rejected:`, err);
        // Force end-turn to avoid getting stuck.
        try {
          this.rt.applyIntent(this.playerId, { type: "EndTurn", actorId: this.playerId });
          this.rt.broadcastSnapshot();
        } catch { /* ignore */ }
        break;
      }

      if (intent.type === "EndTurn") break;
    }
  }

  destroy(): void {
    this.detach();
  }
}
