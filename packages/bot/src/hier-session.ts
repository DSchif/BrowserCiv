#!/usr/bin/env tsx
/**
 * BrowserCiv hierarchical agent training session.
 *
 * Usage (from project root):
 *   pnpm hier-train
 *   pnpm hier-train -- --episodes 50 --load agent2.json
 *
 * Options:
 *   --episodes  <n>     Games to train (default: 20)
 *   --load      <path>  Load saved agent to continue training
 *   --save      <path>  Where to save weights (default: agent2.json)
 *   --config    <path>  Agent config JSON (default: agent2-config.json)
 *   --strategy  <name>  Opponent: random | greedy | passive (default: random)
 *   --map-size  <size>  small | medium | large (default: small)
 *   --no-spawn          Skip launching server/client (assume already running)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EpisodeDump } from "./dump.js";
import type { ContentPack } from "@browserciv/shared";
import { HierAgent } from "./agent2/hier-agent.js";
import type { HierAgentConfig } from "./agent2/config.js";
import { DEFAULT_HIER_CONFIG } from "./agent2/config.js";
import { runHierTrainingEpisode } from "./hier-train-runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(name); }

const CONFIG_PATH = arg("--config");
const EPISODES  = parseInt(arg("--episodes") ?? "20", 10);
const LOAD_PATH = arg("--load");
const SAVE_PATH = arg("--save") ?? "agent2.json";
const STRATEGY  = arg("--strategy") ?? "random";
const MAP_SIZE  = arg("--map-size") ?? "small";
const NO_SPAWN  = flag("--no-spawn");
const YES       = flag("--yes");

const SERVER_URL = "http://localhost:8787";
const CLIENT_URL = "http://localhost:5173";

function getLanIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

async function waitForUrl(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  process.stdout.write(`  Waiting for ${label}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url); process.stdout.write(" ✓\n"); return; } catch { /* not yet */ }
    process.stdout.write(".");
    await new Promise<void>((r) => setTimeout(r, 800));
  }
  process.stdout.write("\n");
  throw new Error(`Timed out waiting for ${label}`);
}

async function pressEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((res) => rl.question(prompt, () => { rl.close(); res(); }));
}

async function fetchContent(): Promise<ContentPack> {
  const res = await fetch(`${SERVER_URL}/content-pack`);
  if (!res.ok) throw new Error(`content-pack fetch failed: ${res.status}`);
  return res.json() as Promise<ContentPack>;
}

interface SetupResult {
  matchId: string;
  agentToken: { playerId: string; token: string };
  spectatorToken: { token: string };
  opponentId: string;
  strategy: string;
}

