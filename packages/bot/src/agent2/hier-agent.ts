import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import type { MLPWeights } from "../agent/mlp.js";
import type { EpisodeRecord } from "../agent/q-agent.js";
import type { GoalId, HierAgentConfig } from "./config.js";
import { DEFAULT_HIER_CONFIG } from "./config.js";
import {
  ALL_GOAL_IDS,
  NUM_INTENT_TYPES,
  MAX_INTENT_FEATURE_SIZE,
  goalOneHot,
  tacticalFeatureVector,
} from "./intent-features.js";
import { Manager } from "./manager.js";
import { buildHierRewardFn, type HierRewardFn } from "./rewards.js";
import {
  extractStateFeatures,
  computeStateFeatureSize,
  MAX_STATE_FEATURE_SIZE,
} from "./state-features.js";
import { Tactical } from "./tactical.js";

interface HierAgentSaveData {
  version: 2;
  managerNet: MLPWeights;
  tacticalNet: MLPWeights;
  managerEpsilon: number;
  tacticalEpsilon: number;
  totalTacticalUpdates: number;
  totalManagerUpdates: number;
  episodeHistory: EpisodeRecord[];
  stateFeatureSize: number;
  tacticalInputSize: number;
  managerInputSize: number;
  enabledGoalIds: string[];
}

export class HierAgent {
  private cfg: HierAgentConfig;
  private content: ContentPack;
  private manager: Manager;
  private tactical: Tactical;
  private enabledGoals: GoalId[];
  private goalRewardFns: Map<GoalId, HierRewardFn>;
  private globalRewardFn: HierRewardFn;

  private stateFeatureSize: number;
  private managerInputSize: number;
  private tacticalInputSize: number;

  // Current goal tracking
  private currentGoal: GoalId;
  private stepsInCurrentGoal = 0;
  private stateFeatsAtGoalStart: number[] = [];
  private accumulatedGoalReward = 0;

  // City count tracking for turns_since_last_city
  private turnsSinceLastCity = 0;
  private lastCityCount = 0;

  // Last selected phi (for tactical update)
  private lastPhi: number[] | null = null;
  private lastIntent: Intent | null = null;

  episodeHistory: EpisodeRecord[] = [];

  constructor(cfg: HierAgentConfig = DEFAULT_HIER_CONFIG, content: ContentPack) {
    this.cfg = cfg;
    this.content = content;
    this.enabledGoals = cfg.goals.filter((g) => g.enabled).map((g) => g.id);

    // Build reward functions per goal
    this.goalRewardFns = new Map();
    for (const goalDef of cfg.goals) {
      if (goalDef.enabled) {
        this.goalRewardFns.set(goalDef.id, buildHierRewardFn(goalDef.rewards));
      }
    }
    this.globalRewardFn = buildHierRewardFn(cfg.global_rewards);

    // Compute input sizes
    this.stateFeatureSize = computeStateFeatureSize(cfg.features.state);
    this.managerInputSize = this.stateFeatureSize + this.enabledGoals.length;
    this.tacticalInputSize =
      this.stateFeatureSize + this.enabledGoals.length + NUM_INTENT_TYPES + MAX_INTENT_FEATURE_SIZE;

    this.manager = new Manager(cfg.manager, this.stateFeatureSize, this.enabledGoals);
    this.tactical = new Tactical(cfg.tactical, this.tacticalInputSize, this.enabledGoals);

    this.currentGoal = this.enabledGoals[0] ?? "explore";
  }

  getCurrentGoal(): GoalId { return this.currentGoal; }

  getCurrentRewardFn(): HierRewardFn {
    const goalFn = this.goalRewardFns.get(this.currentGoal) ?? (() => 0);
    const globalFn = this.globalRewardFn;
    return (prev, next, playerId) =>
      goalFn(prev, next, playerId) + globalFn(prev, next, playerId);
  }

  selectIntent(
    legalIntents: Intent[],
    view: MatchView,
    playerId: string,
    training = true,
  ): Intent {
    // Track city count for turns_since_last_city
    const cityCount = view.cities.filter((c) => c.ownerId === playerId).length;
    if (cityCount > this.lastCityCount) {
      this.turnsSinceLastCity = 0;
      this.lastCityCount = cityCount;
    }

    const stateFeats = extractStateFeatures(
      view, playerId, this.cfg.features.state, this.content, this.turnsSinceLastCity,
    );

    // Check if we need to switch goals
    const goalHorizon = this.cfg.manager.goal_horizon;
    if (this.stepsInCurrentGoal === 0 || this.stepsInCurrentGoal >= goalHorizon) {
      // Fire manager update if we've completed a goal horizon (not first step)
      if (this.stepsInCurrentGoal >= goalHorizon && this.stateFeatsAtGoalStart.length > 0) {
        this.manager.update(
          this.stateFeatsAtGoalStart,
          this.currentGoal,
          this.accumulatedGoalReward,
          stateFeats,
        );
      }

      this.currentGoal = this.manager.selectGoal(stateFeats, training);
      this.stepsInCurrentGoal = 0;
      this.stateFeatsAtGoalStart = stateFeats;
      this.accumulatedGoalReward = 0;
    }

    const intent = this.tactical.selectIntent(
      legalIntents,
      stateFeats,
      this.currentGoal,
      view,
      playerId,
      this.cfg.features.intent,
      this.content,
      training,
    );

    // Store phi for update in stepUpdate
    const goalVec = goalOneHot(this.currentGoal, this.enabledGoals);
    this.lastPhi = tacticalFeatureVector(
      stateFeats, goalVec, intent, view, playerId, this.cfg.features.intent, this.content,
    );
    this.lastIntent = intent;
    this.stepsInCurrentGoal++;

    return intent;
  }

