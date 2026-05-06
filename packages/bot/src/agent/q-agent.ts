import { readFileSync, writeFileSync } from "node:fs";
import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import { intentFeatures, actionCategoryFeatures, extractFeatures } from "./features.js";
import { MLP } from "./mlp.js";
import type { MLPWeights } from "./mlp.js";
import type { RewardFn } from "./reward.js";

export interface QAgentConfig {
  epsilon: number;
  epsilonDecay: number;
  epsilonMin: number;
  gamma: number;
  lr: number;
  rewardFn: RewardFn;
}

export const DEFAULT_CONFIG: QAgentConfig = {
  epsilon: 1.0,
  epsilonDecay: 0.995,
  epsilonMin: 0.05,
  gamma: 0.95,
  lr: 0.001,  // lower default for neural net stability
  rewardFn: () => 0,
};

interface Transition {
  features: number[];              // φ(s, a) = [state_features | action_one_hot]
  intentType: string;
  reward: number;
  nextStateFeatures: number[] | null;  // extractFeatures(nextView) — null if terminal
  nextLegalTypes: string[];
}

/**
 * Deep Q-learning agent backed by a small MLP.
 *
 * Q(s, a) ≈ MLP([state_features | action_type_one_hot])
 *
 * The network (15→64→32→1) learns non-linear interactions between state
 * features and action type, which the previous linear model could not express.
 *
 * Max-Q bootstrap uses actual next-state features for each legal action type,
 * fixing the stale-empty-view bug in the prior linear implementation.
 */
export class QAgent {
  private net: MLP;
  config: QAgentConfig;
  epsilon: number;
  totalUpdates = 0;
  episodeRewards: number[] = [];

  constructor(config: Partial<QAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilon;
    this.net = new MLP();
  }

  qValue(view: MatchView, playerId: string, intentType: string): number {
    const { q } = this.net.forward(intentFeatures(view, playerId, intentType));
    return q;
  }

  selectIntent(
    legalIntents: Intent[],
    view: MatchView,
    playerId: string,
    training = true,
  ): Intent {
    if (training && Math.random() < this.epsilon) {
      return legalIntents[Math.floor(Math.random() * legalIntents.length)]!;
    }
    let best = legalIntents[0]!;
    let bestQ = -Infinity;
    for (const intent of legalIntents) {
      const q = this.qValue(view, playerId, intent.type);
      if (q > bestQ) { bestQ = q; best = intent; }
    }
    return best;
  }

  update(t: Transition): void {
    const { q: currentQ, cache } = this.net.forward(t.features);

    let targetQ: number;
    if (t.nextStateFeatures === null) {
      targetQ = t.reward;
    } else {
      // Bootstrap: r + γ * max_a' Q(s', a')
      // Use actual next-state features for each legal action type.
      const maxNextQ = t.nextLegalTypes.length > 0
        ? Math.max(...t.nextLegalTypes.map((type) => {
            const nextPhi = [...t.nextStateFeatures!, ...actionCategoryFeatures(type)];
            const { q } = this.net.forward(nextPhi);
            return q;
          }))
        : 0;
      targetQ = t.reward + this.config.gamma * maxNextQ;
    }

    const error = targetQ - currentQ;
    this.net.tdUpdate(cache, error, this.config.lr);
    this.totalUpdates++;
  }

  endEpisode(totalReward: number): void {
    this.episodeRewards.push(totalReward);
    this.epsilon = Math.max(this.config.epsilonMin, this.epsilon * this.config.epsilonDecay);
  }

  toBrain(content: ContentPack, training = true): (view: MatchView, playerId: string) => Intent | null {
    return (view: MatchView, playerId: string): Intent | null => {
      const legal = getLegalIntents(view, playerId, content);
      if (legal.length === 0) return null;
      return this.selectIntent(legal, view, playerId, training);
    };
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify({
      net: this.net.toJSON(),
      epsilon: this.epsilon,
      totalUpdates: this.totalUpdates,
    }));
  }

  load(path: string): void {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      net: MLPWeights;
      epsilon: number;
      totalUpdates: number;
    };
    this.net = MLP.fromJSON(data.net);
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

/** Build a Transition from a (view, intent, reward, nextView) tuple. */
export function makeTransition(
  prevView: MatchView,
  playerId: string,
  intent: Intent,
  reward: number,
  nextView: MatchView | null,
  content: ContentPack,
): Transition {
  const features = intentFeatures(prevView, playerId, intent.type);
  const nextStateFeatures = nextView ? extractFeatures(nextView, playerId) : null;
  const nextLegalTypes = nextView
    ? [...new Set(getLegalIntents(nextView, playerId, content).map((i) => i.type))]
    : [];
  return { features, intentType: intent.type, reward, nextStateFeatures, nextLegalTypes };
}
