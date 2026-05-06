import type {
  Action,
  ContentPack,
  Intent,
  MatchState,
  MatchSummary,
  ServerMessage,
} from "@browserciv/shared";
import { GameRuleError, buildSpectatorView, buildView, reduce } from "@browserciv/shared";

/** Minimal structural type for the WebSocket from @fastify/websocket. */
export interface WsLike {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
}

interface SocketConn {
  playerId: string;
  ws: WsLike;
}

/** Optional hook fired after every state-changing apply. */
let onApply: ((rt: MatchRuntime) => void) | null = null;
export function setApplyListener(fn: ((rt: MatchRuntime) => void) | null): void {
  onApply = fn;
}

export class MatchRuntime {
  private conns = new Set<SocketConn>();
  private spectators = new Set<WsLike>();
  private stateListeners = new Set<(rt: MatchRuntime) => void>();

  constructor(
    public state: MatchState,
    public readonly content: ContentPack,
  ) {}

  addStateListener(fn: (rt: MatchRuntime) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  apply(action: Action): MatchState {
    this.state = reduce(this.state, action, this.content);
    onApply?.(this);
    for (const fn of this.stateListeners) fn(this);
    return this.state;
  }

  applyBootstrap(action: Action): void {
    this.state = reduce(null, action, this.content);
    onApply?.(this);
  }

  applyIntent(playerId: string, intent: Intent): MatchState {
    if (intent.actorId !== playerId) {
      throw new GameRuleError("ACTOR_MISMATCH", "intent actorId must match player");
    }
    let action: Action;
    switch (intent.type) {
      case "MatchStart":
        action = {
          type: "MatchStart",
          actorId: intent.actorId,
          startedAt: new Date().toISOString(),
          noFog: intent.noFog,
        };
        break;
      case "EndTurn":
        action = { type: "EndTurn", actorId: intent.actorId };
        break;
      case "MoveUnit":
        action = {
          type: "MoveUnit",
          actorId: intent.actorId,
          unitId: intent.unitId,
          target: intent.target,
          attackId: intent.attackId,
        };
        break;
      case "FoundCity":
        action = {
          type: "FoundCity",
          actorId: intent.actorId,
          unitId: intent.unitId,
        };
        break;
      case "SetCityProduction":
        action = {
          type: "SetCityProduction",
          actorId: intent.actorId,
          cityId: intent.cityId,
          item: intent.item,
        };
        break;
      case "SetResearch":
        action = {
          type: "SetResearch",
          actorId: intent.actorId,
          techId: intent.techId,
        };
        break;
      case "UpgradeUnit":
        action = {
          type: "UpgradeUnit",
          actorId: intent.actorId,
          unitId: intent.unitId,
        };
        break;
      case "DeclareWar":
        action = {
          type: "DeclareWar",
          actorId: intent.actorId,
          targetPlayerId: intent.targetPlayerId,
        };
        break;
      case "MakePeace":
        action = {
          type: "MakePeace",
          actorId: intent.actorId,
          targetPlayerId: intent.targetPlayerId,
        };
        break;
      case "RangedAttack":
        action = {
          type: "RangedAttack",
          actorId: intent.actorId,
          unitId: intent.unitId,
          targetUnitId: intent.targetUnitId,
          attackId: intent.attackId,
        };
        break;
      case "BuildImprovement":
        action = {
          type: "BuildImprovement",
          actorId: intent.actorId,
          unitId: intent.unitId,
          improvementId: intent.improvementId,
        };
        break;
      case "Fortify":
        action = {
          type: "Fortify",
          actorId: intent.actorId,
          unitId: intent.unitId,
        };
        break;
      case "BuyProduction":
        action = {
          type: "BuyProduction",
          actorId: intent.actorId,
          cityId: intent.cityId,
        };
        break;
      case "CityRangedAttack":
        action = {
          type: "CityRangedAttack",
          actorId: intent.actorId,
          cityId: intent.cityId,
          targetUnitId: intent.targetUnitId,
          attackId: intent.attackId,
        };
        break;
      case "BoardShip":
        action = {
          type: "BoardShip",
          actorId: intent.actorId,
          unitId: intent.unitId,
          shipId: intent.shipId,
        };
        break;
      case "Disembark":
        action = {
          type: "Disembark",
          actorId: intent.actorId,
          shipId: intent.shipId,
          unitId: intent.unitId,
          target: intent.target,
        };
        break;
    }
    return this.apply(action);
  }

  summary(): MatchSummary {
    const host = this.state.players.find((p) => p.id === this.state.hostId);
    return {
      id: this.state.id,
      status: this.state.status,
      hostId: this.state.hostId,
      hostName: host?.name ?? "(unknown)",
      playerCount: this.state.players.length,
      maxPlayers: 8,
      turnNumber: this.state.turnNumber,
      createdAt: this.state.createdAt,
    };
  }

  attach(playerId: string, ws: WsLike): () => void {
    const conn: SocketConn = { playerId, ws };
    this.conns.add(conn);
    try {
      this.apply({ type: "SetConnected", playerId, connected: true });
      this.broadcastSnapshot();
    } catch {
      // SetConnected may fail if player not in state — surface to caller via ws.
    }
    return () => {
      this.conns.delete(conn);
      const stillConnected = [...this.conns].some((c) => c.playerId === playerId);
      if (!stillConnected) {
        try {
          this.apply({ type: "SetConnected", playerId, connected: false });
          this.broadcastSnapshot();
        } catch {
          // player may have been removed already
        }
      }
    };
  }

  attachSpectator(ws: WsLike): () => void {
    this.spectators.add(ws);
    this.sendSpectatorSnapshot(ws);
    return () => this.spectators.delete(ws);
  }

  sendSpectatorSnapshot(ws: WsLike): void {
    const view = buildSpectatorView(this.state);
    const message: ServerMessage = {
      type: "Snapshot",
      actionSeq: this.state.actionSeq,
      state: view,
    };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  /**
   * Send each connected player a snapshot rendered for their viewer id —
   * filtered for fog of war. Without this, network observers can read
   * opponent positions in cleartext.
   */
  broadcastSnapshot(): void {
    for (const conn of this.conns) {
      this.sendSnapshot(conn.ws, conn.playerId);
    }
    for (const ws of this.spectators) {
      this.sendSpectatorSnapshot(ws);
    }
  }

  contentPack(): import("@browserciv/shared").ContentPack {
    return this.content;
  }

  sendSnapshot(ws: WsLike, viewerId: string): void {
    const view = buildView(this.state, viewerId, this.content);
    const message: ServerMessage = {
      type: "Snapshot",
      actionSeq: this.state.actionSeq,
      state: view,
    };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  send(ws: WsLike, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
