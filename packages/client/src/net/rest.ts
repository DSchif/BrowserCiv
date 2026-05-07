import type {
  ContentPack,
  CreateMatchRequest,
  JoinMatchRequest,
  MatchSummary,
  PlayerCredential,
} from "@browserciv/shared";

/**
 * In dev, fall back to the local server on 8787. In a same-origin production
 * build (server serves the SPA over the same ALB), use the page's own origin
 * so REST + WS calls return to the same host with the right protocol.
 */
const SERVER =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV
    ? `http://${window.location.hostname}:8787`
    : window.location.origin);

export interface MatchAndCredential {
  match: MatchSummary;
  credential: PlayerCredential;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("browserciv_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function listMatches(): Promise<MatchSummary[]> {
  const r = await fetch(`${SERVER}/matches`);
  if (!r.ok) throw new Error(`listMatches failed: ${r.status}`);
  const j = (await r.json()) as { matches: MatchSummary[] };
  return j.matches;
}

export async function createMatch(req: CreateMatchRequest): Promise<MatchAndCredential> {
  const r = await fetch(`${SERVER}/matches`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`createMatch failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as MatchAndCredential;
}

export async function joinMatch(matchId: string, req: JoinMatchRequest): Promise<MatchAndCredential> {
  const r = await fetch(`${SERVER}/matches/${encodeURIComponent(matchId)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`joinMatch failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as MatchAndCredential;
}

export async function createSoloMatch(req: {
  playerName?: string;
  mapSize?: "small" | "medium" | "large";
  strategy?: string;
}): Promise<MatchAndCredential> {
  const r = await fetch(`${SERVER}/matches/solo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`createSoloMatch failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as MatchAndCredential;
}

export async function fetchContentPack(): Promise<ContentPack> {
  const r = await fetch(`${SERVER}/content-pack`);
  if (!r.ok) throw new Error(`fetchContentPack failed: ${r.status}`);
  return (await r.json()) as ContentPack;
}

export function wsUrl(token: string, viewAs?: string): string {
  const httpUrl = new URL(SERVER);
  const wsProto = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  let url = `${wsProto}//${httpUrl.host}/ws?token=${encodeURIComponent(token)}`;
  if (viewAs) url += `&viewAs=${encodeURIComponent(viewAs)}`;
  return url;
}
