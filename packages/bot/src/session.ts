#!/usr/bin/env tsx
/**
 * One-command BrowserCiv training session.
 *
 * Starts the game server and Vite client, shows you a spectator URL on your
 * local network IP (works from any device on your WiFi), waits for you to
 * open it, then starts the game when you press Enter.
 *
 * Usage (from project root):
 *   pnpm train
 *   pnpm train -- --episodes 50 --load agent.json
 *
 * Options:
 *   --episodes  <n>     Games to train (default: 20)
 *   --load      <path>  Load saved agent to continue training
 *   --save      <path>  Where to save weights (default: agent.json)
 *   --strategy  <name>  Opponent: random | greedy | passive (default: random)
 *   --map-size  <size>  small | medium | large (default: small)
 *   --lr        <n>     Learning rate (default: 0.001)
 *   --no-spawn          Skip launching server/client (assume already running)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ContentPack } from "@browserciv/shared";
import type { AgentConfig } from "./agent/agent-config.js";
import { QAgent } from "./agent/q-agent.js";
import { cityAndUnitReward, buildRewardFn } from "./agent/reward.js";
import { runTrainingEpisode } from "./train-runner.js";

// Root of the monorepo (packages/bot/src → packages/bot → packages → root)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(name); }

const CONFIG_PATH = arg("--config");
const EPISODES  = parseInt(arg("--episodes") ?? "20", 10);
const LOAD_PATH = arg("--load");
const SAVE_PATH = arg("--save") ?? "agent.json";
const STRATEGY  = arg("--strategy") ?? "random";
const MAP_SIZE  = arg("--map-size") ?? "small";
const LR        = parseFloat(arg("--lr") ?? "0.001");
const NO_SPAWN  = flag("--no-spawn");

const SERVER_URL = "http://localhost:8787";
const CLIENT_URL = "http://localhost:5173";

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Server API ────────────────────────────────────────────────────────────────

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
    body: JSON.stringify({ matchId, agentToken, opponentId, strategy }),
  });
  if (!res.ok) throw new Error(`train-start failed: ${res.status} ${await res.text()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const procs: ChildProcess[] = [];

  function cleanup(): void {
    procs.forEach((p) => {
      try {
        // Kill the whole process group so grandchildren (tsx, vite) also die.
        // p.pid is the pnpm wrapper; negating it targets the group.
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
  console.log("║   BrowserCiv Bot Training Session    ║");
  console.log("╚══════════════════════════════════════╝\n");

  // ── Launch server + client ────────────────────────────────────────────────

  if (!NO_SPAWN) {
    console.log("Starting server and client...");

    // Pipe server stderr so errors surface (stdout is noisy startup logs — drop it)
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

  // ── Load or create agent ──────────────────────────────────────────────────

  let agentConfig: AgentConfig | null = null;
  const configFile = CONFIG_PATH ?? (existsSync("agent-config.json") ? "agent-config.json" : null);
  if (configFile && existsSync(configFile)) {
    agentConfig = JSON.parse(readFileSync(configFile, "utf8")) as AgentConfig;
    console.log(`Loaded agent config from ${configFile}\n`);
  }

  const hidden = agentConfig?.network.hidden ?? [64, 32];
  const rewardFn = agentConfig?.rewards.length
    ? buildRewardFn(agentConfig.rewards)
    : cityAndUnitReward;
  const lr = agentConfig?.training.lr ?? LR;
  const epsilonDecay = agentConfig?.training.epsilon_decay;
  const epsilonMin = agentConfig?.training.epsilon_min;
  const gamma = agentConfig?.training.gamma;

  const agent = new QAgent(
    {
      lr,
      ...(epsilonDecay !== undefined ? { epsilonDecay } : {}),
      ...(epsilonMin !== undefined ? { epsilonMin } : {}),
      ...(gamma !== undefined ? { gamma } : {}),
      rewardFn,
    },
    hidden,
  );

  if (LOAD_PATH) {
    if (existsSync(LOAD_PATH)) {
      agent.load(LOAD_PATH);
      const h = agent.episodeHistory;
      const last = h[h.length - 1];
      console.log(`Continuing from: ${LOAD_PATH}`);
      console.log(`  Episodes trained: ${h.length}`);
      console.log(`  Last reward:      ${last ? last.reward.toFixed(2) : "—"}`);
      console.log(`  Current ε:        ${agent.epsilon.toFixed(4)}\n`);
    } else {
      console.log(`Note: ${LOAD_PATH} not found — starting fresh\n`);
    }
  } else {
    console.log(`Starting fresh agent  (use --load ${SAVE_PATH} next time to continue)\n`);
  }

  const content = await fetchContent();
  const lanIp   = getLanIp();

  // ── Training loop ─────────────────────────────────────────────────────────

  for (let ep = 1; ep <= EPISODES; ep++) {
    console.log(`${"─".repeat(52)}`);
    console.log(` Episode ${ep} of ${EPISODES}  [${STRATEGY} opponent · ${MAP_SIZE} map]`);
    console.log(`${"─".repeat(52)}\n`);

    const setup = await trainSetup();
    const watchUrl =
      `http://${lanIp}:5173?spectateMatch=${setup.matchId}&token=${setup.spectatorToken.token}&agentId=${setup.agentToken.playerId}`;

    console.log("  Watch URL (open this in your browser):\n");
    console.log(`    ${watchUrl}\n`);

    await pressEnter("  Press Enter when ready to start the game… ");
    console.log();

    await trainStart(setup.matchId, setup.agentToken.token, setup.opponentId, setup.strategy);

    console.log("  Game running…\n");
    const result = await runTrainingEpisode({
      serverUrl: SERVER_URL,
      matchId:   setup.matchId,
      agentToken: setup.agentToken.token,
      playerId:   setup.agentToken.playerId,
      agent,
      content,
      rewardFn,
      verbose: true,
      stallTimeoutMs: 3 * 60 * 1000,
    });

    agent.endEpisode(result.agentReward, {
      steps:  result.agentSteps,
      turns:  result.turns,
      winner: result.winner ?? null,
    });

    const won  = result.winner === setup.agentToken.playerId;
    const lost = result.winner != null && !won;
    const outcome = result.timedOut ? "TIMED OUT (stalled)"
      : won ? "WON" : lost ? "LOST" : "DRAW / max turns";

    console.log(`  Result:  ${outcome}`);
    console.log(`  Turns:   ${result.turns}  Steps: ${result.agentSteps}  Reward: ${result.agentReward.toFixed(2)}`);
    console.log(`  ${agent.stats()}\n`);

    agent.save(SAVE_PATH);
    console.log(`  Saved to ${SAVE_PATH}\n`);
  }

  console.log(`${"═".repeat(52)}`);
  console.log(` Done — ${EPISODES} episodes complete`);
  console.log(` Run  pnpm plot -- --load ${SAVE_PATH}  to see the chart`);
  console.log(`${"═".repeat(52)}\n`);

  cleanup();
  process.exit(0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
