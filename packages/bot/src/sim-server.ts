#!/usr/bin/env tsx
/**
 * BrowserCiv Simulation Control Server — port 3334
 *
 * Usage:
 *   pnpm sim-server
 *   pnpm sim-server -- --port 3334 --no-spawn
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";

import WebSocket from "ws";
import type { ContentPack, MatchView } from "@browserciv/shared";
import { HierAgent } from "./agent2/hier-agent.js";
import type { HierAgentConfig } from "./agent2/config.js";
import { DEFAULT_HIER_CONFIG } from "./agent2/config.js";
import { runHierTrainingEpisode, type StepController } from "./hier-train-runner.js";
import { launchPyTorchTraining, getPyTorchLiveState, getS3Json } from "./ec2-training.js";
import { snapTurn, type EpisodeDump, type TurnSnap } from "./dump.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOT_DIR = resolve(ROOT, "packages/bot");
const RUNS_DIR = resolve(BOT_DIR, "runs");
const SERVER_URL = "http://localhost:8787";
const CLIENT_URL = "http://localhost:5173";

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== "--");
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
function flag(name: string): boolean { return argv.includes(name); }

const PORT = parseInt(arg("--port") ?? "3334", 10);
const NO_SPAWN = flag("--no-spawn");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BotSlotConfig {
  type: "hier" | "greedy" | "random" | "passive" | "pytorch";
  agentFile?: string;
  agentConfig?: HierAgentConfig;
  saveFile?: string;
}

export interface SimConfig {
  agentSlot: BotSlotConfig;
  opponentSlot: BotSlotConfig;
  mapSize: "small" | "medium" | "large";
  episodes: number;
  maxTurns: number;
  gameServerUrl?: string;
  stepDelayMs?: number;
}

type SimState = "idle" | "running" | "paused" | "done" | "aborted";

export interface EpRecord {
  episode: number;
  outcome: string;
  reward: number;
  turns: number;
  kills: number;
  captures: number;
  managerEpsilon?: number;
  tacticalEpsilon?: number;
}

interface RunMeta {
  runId: string;
  agentFile: string | null;
  strategy: string;
  mapSize: string;
  totalEpisodes: number;
  completedEpisodes: number;
  startTime: string;
  endTime?: string;
  summary?: {
    wins: number; losses: number; draws: number;
    totalKills: number; totalCaptures: number; avgReward: number;
  };
}

// ── ManualTrigger ─────────────────────────────────────────────────────────────

class ManualTrigger {
  private resolvers: Array<() => void> = [];
  private stepOnce = false;

  wait(): Promise<void> {
    return new Promise<void>((r) => { this.resolvers.push(r); });
  }

  fire(once = false): void {
    this.stepOnce = once;
    const all = this.resolvers.splice(0);
    for (const r of all) r();
  }

  shouldStepOnce(): boolean {
    const v = this.stepOnce;
    this.stepOnce = false;
    return v;
  }
}

// ── SimSession ────────────────────────────────────────────────────────────────

class SimSession {
  readonly id: string;
  readonly cfg: SimConfig;
  state: SimState = "idle";
  currentEpisode = 0;
  currentTurn = 0;
  spectatorToken: string | null = null;
  matchId: string | null = null;
  agentPlayerId: string | null = null;
  gameServerUrl: string | null = null;
  readonly sseClients = new Set<ServerResponse>();
  readonly episodeLog: EpRecord[] = [];
  runDir: string | null = null;
  runId: string | null = null;

  private paused = false;
  private aborted = false;
  private trigger = new ManualTrigger();
  private agent: HierAgent | null = null;
  private agent2: HierAgent | null = null;
  private content: ContentPack | null = null;
  private stepPauseAfter = false;

  constructor(id: string, cfg: SimConfig) {
    this.id = id;
    this.cfg = cfg;
  }

  // ── Control ────────────────────────────────────────────────────────────────

  pause(): void {
    this.paused = true;
    this.state = "paused";
    this.emitStatus();
  }

  resume(speed: "fast" | "slow" = "fast"): void {
    this.paused = false;
    this.stepPauseAfter = false;
    this.state = "running";
    (this as unknown as Record<string, unknown>)._speedDelayMs = speed === "slow" ? 800 : 0;
    this.trigger.fire();
    this.emitStatus();
  }

  step(): void {
    // Advance exactly one player-turn then re-pause
    this.stepPauseAfter = true;
    this.trigger.fire(true);
    // state will flip back to "paused" in makeStepController after the turn completes
  }

  abort(): void {
    this.aborted = true;
    this.paused = false;
    this.trigger.fire();
    this.state = "aborted";
    this.emitStatus();
  }

  get speedDelayMs(): number {
    return ((this as unknown as Record<string, unknown>)._speedDelayMs as number | undefined) ?? 0;
  }

  // ── StepController for runner ─────────────────────────────────────────────

  makeStepController(): StepController {
    const session = this;
    let stepInProgress = false;
    return {
      shouldPause(): boolean {
        if (session.aborted) return false;
        // re-pause after step completes
        if (stepInProgress && session.stepPauseAfter) {
          stepInProgress = false;
          session.paused = true;
          session.state = "paused";
          session.emitStatus();
        }
        return session.paused;
      },
      async waitForResume(): Promise<void> {
        stepInProgress = true;
        return session.trigger.wait();
      },
      getDelayMs(): number {
        return session.speedDelayMs;
      },
      isActive(): boolean {
        return !session.paused && !session.aborted;
      },
    };
  }

  // ── SSE helpers ───────────────────────────────────────────────────────────

  addSSEClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
    // Send current status immediately on connect
    this.emitStatus();
  }

  emit(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch { this.sseClients.delete(res); }
    }
  }

  emitStatus(): void {
    this.emit("status", {
      state: this.state,
      episode: this.currentEpisode,
      totalEpisodes: this.cfg.episodes,
      turn: this.currentTurn,
      maxTurns: this.cfg.maxTurns,
      spectatorToken: this.spectatorToken,
      matchId: this.matchId,
      runId: this.runId,
      agentPlayerId: this.agentPlayerId,
      gameServerUrl: this.gameServerUrl,
    });
  }

  getStatus(): object {
    return {
      id: this.id,
      state: this.state,
      episode: this.currentEpisode,
      totalEpisodes: this.cfg.episodes,
      turn: this.currentTurn,
      maxTurns: this.cfg.maxTurns,
      spectatorToken: this.spectatorToken,
      matchId: this.matchId,
      runId: this.runId,
      agentPlayerId: this.agentPlayerId,
      episodeLog: this.episodeLog,
      displayInfo: this.cfg.agentSlot ? {
        agentType: this.cfg.agentSlot.type,
        agentFile: this.cfg.agentSlot.agentFile ?? null,
        saveFile: this.cfg.agentSlot.saveFile ?? null,
        opponentType: this.cfg.opponentSlot?.type ?? "unknown",
        opponentFile: this.cfg.opponentSlot?.agentFile ?? null,
        mapSize: this.cfg.mapSize,
      } : null,
    };
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "running";

    // Load content pack
    try {
      const r = await fetch(`${this.cfg.gameServerUrl ?? SERVER_URL}/content-pack`);
      if (!r.ok) throw new Error(`content-pack: ${r.status}`);
      this.content = (await r.json()) as ContentPack;
    } catch (e) {
      console.error("[sim-server] failed to load content pack:", e);
      this.state = "aborted";
      this.emitStatus();
      return;
    }

    // PyTorch path — launch EC2 spot, poll S3 live.json, stream SSE
    if (this.cfg.agentSlot.type === "pytorch") {
      await this.startPyTorch();
      return;
    }

    // Build agent — deep-merge provided config over defaults so partial configs work
    const slot = this.cfg.agentSlot;
    const agentCfg: HierAgentConfig = slot.agentConfig
      ? { ...DEFAULT_HIER_CONFIG, ...slot.agentConfig, features: { ...DEFAULT_HIER_CONFIG.features, ...(slot.agentConfig.features ?? {}) } }
      : DEFAULT_HIER_CONFIG;
    this.agent = new HierAgent(agentCfg, this.content);

    if (slot.agentFile) {
      const agentPath = resolve(BOT_DIR, slot.agentFile);
      if (existsSync(agentPath)) {
        this.agent.load(agentPath);
        console.log(`[sim-server] loaded agent from ${agentPath}`);
      }
    }

    // Create run folder + meta
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runId = `run-${ts}`;
    this.runDir = resolve(RUNS_DIR, this.runId);
    mkdirSync(this.runDir, { recursive: true });

    const meta: RunMeta = {
      runId: this.runId,
      agentFile: slot.agentFile ?? null,
      strategy: this.cfg.opponentSlot.type,
      mapSize: this.cfg.mapSize,
      totalEpisodes: this.cfg.episodes,
      completedEpisodes: 0,
      startTime: new Date().toISOString(),
    };
    writeFileSync(resolve(this.runDir, "meta.json"), JSON.stringify(meta, null, 2));

    const stepCtrl = this.makeStepController();
    const oppSlot = this.cfg.opponentSlot;
    const isRlVsRl = oppSlot.type === "hier";

    // Build opponent RL agent if needed
    if (isRlVsRl) {
      const oppCfg: HierAgentConfig = oppSlot.agentConfig
        ? { ...DEFAULT_HIER_CONFIG, ...oppSlot.agentConfig, features: { ...DEFAULT_HIER_CONFIG.features, ...(oppSlot.agentConfig.features ?? {}) } }
        : DEFAULT_HIER_CONFIG;
      this.agent2 = new HierAgent(oppCfg, this.content);
      if (oppSlot.agentFile) {
        const oppPath = resolve(BOT_DIR, oppSlot.agentFile);
        if (existsSync(oppPath)) {
          this.agent2.load(oppPath);
          console.log(`[sim-server] loaded opponent agent from ${oppPath}`);
        }
      }
    }

    for (let ep = 1; ep <= this.cfg.episodes; ep++) {
      if (this.aborted) break;
      this.currentEpisode = ep;
      this.currentTurn = 0;

      // Create match (also get opponentToken for RL-vs-RL)
      const oppStrategy = !isRlVsRl ? (oppSlot.type as "greedy" | "random" | "passive") : "random";
      let setup: {
        matchId: string;
        agentToken: { playerId: string; token: string };
        opponentToken: { playerId: string; token: string };
        spectatorToken: { token: string };
        opponentId: string;
        strategy: string;
      };
      try {
        const r = await fetch(`${this.cfg.gameServerUrl ?? SERVER_URL}/train-setup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mapSize: this.cfg.mapSize, strategy: oppStrategy }),
        });
        if (!r.ok) throw new Error(`train-setup: ${r.status} ${await r.text()}`);
        setup = (await r.json()) as typeof setup;
      } catch (e) {
        console.error("[sim-server] train-setup failed:", e);
        break;
      }

      this.matchId = setup.matchId;
      this.spectatorToken = setup.spectatorToken.token;
      this.agentPlayerId = setup.agentToken.playerId;
      this.emitStatus();

      // Connect spectator WS for full-visibility metrics (no fog artifacts)
      let latestSpectatorView: MatchView | null = null;
      const baseUrl = this.cfg.gameServerUrl ?? SERVER_URL;
      const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      const specWs = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(setup.spectatorToken.token)}`);
      specWs.on("open", () => {
        specWs.send(JSON.stringify({ type: "Hello", matchId: setup.matchId, playerId: "", lastSeq: 0 }));
      });
      specWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { type: string; state?: MatchView };
          if (msg.type === "Snapshot" && msg.state) latestSpectatorView = msg.state as MatchView;
        } catch { /**/ }
      });

      // Start match
      try {
        const r = await fetch(`${this.cfg.gameServerUrl ?? SERVER_URL}/train-start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            matchId: setup.matchId,
            agentToken: setup.agentToken.token,
            opponentId: setup.opponentId,
            strategy: oppStrategy,
            noFog: false,
            skipBot: isRlVsRl,
          }),
        });
        if (!r.ok) throw new Error(`train-start: ${r.status} ${await r.text()}`);
      } catch (e) {
        console.error("[sim-server] train-start failed:", e);
        specWs.close();
        break;
      }

      console.log(`[sim-server] Episode ${ep}/${this.cfg.episodes} — match ${setup.matchId}${isRlVsRl ? " (RL vs RL)" : ""}`);

      const sharedRunnerOpts = {
        serverUrl: this.cfg.gameServerUrl ?? SERVER_URL,
        matchId: setup.matchId,
        content: this.content,
        verbose: false,
        stallTimeoutMs: 45_000,
        stepController: stepCtrl,
        maxTurns: this.cfg.maxTurns,
      } as const;

      const agent1RunOpts = {
        ...sharedRunnerOpts,
        agentToken: setup.agentToken.token,
        playerId: setup.agentToken.playerId,
        agent: this.agent,
        stepDelayMs: this.speedDelayMs,
        onTurnSnap: (agentSnap: TurnSnap) => {
          this.currentTurn = agentSnap.turn;
          // Spectator view gives accurate full-visibility city/unit counts.
          // Preserve seenTiles/totalTiles from the agent's fogged view for real exploration %.
          const snap: TurnSnap = latestSpectatorView
            ? {
                ...snapTurn(latestSpectatorView, setup.agentToken.playerId, agentSnap.cumKills, agentSnap.cumCaptures),
                seenTiles: agentSnap.seenTiles,
                totalTiles: agentSnap.totalTiles,
              }
            : agentSnap;
          this.emit("snapshot", { episode: ep, turn: snap.turn, snap });
        },
      };

      let result: import("./train-runner.js").EpisodeResult;
      if (isRlVsRl && this.agent2) {
        const [r1, r2] = await Promise.all([
          runHierTrainingEpisode(agent1RunOpts),
          runHierTrainingEpisode({
            ...sharedRunnerOpts,
            agentToken: setup.opponentToken.token,
            playerId: setup.opponentToken.playerId,
            agent: this.agent2,
            stepDelayMs: 0,
          }),
        ]);
        result = r1;
        this.agent2.endEpisode(r2.agentReward, {
          steps: r2.agentSteps, turns: r2.turns, winner: r2.winner ?? null,
        });
        if (oppSlot.saveFile) {
          this.agent2.save(resolve(BOT_DIR, oppSlot.saveFile));
        }
      } else {
        result = await runHierTrainingEpisode(agent1RunOpts);
      }

      specWs.close();

      const won = result.winner === setup.agentToken.playerId;
      const lost = result.winner != null && !won;
      const outcome = result.timedOut ? "TIMED OUT" : won ? "WON" : lost ? "LOST" : "DRAW";
      const kills = result.kills ?? 0;
      const captures = result.citiesCaptured ?? 0;

      this.agent.endEpisode(result.agentReward, {
        steps: result.agentSteps, turns: result.turns, winner: result.winner ?? null,
      });

      if (slot.saveFile) {
        const savePath = resolve(BOT_DIR, slot.saveFile);
        this.agent.save(savePath);
      }

      const epsilons = slot.type === "hier" ? this.agent.getEpsilons() : null;
      const epRecord: EpRecord = {
        episode: ep, outcome, reward: result.agentReward,
        turns: result.turns, kills, captures,
        managerEpsilon: epsilons?.manager,
        tacticalEpsilon: epsilons?.tactical,
      };
      this.episodeLog.push(epRecord);

      // Save episode dump
      if (result.dump && result.dump.length > 0 && this.runDir) {
        const dump: EpisodeDump = {
          episode: ep,
          agentId: setup.agentToken.playerId,
          opponentId: setup.opponentId,
          outcome,
          totalReward: result.agentReward,
          totalKills: kills,
          totalCaptures: captures,
          turns: result.dump,
        };
        const dumpPath = resolve(this.runDir, `episode-${String(ep).padStart(3, "0")}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump));

        // Update meta
        meta.completedEpisodes = ep;
        writeFileSync(resolve(this.runDir, "meta.json"), JSON.stringify(meta, null, 2));
      }

      this.emit("episode", epRecord);
      console.log(`[sim-server]   ${outcome} | reward=${result.agentReward.toFixed(1)} kills=${kills} captures=${captures}`);
    }

    if (!this.aborted) {
      this.state = "done";
      // Finalize meta
      if (this.runDir) {
        meta.completedEpisodes = this.episodeLog.length;
        meta.endTime = new Date().toISOString();
        const wins = this.episodeLog.filter((r) => r.outcome === "WON").length;
        const losses = this.episodeLog.filter((r) => r.outcome === "LOST").length;
        const draws = this.episodeLog.filter((r) => r.outcome === "DRAW").length;
        const totalKills = this.episodeLog.reduce((s, r) => s + r.kills, 0);
        const totalCaptures = this.episodeLog.reduce((s, r) => s + r.captures, 0);
        const avgReward = this.episodeLog.reduce((s, r) => s + r.reward, 0) / (this.episodeLog.length || 1);
        meta.summary = { wins, losses, draws, totalKills, totalCaptures, avgReward };
        writeFileSync(resolve(this.runDir, "meta.json"), JSON.stringify(meta, null, 2));
      }
    }

    this.emit("done", { summary: this.episodeLog });
    this.emitStatus();
  }

  // ── PyTorch / EC2 path ──────────────────────────────────────────────────────

  log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`[sim-server] ${message}`);
    this.emit("log", { message, ts });
  }

  private async startPyTorch(): Promise<void> {
    const bucket  = process.env.MODEL_BUCKET ?? "";
    const amiId   = process.env.TRAINING_AMI_ID ?? "";
    const profile = process.env.TRAINING_INSTANCE_PROFILE ?? "";
    const sgId    = process.env.TRAINING_SG_ID ?? "";
    const subnet  = process.env.TRAINING_SUBNET_ID ?? "";
    const extUrl  = process.env.GAME_SERVER_EXTERNAL ?? this.cfg.gameServerUrl ?? SERVER_URL;

    if (!bucket || !amiId || !profile || !sgId || !subnet) {
      this.log("ERROR: PyTorch training not configured — missing env vars (MODEL_BUCKET, TRAINING_AMI_ID, etc.)");
      this.state = "aborted";
      this.emitStatus();
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runPrefix = `runs/${ts}`;

    this.log(`Launching EC2 spot instance (${amiId}, c5.2xlarge) in subnet ${subnet} …`);

    let handle: { instanceId: string; liveKey: string };
    try {
      handle = await launchPyTorchTraining({
        gameServerUrl: extUrl,
        s3Bucket: bucket,
        runPrefix,
        mapSize: this.cfg.mapSize,
        opponentStrategy: this.cfg.opponentSlot.type === "pytorch" ? "random" : this.cfg.opponentSlot.type,
        episodes: this.cfg.episodes,
        maxTurns: this.cfg.maxTurns,
        stepDelayMs: this.cfg.stepDelayMs ?? 0,
        amiId,
        instanceProfileArn: profile,
        securityGroupId: sgId,
        subnetId: subnet,
      });
    } catch (e) {
      this.log(`ERROR: EC2 launch failed — ${(e as Error).message}`);
      this.state = "aborted";
      this.emitStatus();
      return;
    }

    this.runId = runPrefix;
    this.gameServerUrl = extUrl;
    this.log(`EC2 instance ${handle.instanceId} launched. Waiting for training to begin …`);
    this.log(`Game server: ${extUrl}`);
    this.log(`S3 run prefix: s3://${bucket}/${runPrefix}`);
    this.log(`Polling s3://${bucket}/${handle.liveKey} every 3s for live state`);

    let lastEpisode = -1;
    let pollsWithoutData = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let specWs: any = null;
    let latestSpecState: MatchView | null = null;
    let specMatchId: string | null = null;
    let specPlayerId: string | null = null;
    let currentKills = 0;
    let currentCaptures = 0;

    const wsUrl = (this.cfg.gameServerUrl ?? SERVER_URL)
      .replace("https://", "wss://").replace("http://", "ws://");

    const connectSpec = (matchId: string, token: string, agentPlayerId: string) => {
      if (specWs) { try { specWs.close(); } catch { /**/ } }
      latestSpecState = null;
      specMatchId = matchId;
      specPlayerId = agentPlayerId;

      const doConnect = () => {
        if (specMatchId !== matchId || this.aborted) return; // superseded by newer episode
        const ws = new WebSocket(`${wsUrl}/ws?token=${token}`);
        specWs = ws;
        ws.on("message", (raw: Buffer) => {
          try {
            const msg = JSON.parse(String(raw)) as { type: string; state?: MatchView };
            if (msg.type === "Snapshot" && msg.state) {
              latestSpecState = msg.state as MatchView;
              if (specPlayerId) {
                const snap = snapTurn(latestSpecState, specPlayerId, currentKills, currentCaptures);
                this.currentTurn = snap.turn;
                this.emit("snapshot", { episode: this.currentEpisode, turn: snap.turn, snap });
              }
            }
          } catch { /**/ }
        });
        ws.on("close", () => {
          if (specMatchId === matchId && !this.aborted) {
            this.log(`[spec] WS closed for ep ${this.currentEpisode} — reconnecting in 3s`);
            setTimeout(doConnect, 3000);
          }
        });
        ws.on("error", (err: Error) => {
          this.log(`[spec] WS error: ${err.message}`);
          // close event fires after error and handles reconnect
        });
      };
      doConnect();
    };

    // Poll S3 live.json until done or aborted
    while (!this.aborted) {
      await new Promise<void>((r) => setTimeout(r, 3000));
      const live = await getPyTorchLiveState(bucket, handle.liveKey);

      if (!live) {
        pollsWithoutData++;
        if (pollsWithoutData === 5)  this.log("Instance booting — downloading agent-py.zip from S3 …");
        if (pollsWithoutData === 15) this.log("Installing Python dependencies (torch, aiohttp) …");
        if (pollsWithoutData === 25) this.log("Still waiting — instance may be initialising or pip install is running …");
        continue;
      }

      pollsWithoutData = 0;

      // Connect spectator WS for each new episode so we can get real game metrics.
      if (live.episode !== lastEpisode) {
        this.log(`Episode ${live.episode + 1}/${live.totalEpisodes} started — match ${live.matchId ?? "?"}`);
        lastEpisode = live.episode;
        if (live.matchId && live.spectatorToken && live.agentPlayerId) {
          connectSpec(live.matchId, live.spectatorToken, live.agentPlayerId);
        }
      }

      currentKills    = live.cumKills ?? 0;
      currentCaptures = live.cumCaptures ?? 0;
      this.currentEpisode = live.episode;
      this.currentTurn    = live.turn;
      this.matchId        = live.matchId;
      this.spectatorToken = live.spectatorToken;
      if (live.agentPlayerId) this.agentPlayerId = live.agentPlayerId;
      this.state          = live.done ? "done" : "running";
      this.emitStatus();

      if (live.done) {
        this.log(`Training complete — ${live.totalEpisodes} episodes finished.`);
        const sw = specWs;
        if (sw) { try { sw.close(); } catch { /**/ } }
        break;
      }
    }

    if (!this.aborted) {
      // Read per-episode records from the progress.json the training script wrote.
      const progressKey = `${runPrefix}/model.pt.progress.json`;
      const progress = await getS3Json(bucket, progressKey) as { records?: unknown[] } | null;
      const summary = progress?.records ?? [];
      this.emit("done", { summary });
    }
    this.emitStatus();
  }
}

