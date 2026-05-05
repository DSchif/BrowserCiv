import { z } from "zod";
import { Intent } from "../game/actions.js";

/**
 * Network protocol — JSON over WebSocket. Validated on both ends with these
 * schemas. Server is authoritative; client only sends intents and renders
 * snapshots/deltas it receives.
 */

// ---------- Client → Server ----------

export const ClientHello = z.object({
  type: z.literal("Hello"),
  matchId: z.string().min(1),
  playerId: z.string().min(1),
  /** Last actionSeq the client has applied. 0 = none / give me a snapshot. */
  lastSeq: z.number().int().nonnegative().default(0),
});

export const ClientIntent = z.object({
  type: z.literal("Intent"),
  /** Monotonic per-client id used by the server to ack/reject. */
  clientSeq: z.number().int().nonnegative(),
  intent: Intent,
});

export const ClientPing = z.object({
  type: z.literal("Ping"),
  ts: z.number(),
});

export const ClientMessage = z.discriminatedUnion("type", [
  ClientHello,
  ClientIntent,
  ClientPing,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- Server → Client ----------

/**
 * State payload — a full snapshot. For Phase 1 we always send full snapshots.
 * Deltas land in a later phase.
 */
export const ServerSnapshot = z.object({
  type: z.literal("Snapshot"),
  /** The state's actionSeq at time of snapshot. Client uses this as lastSeq. */
  actionSeq: z.number().int().nonnegative(),
  state: z.unknown(),
});

export const ServerIntentAck = z.object({
  type: z.literal("IntentAck"),
  clientSeq: z.number().int().nonnegative(),
  /** Server's actionSeq after applying the intent. */
  actionSeq: z.number().int().nonnegative(),
});

export const ServerIntentReject = z.object({
  type: z.literal("IntentReject"),
  clientSeq: z.number().int().nonnegative(),
  code: z.string(),
  message: z.string(),
});

export const ServerError = z.object({
  type: z.literal("Error"),
  code: z.string(),
  message: z.string(),
});

export const ServerPong = z.object({
  type: z.literal("Pong"),
  ts: z.number(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  ServerSnapshot,
  ServerIntentAck,
  ServerIntentReject,
  ServerError,
  ServerPong,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------- REST DTOs ----------

export const CreateMatchRequest = z.object({
  hostName: z.string().min(1).max(40),
  mapSize: z.enum(["small", "medium", "large"]).default("small"),
  maxPlayers: z.number().int().min(2).max(8).default(4),
  seed: z.number().int().optional(),
});
export type CreateMatchRequest = z.infer<typeof CreateMatchRequest>;

export const JoinMatchRequest = z.object({
  name: z.string().min(1).max(40),
});
export type JoinMatchRequest = z.infer<typeof JoinMatchRequest>;

export const PlayerCredential = z.object({
  playerId: z.string().min(1),
  matchId: z.string().min(1),
  /** Bearer token used in WS query / Authorization. Phase 1 uses opaque guest tokens. */
  token: z.string().min(1),
});
export type PlayerCredential = z.infer<typeof PlayerCredential>;