async function trainSetup(): Promise<SetupResult> {
  const res = await fetch(`${SERVER_URL}/train-setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mapSize: MAP_SIZE, strategy: STRATEGY }),
  });
  if (!res.ok) throw new Error(`train-setup failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<SetupResult>;
}

async function trainStart(
  matchId: string,
  agentToken: string,
  opponentId: string,
  strategy: string,
): Promise<void> {
  const res = await fetch(`${SERVER_URL}/train-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchId, agentToken, opponentId, strategy, noFog: false }),
  });
  if (!res.ok) throw new Error(`train-start failed: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const procs: ChildProcess[] = [];

  function cleanup(): void {
    procs.forEach((p) => {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {
        try { p.kill(); } catch { /* ignore */ }
      }
    });
  }
  process.on("exit", cleanup);
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  BrowserCiv Hier-Agent Training      ║");
  console.log("╚══════════════════════════════════════╝\n");

  if (!NO_SPAWN) {
    console.log("Starting server and client...");

    const serverProc = spawn("pnpm", ["dev:server"], {
      cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    serverProc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.error(`  [server] ${line}`);
    });
    procs.push(serverProc);

    procs.push(spawn("pnpm", ["dev:client"], {
      cwd: ROOT, detached: true, stdio: "ignore",
    }));

    await waitForUrl(`${SERVER_URL}/health`, "server");
    await waitForUrl(CLIENT_URL, "client");
    console.log();
  }

  // Load or build config
  let agentCfg: HierAgentConfig = DEFAULT_HIER_CONFIG;
  function resolveConfigFile(p: string): string | null {
    if (existsSync(p)) return p;
    const fromRoot = resolve(ROOT, p);
    if (existsSync(fromRoot)) return fromRoot;
    return null;
  }
  const configFile = CONFIG_PATH
    ? resolveConfigFile(CONFIG_PATH)
    : resolveConfigFile("agent2-config.json");
  if (configFile) {
    agentCfg = JSON.parse(readFileSync(configFile, "utf8")) as HierAgentConfig;
    console.log(`Loaded config from ${configFile}\n`);
  }

  const content = await fetchContent();
  const agent = new HierAgent(agentCfg, content);

  if (LOAD_PATH) {
    if (existsSync(LOAD_PATH)) {
      agent.load(LOAD_PATH);
      const h = agent.episodeHistory;
      const last = h[h.length - 1];
      console.log(`Continuing from: ${LOAD_PATH}`);
      console.log(`  Episodes trained: ${h.length}`);
      console.log(`  Last reward:      ${last ? last.reward.toFixed(2) : "—"}`);
    } else {
      console.log(`Note: ${LOAD_PATH} not found — starting fresh\n`);
    }
  } else {
    console.log(`Starting fresh agent  (use --load ${SAVE_PATH} next time to continue)\n`);
  }

  const lanIp = getLanIp();

  // Create a timestamped run folder for episode dumps
  const runTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = resolve(ROOT, "packages/bot/runs", `run-${runTs}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`  Saving episode dumps to: ${runDir}\n`);

  interface EpRecord { ep: number; outcome: string; reward: number; turns: number; kills: number; captures: number; goal: string; }
  const episodeLog: EpRecord[] = [];

  for (let ep = 1; ep <= EPISODES; ep++) {
    console.log(`${"─".repeat(52)}`);
    console.log(` Episode ${ep} of ${EPISODES}  [${STRATEGY} opponent · ${MAP_SIZE} map]`);
    console.log(`${"─".repeat(52)}\n`);

    const setup = await trainSetup();
    const watchUrl =
      `http://${lanIp}:5173?spectateMatch=${setup.matchId}&token=${setup.spectatorToken.token}&agentId=${setup.agentToken.playerId}`;

    console.log("  Watch URL (open this in your browser):\n");
    console.log(`    ${watchUrl}\n`);

    if (!YES) await pressEnter("  Press Enter when ready to start the game… ");
    console.log();

    await trainStart(setup.matchId, setup.agentToken.token, setup.opponentId, setup.strategy);

    console.log("  Game running…\n");
    const result = await runHierTrainingEpisode({
      serverUrl: SERVER_URL,
      matchId:   setup.matchId,
      agentToken: setup.agentToken.token,
      playerId:   setup.agentToken.playerId,
      agent,
      content,
      verbose: false,
      stallTimeoutMs: 3 * 60 * 1000,
    });

    agent.endEpisode(result.agentReward, {
      steps:  result.agentSteps,
      turns:  result.turns,
      winner: result.winner ?? null,
    });

    const won  = result.winner === setup.agentToken.playerId;
    const lost = result.winner != null && !won;
    const outcome = result.timedOut ? "TIMED OUT"
      : won ? "WON" : lost ? "LOST" : "DRAW";

    const kills   = result.kills ?? 0;
    const captures = result.citiesCaptured ?? 0;

    if (result.dump && result.dump.length > 0) {
      const episodeDump: EpisodeDump = {
        episode: ep,
        agentId: setup.agentToken.playerId,
        opponentId: setup.opponentId,
        outcome,
        totalReward: result.agentReward,
        totalKills: kills,
        totalCaptures: captures,
        turns: result.dump,
      };
      const dumpPath = resolve(runDir, `episode-${String(ep).padStart(3, "0")}.json`);
      writeFileSync(dumpPath, JSON.stringify(episodeDump, null, 2));
    }

    episodeLog.push({ ep, outcome, reward: result.agentReward, turns: result.turns, kills, captures, goal: agent.getCurrentGoal() });

    console.log(`  Result:  ${outcome}`);
    console.log(`  Turns: ${result.turns}  Steps: ${result.agentSteps}  Reward: ${result.agentReward.toFixed(1)}`);
    console.log(`  Kills: ${kills}  Cities captured: ${captures}  Goal: ${agent.getCurrentGoal()}`);
    console.log(`  ${agent.stats()}\n`);

    agent.save(SAVE_PATH);
  }

  // ── Final summary table ────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(` Summary — ${EPISODES} episodes vs ${STRATEGY} (${MAP_SIZE} map, 500 turns)`);
  console.log(`${"═".repeat(70)}`);
  console.log(` Ep  Outcome  Reward    Turns  Kills  Cap  Goal`);
  console.log(`${"─".repeat(70)}`);
  for (const r of episodeLog) {
    console.log(
      ` ${String(r.ep).padStart(2)}  ${r.outcome.padEnd(7)}  ${String(r.reward.toFixed(1)).padStart(7)}` +
      `  ${String(r.turns).padStart(5)}  ${String(r.kills).padStart(5)}  ${String(r.captures).padStart(3)}  ${r.goal}`,
    );
  }
  console.log(`${"─".repeat(70)}`);
  const wins   = episodeLog.filter((r) => r.outcome === "WON").length;
  const losses = episodeLog.filter((r) => r.outcome === "LOST").length;
  const draws  = episodeLog.filter((r) => r.outcome === "DRAW").length;
  const totalKills    = episodeLog.reduce((s, r) => s + r.kills, 0);
  const totalCaptures = episodeLog.reduce((s, r) => s + r.captures, 0);
  const avgReward     = episodeLog.reduce((s, r) => s + r.reward, 0) / episodeLog.length;
  const last10Reward  = episodeLog.slice(-10).reduce((s, r) => s + r.reward, 0) / Math.min(10, episodeLog.length);
  console.log(` Wins: ${wins}  Losses: ${losses}  Draws: ${draws}  Timeouts: ${episodeLog.filter((r) => r.outcome === "TIMED OUT").length}`);
  console.log(` Total kills: ${totalKills}  Total city captures: ${totalCaptures}`);
  console.log(` Avg reward (all): ${avgReward.toFixed(1)}  Avg reward (last 10): ${last10Reward.toFixed(1)}`);
  console.log(`${"═".repeat(70)}\n`);

  cleanup();
  process.exit(0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
