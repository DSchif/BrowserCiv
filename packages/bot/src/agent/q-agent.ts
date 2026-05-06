import { readFileSync, writeFileSync } from "node:fs";
import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import { intentFeatures, TOTAL_FEATURE_SIZE } from "./features.js";
import type { RewardFn } from "./reward.js";

export interface QAgentConfig {
  epsilon: number;       // initial exploration rate
  epsilonDecay: number;  // multiplied each episode (e.g. 0.995)
  epsilonMin: number;    // floor for exploration
  gamma: number;         // discount factor (e.g. 0.95)
  lr: number;            // learning rate (e.g. 0.01)
  rewardFn: RewardFn;
}

export const DEFAULT_CONFIG: QAgentConfig = {
  epsilon: 1.0,
  epsilonDecay: 0.995,
  epsilonMin: 0.05,
  gamma: 0.95,
  lr: 0.01,
  rewardFn: () => 0,
};

interface Transition {
  features: number[];
  intentType: string;
  reward: number;
  nextFeatures: number[] | null; // null if terminal
  nextLegalTypes: string[];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Linear Q-learning agent.
 *
 * Q(s, a) = w · φ(s, a)
 *
 * where φ(s, a) = [state_features | action_category_one_hot]
 * and   w ∈ R^TOTAL_FEATURE_SIZE  (shared weights across all action types).
 *
 * One shared weight vector works because the action-type one-hot already
 * distinguishes actions; the model learns "how much each state feature
 * matters for each action type."
 *
 * Suitable for the small (~15-dim) feature space here. Swap for a NN
 * when you need more expressive power.
 */
export class QAgent {
  private w: number[];
  config: QAgentConfig;
  epsilon: number;
  totalUpdates = 0;
  episodeRewards: number[] = [];

  constructor(config: Partial<QAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilon;
    // Small random initialisation
    this.w = Array.from({ length: TOTAL_FEATURE_SIZE }, () => (Math.random() - 0.5) * 0.01);
  }

  /** Score a single intent given the current view. Higher = more preferred. */
  qValue(view: MatchView, playerId: string, intentType: string): number {
    return dot(this.w, intentFeatures(view, playerId, intentType));
  }

  /**
   * Select an intent from `legalIntents` using ε-greedy policy.
   * Pass `training=false` during evaluation to always be greedy.
   */
  selectIntent(
    legalIntents: Intent[],
    view: MatchView,
    playerId: string,
    training = true,
  ): Intent {
    if (training && Math.random() < this.epsilon) {
      // Explore: random legal intent
      return legalIntents[Math.floor(Math.random() * legalIntents.length)]!;
    }
    // Exploit: pick the intent with the highest Q-value
    let best = legalIntents[0]!;
    let bestQ = -Infinity;
    for (const intent of legalIntents) {
      const q = this.qValue(view, playerId, intent.type);
      if (q > bestQ) { bestQ = q; best = intent; }
    }
    return best;
  }

  /** Q-learning weight update from one (s, a, r, s') transition. */
  update(t: Transition): void {
    const phi = intentFeatures(
      // We already have the full feature vector in the transition
      { players: [], units: [], cities: [], map: null } as unknown as MatchView,
      "",
      t.intentType,
    );
    // Use pre-computed features from the transition
    const currentQ = dot(this.w, t.features);

    let targetQ: number;
    if (t.nextFeatures === null) {
      // Terminal state — no future reward
      targetQ = t.reward;
    } else {
      // Bootstrap: r + γ * max_a' Q(s', a')
      const maxNextQ = t.nextLegalTypes.length > 0
        ? Math.max(...t.nextLegalTypes.map((type) =>
            dot(this.w, intentFeatures(
              { players: [], units: [], cities: [], map: null } as unknown as MatchView,
              "",
              type,
            )),
          ))
        : 0;
      targetQ = t.reward + this.config.gamma * maxNextQ;
    }

    const error = targetQ - currentQ;
    for (let i = 0; i < this.w.length; i++) {
      this.w[i]! += this.config.lr * error * t.features[i]!;
    }
    this.totalUpdates++;
  }

  /** Call at the end of each episode to decay exploration. */
  endEpisode(totalReward: number): void {
    this.episodeRewards.push(totalReward);
    this.epsilon = Math.max(this.config.epsilonMin, this.epsilon * this.config.epsilonDecay);
  }

  /**
   * Build a Brain function that uses this agent.
   * `training=true` uses ε-greedy; `training=false` is fully greedy.
   */
  toBrain(content: ContentPack, training = true): (view: MatchView, playerId: string) => Intent | null {
    return (view: MatchView, playerId: string): Intent | null => {
      const legal = getLegalIntents(view, playerId, content);
      if (legal.length === 0) return null;
      return this.selectIntent(legal, view, playerId, training);
    };
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify({ w: this.w, epsilon: this.epsilon, totalUpdates: this.totalUpdates }));
  }

  load(path: string): void {
    const data = JSON.parse(readFileSync(path, "utf8")) as { w: number[]; epsilon: number; totalUpdates: number };
    this.w = data.w;
    this.epsilon = data.epsilon;
    this.totalUpdates = data.totalUpdates;
  }

  stats(): string {
    const n = this.episodeRewards.length;
    if (n === 0) return "no episodes yet";
    const last10 = this.episodeRewards.slice(-10);
    const avg = last10.reduce((a, b) => a + b, 0) / last10.length;
    return `episodes=${n} ε=${this.epsilon.toFixed(3)} avg_reward(last10)=${avg.toFixed(2)} updates=${this.totalUpdates}`;
  }
}

/** Build a transition from a (view, intent) pair + the next view. */
export function makeTransition(
  prevView: MatchView,
  playerId: string,
  intent: Intent,
  reward: number,
  nextView: MatchView | null,
  content: ContentPack,
): Transition {
  const features = intentFeatures(prevView, playerId, intent.type);
  const nextFeatures = nextView
    ? intentFeatures(nextView, playerId, "EndTurn") // use state features with a dummy action type
    : null;
  const nextLegalTypes = nextView
    ? [...new Set(getLegalIntents(nextView, playerId, content).map((i) => i.type))]
    : [];
  return { features, intentType: intent.type, reward, nextFeatures, nextLegalTypes };
}
