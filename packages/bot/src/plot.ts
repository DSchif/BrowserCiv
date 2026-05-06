#!/usr/bin/env tsx
/**
 * Print an ASCII training-history chart for a saved agent.
 *
 * Usage:
 *   pnpm --filter @browserciv/bot run plot -- --load ./agent.json
 *   pnpm --filter @browserciv/bot run plot -- --load ./agent.json --window 10
 */

import { readFileSync } from "node:fs";
import type { EpisodeRecord } from "./agent/q-agent.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const LOAD_PATH = arg("--load") ?? "./agent.json";
const WINDOW    = parseInt(arg("--window") ?? "10", 10);
const BAR_WIDTH = 40;

interface SaveFile {
  epsilon?: number;
  totalUpdates?: number;
  episodeHistory?: EpisodeRecord[];
}

const raw = JSON.parse(readFileSync(LOAD_PATH, "utf8")) as SaveFile;
const history: EpisodeRecord[] = raw.episodeHistory ?? [];

if (history.length === 0) {
  console.log("No episode history found in", LOAD_PATH);
  process.exit(0);
}

// ── Bucket rewards into windows of size WINDOW ────────────────────────────────

function bucket(records: EpisodeRecord[], size: number): { label: string; avg: number; wins: number; count: number }[] {
  const out = [];
  for (let i = 0; i < records.length; i += size) {
    const slice = records.slice(i, i + size);
    const avg   = slice.reduce((s, r) => s + r.reward, 0) / slice.length;
    const wins  = slice.filter((r) => r.winner === "agent").length;
    const first = slice[0]!.episode;
    const last  = slice[slice.length - 1]!.episode;
    const label = first === last ? `${first}` : `${first}-${last}`;
    out.push({ label, avg, wins, count: slice.length });
  }
  return out;
}

const buckets = bucket(history, WINDOW);
const maxAvg  = Math.max(...buckets.map((b) => b.avg), 1);
const minAvg  = Math.min(...buckets.map((b) => b.avg), 0);
const range   = maxAvg - minAvg || 1;

function bar(value: number): string {
  const filled = Math.max(0, Math.round(((value - minAvg) / range) * BAR_WIDTH));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

// ── Summary stats ─────────────────────────────────────────────────────────────

const allRewards  = history.map((r) => r.reward);
const totalEps    = history.length;
const bestReward  = Math.max(...allRewards);
const bestEp      = history.find((r) => r.reward === bestReward)!.episode;
const last20      = history.slice(-20);
const winRate     = (last20.filter((r) => r.winner === "agent").length / last20.length * 100).toFixed(0);
const recentAvg   = (last20.reduce((s, r) => s + r.reward, 0) / last20.length).toFixed(2);
const currentEps  = raw.epsilon?.toFixed(4) ?? "?";
const totalUpdates = raw.totalUpdates ?? "?";

// ── Print ─────────────────────────────────────────────────────────────────────

console.log();
console.log(`Agent: ${LOAD_PATH}`);
console.log(`Episodes: ${totalEps}  |  Updates: ${totalUpdates}  |  ε: ${currentEps}`);
console.log(`Best reward: ${bestReward.toFixed(2)} (ep ${bestEp})  |  Win rate (last 20): ${winRate}%  |  Avg reward (last 20): ${recentAvg}`);
console.log();
console.log(`Avg reward per ${WINDOW}-episode window  [min=${minAvg.toFixed(1)}  max=${maxAvg.toFixed(1)}]`);
console.log();

const labelWidth = Math.max(...buckets.map((b) => b.label.length), 5);
for (const b of buckets) {
  const label = b.label.padStart(labelWidth);
  const wins  = `${b.wins}W/${b.count - b.wins}L`.padEnd(8);
  console.log(`  ep ${label}: ${bar(b.avg)} ${b.avg.toFixed(2)}  ${wins}`);
}

console.log();