// ── Run management ────────────────────────────────────────────────────────────

const sessions = new Map<string, SimSession>();
let nextSimId = 1;

function listAgentFiles(): Array<{ name: string; episodes: number }> {
  try {
    return readdirSync(BOT_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .filter((f) => {
        try {
          const d = JSON.parse(readFileSync(resolve(BOT_DIR, f), "utf8")) as { version?: number };
          return d.version === 2;
        } catch { return false; }
      })
      .map((f) => {
        const d = JSON.parse(readFileSync(resolve(BOT_DIR, f), "utf8")) as { episodeHistory?: unknown[] };
        return { name: f, episodes: d.episodeHistory?.length ?? 0 };
      });
  } catch { return []; }
}

function listRuns(): RunMeta[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((name) => {
      try { return statSync(resolve(RUNS_DIR, name)).isDirectory(); } catch { return false; }
    })
    .map((name) => {
      const metaPath = resolve(RUNS_DIR, name, "meta.json");
      if (!existsSync(metaPath)) return null;
      try { return JSON.parse(readFileSync(metaPath, "utf8")) as RunMeta; } catch { return null; }
    })
    .filter((m): m is RunMeta => m !== null)
    .sort((a, b) => b.startTime.localeCompare(a.startTime));
}

function listRunEpisodes(runId: string): string[] {
  const dir = resolve(RUNS_DIR, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("episode-") && f.endsWith(".json"))
    .sort();
}

function getRunEpisode(runId: string, idx: number): string | null {
  const files = listRunEpisodes(runId);
  if (idx < 0 || idx >= files.length) return null;
  const p = resolve(RUNS_DIR, runId, files[idx]!);
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: "NOT_FOUND" }, 404);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  // GET /agents
  if (method === "GET" && path === "/agents") {
    return json(res, listAgentFiles());
  }

  // GET /runs
  if (method === "GET" && path === "/runs") {
    return json(res, listRuns());
  }

  // GET /runs/:runId/episodes
  const runEpsMatch = path.match(/^\/runs\/([^/]+)\/episodes$/);
  if (method === "GET" && runEpsMatch) {
    const runId = decodeURIComponent(runEpsMatch[1]!);
    return json(res, listRunEpisodes(runId));
  }

  // GET /runs/:runId/episode/:idx
  const runEpMatch = path.match(/^\/runs\/([^/]+)\/episode\/(\d+)$/);
  if (method === "GET" && runEpMatch) {
    const runId = decodeURIComponent(runEpMatch[1]!);
    const idx = parseInt(runEpMatch[2]!, 10);
    const data = getRunEpisode(runId, idx);
    if (!data) return notFound(res);
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(data);
  }

  // GET /runs/:runId/meta
  const runMetaMatch = path.match(/^\/runs\/([^/]+)\/meta$/);
  if (method === "GET" && runMetaMatch) {
    const runId = decodeURIComponent(runMetaMatch[1]!);
    const metaPath = resolve(RUNS_DIR, runId, "meta.json");
    if (!existsSync(metaPath)) return notFound(res);
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(readFileSync(metaPath, "utf8"));
  }

  // GET /sim/active — list running/paused sessions
  if (method === "GET" && path === "/sim/active") {
    const active = [...sessions.values()]
      .filter((s) => s.state === "running" || s.state === "paused")
      .map((s) => s.getStatus());
    return json(res, active);
  }

  // POST /sim — create simulation
  if (method === "POST" && path === "/sim") {
    void (async () => {
      const body = (await readBody(req)) as SimConfig;
      if (!body?.agentSlot || !body?.opponentSlot) {
        cors(res);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing agentSlot or opponentSlot in body" }));
        return;
      }
      const id = String(nextSimId++);
      const session = new SimSession(id, body);
      sessions.set(id, session);
      json(res, { simId: id });
    })();
    return;
  }

  // GET /sim/:id — status
  const simIdMatch = path.match(/^\/sim\/([^/]+)$/);
  if (method === "GET" && simIdMatch) {
    const session = sessions.get(simIdMatch[1]!);
    if (!session) return notFound(res);
    return json(res, session.getStatus());
  }

  // DELETE /sim/:id
  if (method === "DELETE" && simIdMatch) {
    const session = sessions.get(simIdMatch[1]!);
    if (!session) return notFound(res);
    session.abort();
    sessions.delete(simIdMatch[1]!);
    return json(res, { ok: true });
  }

  // POST /sim/:id/start|pause|resume|step
  const simActionMatch = path.match(/^\/sim\/([^/]+)\/(start|pause|resume|step)$/);
  if (method === "POST" && simActionMatch) {
    const session = sessions.get(simActionMatch[1]!);
    if (!session) return notFound(res);
    const action = simActionMatch[2]!;

    if (action === "start") {
      void session.start();
      return json(res, { ok: true });
    }
    if (action === "pause") {
      session.pause();
      return json(res, { ok: true });
    }
    if (action === "resume") {
      void (async () => {
        const body = (await readBody(req)) as { speed?: "fast" | "slow" };
        session.resume(body.speed ?? "fast");
        json(res, { ok: true });
      })();
      return;
    }
    if (action === "step") {
      session.step();
      return json(res, { ok: true });
    }
  }

  // GET /sim/:id/events — SSE
  const simEventsMatch = path.match(/^\/sim\/([^/]+)\/events$/);
  if (method === "GET" && simEventsMatch) {
    const session = sessions.get(simEventsMatch[1]!);
    if (!session) return notFound(res);
    session.addSSEClient(res);
    return; // response stays open
  }

  notFound(res);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function waitForUrl(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  process.stdout.write(`  Waiting for ${label}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url); process.stdout.write(" ✓\n"); return; } catch { /**/ }
    process.stdout.write(".");
    await new Promise<void>((r) => setTimeout(r, 800));
  }
  process.stdout.write("\n");
  throw new Error(`Timed out waiting for ${label}`);
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const procs: ChildProcess[] = [];
  function cleanup(): void {
    for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill(); } catch { /**/ } } }
  }
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  if (!NO_SPAWN) {
    console.log("Starting game server and client…");
    procs.push(spawn("pnpm", ["dev:server"], { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"] }));
    procs.push(spawn("pnpm", ["dev:client"], { cwd: ROOT, detached: true, stdio: "ignore" }));
    await waitForUrl(`${SERVER_URL}/health`, "server");
    await waitForUrl(CLIENT_URL, "client");
  }

  server.listen(PORT, () => {
    const lanIp = getLanIp();
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  BrowserCiv Sim Server                ║`);
    console.log(`╚══════════════════════════════════════╝`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  Runs dir: ${RUNS_DIR}`);
    console.log(`  Local:  http://localhost:5173?sim=true`);
    if (lanIp) console.log(`  Network: http://${lanIp}:5173?sim=true`);
    console.log();
  });
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
