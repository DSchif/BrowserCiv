#!/usr/bin/env tsx
/**
 * BrowserCiv bot runner CLI
 *
 * Usage:
 *   pnpm --filter @browserciv/bot start -- [options]
 *
 * Options:
 *   --server   <url>    Game server base URL (default: http://localhost:8787)
 *   --match    <id>     Match ID to join (required unless --create)
 *   --create            Create a new match instead of joining one
 *   --name     <str>    Bot player name (default: "Bot")
 *   --size     <str>    Map size when creating: small|medium|large (default: small)
 *   --no-fog            Enable no-fog-of-war when creating a match
 *   --strategy <str>    Brain to use: random|http (default: random)
 *   --http-url <url>    URL for http brain (default: http://localhost:5050/step)
 *   --log      <path>   Write JSONL training log to this file
 *   --episode  <n>      Episode number written to log (default: 0)
 *   --verbose           Print turn-by-turn debug output
 *   --wait-for-human    After creating, wait for a human to join before the
 *                       bot sends MatchStart (useful for testing)
 */

import { runBot } from "./runner.js";
import { randomBrain } from "./strategies/random.js";
import { makeHttpBrain } from "./http-brain.js";
import type { Brain } from "./brain.js";

// ── Parse args ──────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const SERVER = arg("--server") ?? "http://localhost:8787";
const MATCH_ID = arg("--match");
const CREATE = flag("--create");
const NAME = arg("--name") ?? "Bot";
const SIZE = (arg("--size") ?? "small") as "small" | "medium" | "large";
const NO_FOG = flag("--no-fog");
const STRATEGY = arg("--strategy") ?? "random";
const HTTP_URL = arg("--http-url") ?? "http://localhost:5050/step";
const LOG_PATH = arg("--log");
const EPISODE = parseInt(arg("--episode") ?? "0", 10);
const VERBOSE = flag("--verbose");
const WAIT_FOR_HUMAN = flag("--wait-for-human");

if (!CREATE && !MATCH_ID) {
  console.error("Error: provide --match <id> or --create");
  process.exit(1);
}

// ── REST helpers ─────────────────────────────────────────────────────────────

interface Credential { playerId: string; matchId: string; token: string }
interface MatchAndCred { match: { id: string }; credential: Credential }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function getMatches(): Promise<{ id: string; hostName: string }[]> {
  const res = await fetch(`${SERVER}/matches`);
  const j = (await res.json()) as { matches: { id: string; hostName: string }[] };
  return j.matches;
}

// ── Bot WS helpers: create/start ─────────────────────────────────────────────

import WebSocket from "ws";

function waitForHuman(serverUrl: string, matchId: string, token: string, playerId: string): Promise<void> {
  return new Promise((resolve) => {
    function wsUrl(): string {
      const u = new URL(serverUrl);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws";
      u.searchParams.set("token", token);
      return u.toString();
    }
    const ws = new WebSocket(wsUrl());
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "Hello", matchId, playerId, lastSeq: 0 }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; state?: { players?: unknown[] } };
      if (msg.type === "Snapshot") {
        const players = (msg.state as { players: unknown[] }).players;
        if (players.length >= 2) {
          console.log(`[bot] ${players.length} players in lobby — sending MatchStart`);
          ws.send(JSON.stringify({
            type: "Intent",
            clientSeq: 1,
            intent: { type: "MatchStart", actorId: playerId, noFog: NO_FOG },
          }));
        }
      }
      if (msg.type === "IntentAck") {
        ws.close();
        resolve();
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let matchId: string;
  let playerId: string;
  let token: string;

  if (CREATE) {
    console.log(`[bot] creating match (size=${SIZE}, noFog=${NO_FOG})`);
    const res = await post<MatchAndCred>("/matches", {
      hostName: NAME,
      mapSize: SIZE,
      maxPlayers: 4,
    });
    matchId = res.match.id;
    playerId = res.credential.playerId;
    token = res.credential.token;
    console.log(`[bot] created match ${matchId}`);

    if (WAIT_FOR_HUMAN) {
      console.log(`[bot] waiting for a human to join… (match id: ${matchId})`);
      await waitForHuman(SERVER, matchId, token, playerId);
      console.log(`[bot] match started`);
    } else {
      // Self-start is only useful when running two bots; a second bot joining
      // will trigger the host bot to start.  For single-player testing pass
      // --wait-for-human and start manually in the browser.
      console.log(`[bot] created — share match id: ${matchId}`);
      console.log(`[bot] run a second bot with: --match ${matchId} --name Bot2`);
    }
  } else {
    const matches = await getMatches();
    const target = matches.find((m) => m.id === MATCH_ID);
    if (!target) throw new Error(`Match ${MATCH_ID} not found`);
    const res = await post<MatchAndCred>(`/matches/${MATCH_ID}/join`, { name: NAME });
    matchId = res.match.id;
    playerId = res.credential.playerId;
    token = res.credential.token;
    console.log(`[bot] joined match ${matchId} as player ${playerId}`);
  }

  const brain: Brain =
    STRATEGY === "http" ? makeHttpBrain(HTTP_URL) : randomBrain;

  console.log(`[bot] running with strategy=${STRATEGY}`);

  await runBot({
    serverUrl: SERVER,
    matchId,
    playerId,
    token,
    brain,
    logPath: LOG_PATH,
    episode: EPISODE,
    verbose: VERBOSE,
  });

  console.log("[bot] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
