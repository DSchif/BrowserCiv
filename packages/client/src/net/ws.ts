import {
  type ClientMessage,
  type Intent,
  type MatchState,
  type ServerMessage,
} from "@browserciv/shared";
import { wsUrl } from "./rest.js";

export interface ClientNetEvents {
  onState?: (state: MatchState, actionSeq: number) => void;
  onAck?: (clientSeq: number, actionSeq: number) => void;
  onReject?: (clientSeq: number, code: string, message: string) => void;
  onError?: (code: string, message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export class GameClient {
  private ws: WebSocket | null = null;
  private clientSeq = 1;
  private outbox: ClientMessage[] = [];
  private events: ClientNetEvents;

  constructor(
    private matchId: string,
    private playerId: string,
    private token: string,
    events: ClientNetEvents,
  ) {
    this.events = events;
  }

  connect(): void {
    const ws = new WebSocket(wsUrl(this.token));
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.events.onOpen?.();
      this.send({ type: "Hello", matchId: this.matchId, playerId: this.playerId, lastSeq: 0 });
      // Flush any queued messages.
      const queued = this.outbox;
      this.outbox = [];
      for (const m of queued) this.sendNow(m);
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => {
      this.events.onClose?.();
    });
    ws.addEventListener("error", () => {
      this.events.onError?.("WS_ERROR", "websocket error");
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  sendIntent(intent: Intent): number {
    const seq = this.clientSeq++;
    this.send({ type: "Intent", clientSeq: seq, intent });
    return seq;
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.outbox.push(msg);
      return;
    }
    this.sendNow(msg);
  }

  private sendNow(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private onMessage(data: unknown): void {
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(String(data)) as ServerMessage;
    } catch {
      this.events.onError?.("BAD_JSON", "could not parse server message");
      return;
    }
    switch (parsed.type) {
      case "Snapshot":
        this.events.onState?.(parsed.state as MatchState, parsed.actionSeq);
        return;
      case "IntentAck":
        this.events.onAck?.(parsed.clientSeq, parsed.actionSeq);
        return;
      case "IntentReject":
        this.events.onReject?.(parsed.clientSeq, parsed.code, parsed.message);
        return;
      case "Error":
        this.events.onError?.(parsed.code, parsed.message);
        return;
      case "Pong":
        return;
    }
  }
}
