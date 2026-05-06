#!/usr/bin/env tsx
/**
 * Reinforcement learning trainer.
 *
 * Runs headless games (no server, no WS) and trains a Q-agent via
 * temporal-difference learning.
 *
 * Usage:
 *   pnpm --filter @browserciv/bot start:train -- [options]
 *
 * Options:
 *   --episodes  <n>       Number of training episodes (default: 200)
 *   --eval-every <n>      Run a greedy evaluation game every N episodes (default: 20)
 *   --save      <path>    Save agent weights after training (default: ./agent.json)
 *   --load      <path>    Load existing weights to continue training
 *   --log       <path>    Append training stats as JSONL
 *   --map-size  <str>     small | medium | large (default: small)
 *   --max-turns <n>       Max turns per episode (default: 150)
 *   --lr        <n>       Learning rate (default: 0.01)
 *   --gamma     <n>       Discount factor (default: 0.95)
 *   --epsilon   <n>       Initial exploration rate (default: 1.0)
 *   --server    <url>     Content pack server (default: http://localhost:8787)
 *   --verbose             Print per-episode stats
 */

import { appendFileSync, existsSync } from "node:fs";
import type { ContentPack } from "@browserciv/shared";
import { QAgent, makeTransition } from "./agent/q-agent.js";
import { cityAndUnitReward } from "./agent/reward.js";
import { runHeadlessGame, type SyncBrain } from "./headless.js";
import { randomBrain } from "./strategies/random.js";

// ── Parse CLI args ────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean { return process.argv.includes(name); }
function argNum(name: string, def: number): number {
  const v = arg(name);
  return v ? parseFloat(v) : def;
}

const EPISODES   = parseInt(arg("--episodes") ?? "200", 10);
const EVAL_EVERY = parseInt(arg("--eval-every") ?? "20", 10);
const SAVE_PATH  = arg("--save") ?? "./agent.json";
const LOAD_PATH  = arg("--load");
const LOG_PATH   = arg("--log");
const MAP_SIZE   = (arg("--map-size") ?? "small") as "small" | "medium" | "large";
const MAX_TURNS  = parseInt(arg("--max-turns") ?? "150", 10);
const SERVER     = arg("--server") ?? "http://localhost:8787";
const VERBOSE    = flag("--verbose");

// ── Load content pack ─────────────────────────────────────────────────────────

async function fetchContent(): Promise<ContentPack> {
  const res = await fetch(`${SERVER}/content-pack`);
  if (!res.ok) throw new Error(`Failed to fetch content pack: ${res.status}`);
  return res.json() as Promise<ContentPack>;
}

// ── Training loop ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[train] loading content pack from", SERVER);
  const content = await fetchContent();
  console.log(`[train] pack: ${content.manifest.id as unknown as string}`);

  const agent = new QAgent({
    lr: argNum("--lr", 0.01),
    gamma: argNum("--gamma", 0.95),
    epsilon: argNum("--epsilon", 1.0),
    epsilonDecay: 0.995,
    epsilonMin: 0.05,
    rewardFn: cityAndUnitReward,
  });

  if (LOAD_PATH && existsSync(LOAD_PATH)) {
    agent.load(LOAD_PATH);
    console.log(`[train] loaded weights from ${LOAD_PATH} (ε=${agent.epsilon.toFixed(3)})`);
  }

  const agentBrain = agent.toBrain(content, true /* training mode */);
  const opponentBrain = randomBrain as SyncBrain; // train against random opponent

  let totalSteps = 0;

  for (let ep = 1; ep <= EPISODES; ep++) {
    // ── Run one training episode ────────────────────────────────────────────
    let epReward = 0;

    const record = runHeadlessGame(
      { agent: agentBrain, opponent: opponentBrain },
      content,
      cityAndUnitReward,
      { mapSize: MAP_SIZE, maxTurns: MAX_TURNS, noFog: true },
    );

    // ── Update agent from this episode's steps ──────────────────────────────
    const agentSteps = record.steps.filter((s) => s.playerId === "agent");
    for (let i = 0; i < agentSteps.length; i++) {
      const step = agentSteps[i]!;
      const nextStep = agentSteps[i + 1] ?? null;
      epReward += step.reward;
      const transition = makeTransition(
        step.view,
        "agent",
        step.intent,
        step.reward,
        nextStep?.view ?? null,
        content,
      );
      agent.update(transition);
      totalSteps++;
    }

    agent.endEpisode(epReward);

    // ── Logging ─────────────────────────────────────────────────────────────
    if (LOG_PATH) {
      const entry = {
        episode: ep,
        steps: agentSteps.length,
        reward: epReward,
        turns: record.turns,
        epsilon: agent.epsilon,
        winner: record.winner,
      };
      appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
    }

    if (VERBOSE || ep % EVAL_EVERY === 0) {
      console.log(`[ep ${ep}/${EPISODES}] turns=${record.turns} reward=${epReward.toFixed(1)} ${agent.stats()}`);
    }

    // ── Evaluation run (greedy, no exploration) ─────────────────────────────
    if (ep % EVAL_EVERY === 0) {
      const evalBrain = agent.toBrain(content, false /* greedy */);
      const evalRecord = runHeadlessGame(
        { agent: evalBrain, opponent: opponentBrain },
        content,
        cityAndUnitReward,
        { mapSize: MAP_SIZE, maxTurns: MAX_TURNS, noFog: true },
      );
      const evalReward = evalRecord.steps
        .filter((s) => s.playerId === "agent")
        .reduce((sum, s) => sum + s.reward, 0);
      const agentFinalCities = evalRecord.finalState.cities.filter(
        (c) => c.ownerId === "agent",
      ).length;
      const agentFinalUnits = evalRecord.finalState.units.filter(
        (u) => u.ownerId === "agent",
      ).length;
      console.log(
        `  [eval] reward=${evalReward.toFixed(1)} cities=${agentFinalCities} units=${agentFinalUnits} turns=${evalRecord.turns}`,
      );
    }
  }

  agent.save(SAVE_PATH);
  console.log(`[train] done — ${EPISODES} episodes, ${totalSteps} steps total`);
  console.log(`[train] weights saved to ${SAVE_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
