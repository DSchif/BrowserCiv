import { nanoid } from "nanoid";

export interface GuestCredential {
  playerId: string;
  matchId: string;
  token: string;
  spectator?: boolean;
}

const tokens = new Map<string, GuestCredential>();

let onChange: (() => void) | null = null;

/** Wire a callback that fires after token map mutations (used for persistence). */
export function setTokenChangeListener(fn: (() => void) | null): void {
  onChange = fn;
}

export function issueToken(playerId: string, matchId: string): GuestCredential {
  const token = nanoid(32);
  const cred = { playerId, matchId, token };
  tokens.set(token, cred);
  onChange?.();
  return cred;
}

export function issueSpectatorToken(matchId: string): GuestCredential {
  const token = nanoid(32);
  const cred: GuestCredential = { playerId: "", matchId, token, spectator: true };
  tokens.set(token, cred);
  onChange?.();
  return cred;
}

export function lookupToken(token: string): GuestCredential | null {
  return tokens.get(token) ?? null;
}

export function revokeToken(token: string): void {
  tokens.delete(token);
  onChange?.();
}

/** Snapshot of all live tokens (for persistence). */
export function allTokens(): GuestCredential[] {
  return [...tokens.values()];
}

/** Replace the in-memory token map (used on server boot to restore). */
export function loadTokensIntoMap(items: GuestCredential[]): void {
  tokens.clear();
  for (const t of items) tokens.set(t.token, t);
}
