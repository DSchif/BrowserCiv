import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContentPack, Intent, MatchView } from "@browserciv/shared";
import { getLegalIntents } from "@browserciv/shared";
import { intentFeatures, actionCategoryFeatures, extractFeatures, TOTAL_FEATURE_SIZE } from "./features.js";
import { MLP, type LayerCache, type MLPWeights } from "./mlp.js";
import type { RewardFn } from "./reward.js";

export interface QAgentConfig {
  epsilon: number;
  epsilonDecay: number;
  epsilonMin: number;
  gamma: number;
  lr: number;
  rewardFn: RewardFn;
}

export interface EpisodeRecord {
  episode: number;
  reward: number;
  steps: number;
  turns: number;
  winner: string | null | undefined;
  epsilon: number;
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
  private hidden: number[];
  config: QAgentConfig;
  epsilon: number;
  totalUpdates = 0;
  episodeHistory: EpisodeRecord[] = [];

  constructor(config: Partial<QAgentConfig> = {}, hidden: number[] = [64, 32]) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.epsilon;
    this.hidden = hidden;
    this.net = new MLP(TOTAL_FEATURE_SIZE, hidden);
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
    this.net.tdUpdate(cache as LayerCache[], error, this.config.lr);
    this.totalUpdates++;
  }

  endEpisode(
    totalReward: number,
    meta: { steps?: number; turns?: number; winner?: string | null } = {},
  ): void {
    this.epsilon = Math.max(this.config.epsilonMin, this.epsilon * this.config.epsilonDecay);
    this.episodeHistory.push({
      episode: this.episodeHistory.length + 1,
      reward: totalReward,
      steps: meta.steps ?? 0,
      turns: meta.turns ?? 0,
      winner: meta.winner,
      epsilon: this.epsilon,
    });
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
      episodeHistory: this.episodeHistory,
    }));
  }

  load(path: string): void {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      net?: MLPWeights;
      epsilon?: number;
      totalUpdates?: number;
      episodeHistory?: EpisodeRecord[];
    };

    if (!data.net?.layers) {
      console.log("[QAgent] old agent format — starting fresh");
      return;
    }

    if (data.net.layers[0]?.inSize !== TOTAL_FEATURE_SIZE) {
      console.warn(
        `[QAgent] feature size mismatch: saved=${data.net.layers[0]?.inSize} expected=${TOTAL_FEATURE_SIZE} — starting fresh`,
      );
      return;
    }

    const savedHidden = data.net.layers.slice(0, -1).map((l) => l.outSize);
    if (
      savedHidden.length !== this.hidden.length ||
      savedHidden.some((v, i) => v !== this.hidden[i])
    ) {
      console.warn(
        `[QAgent] hidden layer mismatch: saved=[${savedHidden.join(",")}] expected=[${this.hidden.join(",")}] — starting fresh`,
      );
      return;
    }

    this.net = MLP.fromJSON(data.net);
    this.epsilon = data.epsilon ?? this.epsilon;
    this.totalUpdates = data.totalUpdates ?? 0;
    this.episodeHistory = data.episodeHistory ?? [];
  }

  stats(): string {
    const n = this.episodeHistory.length;
    if (n === 0) return "no episodes yet";
    const last10 = this.episodeHistory.slice(-10).map((e) => e.reward);
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