  stepUpdate(
    prevView: MatchView,
    _intent: Intent,
    reward: number,
    nextView: MatchView | null,
    playerId: string,
  ): void {
    if (this.lastPhi === null) return;

    const nextStateFeats = nextView
      ? extractStateFeatures(
          nextView, playerId, this.cfg.features.state, this.content, this.turnsSinceLastCity,
        )
      : null;

    const nextLegal = nextView
      ? getLegalIntents(nextView, playerId, this.content)
      : [];

    this.tactical.update(
      this.lastPhi,
      reward,
      nextStateFeats,
      this.currentGoal,
      nextLegal,
      nextView,
      playerId,
      this.cfg.features.intent,
      this.content,
    );

    this.accumulatedGoalReward += reward;

    // Increment turns_since_last_city if turn changed
    if (nextView && nextView.turnNumber > prevView.turnNumber) {
      this.turnsSinceLastCity++;
    }

    this.lastPhi = null;
    this.lastIntent = null;
  }

  endEpisode(
    totalReward: number,
    meta: { steps?: number; turns?: number; winner?: string | null } = {},
  ): void {
    // Final manager update (terminal)
    if (this.stateFeatsAtGoalStart.length > 0) {
      this.manager.update(
        this.stateFeatsAtGoalStart,
        this.currentGoal,
        this.accumulatedGoalReward,
        null, // terminal
      );
      this.manager.decayEpsilon();
    }

    this.tactical.decayEpsilon();

    this.episodeHistory.push({
      episode: this.episodeHistory.length + 1,
      reward: totalReward,
      steps: meta.steps ?? 0,
      turns: meta.turns ?? 0,
      winner: meta.winner,
      epsilon: this.tactical.epsilon,
    });

    // Reset episode state
    this.stepsInCurrentGoal = 0;
    this.stateFeatsAtGoalStart = [];
    this.accumulatedGoalReward = 0;
    this.turnsSinceLastCity = 0;
    this.lastCityCount = 0;
    this.lastPhi = null;
    this.lastIntent = null;
  }

  getEpsilons(): { manager: number; tactical: number } {
    return { manager: this.manager.epsilon, tactical: this.tactical.epsilon };
  }

  stats(): string {
    const n = this.episodeHistory.length;
    if (n === 0) return "no episodes yet";
    const last10 = this.episodeHistory.slice(-10).map((e) => e.reward);
    const avg = last10.reduce((a, b) => a + b, 0) / last10.length;
    return `episodes=${n} goal=${this.currentGoal} ε_mgr=${this.manager.epsilon.toFixed(3)} ε_tac=${this.tactical.epsilon.toFixed(3)} avg_reward(last10)=${avg.toFixed(2)} tac_updates=${this.tactical.totalUpdates}`;
  }

  save(path: string): void {
    const data: HierAgentSaveData = {
      version: 2,
      managerNet: this.manager.toJSON(),
      tacticalNet: this.tactical.toJSON(),
      managerEpsilon: this.manager.epsilon,
      tacticalEpsilon: this.tactical.epsilon,
      totalTacticalUpdates: this.tactical.totalUpdates,
      totalManagerUpdates: this.manager.totalUpdates,
      episodeHistory: this.episodeHistory,
      stateFeatureSize: this.stateFeatureSize,
      tacticalInputSize: this.tacticalInputSize,
      managerInputSize: this.managerInputSize,
      enabledGoalIds: this.enabledGoals,
    };
    writeFileSync(path, JSON.stringify(data));
  }

  load(path: string): void {
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HierAgentSaveData>;

    if (raw.version !== 2) {
      console.warn("[HierAgent] incompatible save version — starting fresh");
      return;
    }

    if (raw.stateFeatureSize !== this.stateFeatureSize) {
      console.warn(
        `[HierAgent] stateFeatureSize mismatch: saved=${raw.stateFeatureSize} expected=${this.stateFeatureSize} — starting fresh`,
      );
      return;
    }
    if (raw.tacticalInputSize !== this.tacticalInputSize) {
      console.warn(
        `[HierAgent] tacticalInputSize mismatch: saved=${raw.tacticalInputSize} expected=${this.tacticalInputSize} — starting fresh`,
      );
      return;
    }
    if (raw.managerInputSize !== this.managerInputSize) {
      console.warn(
        `[HierAgent] managerInputSize mismatch: saved=${raw.managerInputSize} expected=${this.managerInputSize} — starting fresh`,
      );
      return;
    }
    const savedGoals = raw.enabledGoalIds ?? [];
    if (
      savedGoals.length !== this.enabledGoals.length ||
      savedGoals.some((g, i) => g !== this.enabledGoals[i])
    ) {
      console.warn(
        `[HierAgent] enabledGoals mismatch: saved=[${savedGoals.join(",")}] expected=[${this.enabledGoals.join(",")}] — starting fresh`,
      );
      return;
    }

    if (raw.managerNet) {
      this.manager = Manager.fromJSON(
        raw.managerNet, this.cfg.manager, this.enabledGoals, this.stateFeatureSize,
      );
      this.manager.epsilon = raw.managerEpsilon ?? this.manager.epsilon;
      this.manager.totalUpdates = raw.totalManagerUpdates ?? 0;
    }
    if (raw.tacticalNet) {
      this.tactical = Tactical.fromJSON(
        raw.tacticalNet, this.cfg.tactical, this.tacticalInputSize, this.enabledGoals,
      );
      this.tactical.epsilon = raw.tacticalEpsilon ?? this.tactical.epsilon;
      this.tactical.totalUpdates = raw.totalTacticalUpdates ?? 0;
    }
    this.episodeHistory = raw.episodeHistory ?? [];
  }
}
